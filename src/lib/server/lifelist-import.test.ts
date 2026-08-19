import { describe, expect, it } from "vitest";
import { parseEbirdDate, parseLifeListCsv, importLifeList } from "./ebird-account";
import { query } from "$lib/db";

// DB-backed cases run only when the test cluster is up (jobs-db pattern).
const dbUp = await query("SELECT 1")
  .then(() => true)
  .catch(() => false);

describe("parseEbirdDate — calendar dates, no UTC round-trip (GROK pin 3)", () => {
  it("live-export style 'D Mon YYYY'", () => {
    expect(parseEbirdDate("19 Aug 2026")).toBe("2026-08-19");
    expect(parseEbirdDate("2 Aug 2026")).toBe("2026-08-02");
    expect(parseEbirdDate("02 August 2026")).toBe("2026-08-02");
  });
  it("ISO passthrough and garbage", () => {
    expect(parseEbirdDate("2023-05-01")).toBe("2023-05-01");
    expect(parseEbirdDate("")).toBeNull();
    expect(parseEbirdDate("not a date")).toBeNull();
  });
});

/** The verified live 13-column header (2026-08-19 authenticated export). */
const LIVE_CSV = [
  "Row #,Taxon Order,Category,Common Name,Scientific Name,Count,Location,S/P,Date,LocID,SubID,Exotic,Countable",
  '1,6710,species,Gull-billed Tern,Gelochelidon nilotica,1,"Big Talbot Island SP--Spoonbill Pond (includes parking & boat ramp)",US-FL,19 Aug 2026,L1125706,S384983878,,1',
  "2,26937,species,Red-breasted Nuthatch,Sitta canadensis,X,Peter Brook Trail Preserve (BHHT),US-ME,02 Aug 2026,L4376237,S379350518,,1",
  '3,2280,species,Egyptian Goose,Alopochen aegyptiaca,2,"Backyard, private",US-FL,10 Jan 2020,L9999991,S123456789,X,0',
].join("\n");

describe("parseLifeListCsv — live 13-column export (td-b5986c)", () => {
  it("captures every detail column; quoted commas; X counts → null", () => {
    const { rows } = parseLifeListCsv(LIVE_CSV);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({
      comName: "Gull-billed Tern",
      sciName: "Gelochelidon nilotica",
      firstSeen: "2026-08-19",
      csvRowNum: 1,
      taxonOrder: "6710",
      category: "species",
      obsCount: 1,
      locationName: "Big Talbot Island SP--Spoonbill Pond (includes parking & boat ramp)",
      locId: "L1125706",
      regionCode: "US-FL",
      subId: "S384983878",
      exotic: null,
      countable: true,
    });
    expect(rows[1].obsCount).toBeNull(); // Count "X"
    expect(rows[2].locationName).toBe("Backyard, private"); // quoted comma
    expect(rows[2].exotic).toBe("X");
    expect(rows[2].countable).toBe(false);
  });

  it("legacy minimal export still parses (details null)", () => {
    const { rows } = parseLifeListCsv(
      ["Species,Date", "Marbled Godwit - Limosa fedoa,2023-05-01"].join("\n"),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].comName).toBe("Marbled Godwit");
    expect(rows[0].sciName).toBe("Limosa fedoa");
    expect(rows[0].firstSeen).toBe("2023-05-01");
    expect(rows[0].locId).toBeNull();
    expect(rows[0].csvRowNum).toBeNull();
    expect(rows[0].countable).toBeNull();
  });
});

describe.runIf(dbUp)("importLifeList detail columns (test cluster)", () => {
  const UID_SQL = `SELECT id FROM users ORDER BY id LIMIT 1`;
  const CODES = ["gubter2", "rebnut", "egygoo"];

  const wipe = async (uid: number) =>
    query(`DELETE FROM seen_species WHERE user_id = $1 AND species_code = ANY($2)`, [uid, CODES]);

  it("details land; manual rows keep source + first_seen but gain details; re-import replaces", async () => {
    const uid = (await query<{ id: number }>(UID_SQL)).rows[0].id;
    await wipe(uid);
    try {
      // A pre-existing MANUAL lifer for one of the CSV species.
      await query(
        `INSERT INTO seen_species (user_id, species_code, source, first_seen)
         VALUES ($1, 'gubter2', 'manual', '2019-03-03')`,
        [uid],
      );
      const parsed = parseLifeListCsv(LIVE_CSV);
      const res = await importLifeList(uid, parsed, "ebird_sync");
      expect(res.total).toBe(3);
      expect(res.matched).toBe(3);
      expect(res.unmatched).toEqual([]);

      const rows = await query<{
        species_code: string;
        source: string;
        first_seen: string | null;
        loc_id: string | null;
        region_code: string | null;
        sub_id: string | null;
        csv_row_num: number | null;
        countable: boolean | null;
        exotic: string | null;
      }>(
        `SELECT species_code, source, first_seen::text, loc_id, region_code,
                sub_id, csv_row_num, countable, exotic
           FROM seen_species WHERE user_id = $1 AND species_code = ANY($2)
          ORDER BY species_code`,
        [uid, CODES],
      );
      const byCode = new Map(rows.rows.map((r) => [r.species_code, r]));
      // Manual row: source + original first_seen preserved, details filled
      // (GROK pin 3 — must not vanish from the map, must not flip source).
      const manual = byCode.get("gubter2")!;
      expect(manual.source).toBe("manual");
      expect(manual.first_seen).toBe("2019-03-03");
      expect(manual.loc_id).toBe("L1125706");
      expect(manual.sub_id).toBe("S384983878");
      // Synced rows carry full details.
      const nut = byCode.get("rebnut")!;
      expect(nut.source).toBe("ebird_sync");
      expect(nut.region_code).toBe("US-ME");
      expect(nut.csv_row_num).toBe(2);
      const goose = byCode.get("egygoo")!;
      expect(goose.exotic).toBe("X");
      expect(goose.countable).toBe(false);

      // Re-import (idempotent replace): still 3 rows, manual still manual.
      await importLifeList(uid, parsed, "ebird_sync");
      const again = await query<{ n: string }>(
        `SELECT count(*) AS n FROM seen_species WHERE user_id = $1 AND species_code = ANY($2)`,
        [uid, CODES],
      );
      expect(Number(again.rows[0].n)).toBe(3);
    } finally {
      await wipe(uid);
    }
  });
});
