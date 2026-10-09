import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  parseEbirdDate,
  parseLifeListCsv,
  importLifeList,
  mayBeSpeciesLevel,
  partialImportNote,
  lifeListOrphans,
} from "./ebird-account";
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
  const CODES = ["gubter2", "rebnut", "egygoo"];

  it("details land; manual rows keep source + first_seen but gain details; re-import replaces", async () => {
    // Never borrow the first real account in the restored test database:
    // cleanup would delete genuine life-list rows for these real species.
    const uid = (
      await query<{ id: number }>(
        `INSERT INTO users (username, display_name, password_hash, role)
         VALUES ($1, 'Life-list import QA', '!unset', 'user') RETURNING id`,
        [`lifelist-import-${randomUUID()}`],
      )
    ).rows[0].id;
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
      await query(`DELETE FROM users WHERE id = $1`, [uid]);
    }
  });
});

describe("split survival: which unmatched names mean taxonomy drift (td-b52a90)", () => {
  it("export Category decides; non-species categories never count", () => {
    for (const category of ["species", "Species"])
      expect(mayBeSpeciesLevel({ comName: "Anything", category })).toBe(true);
    for (const category of ["issf", "form", "spuh", "slash", "hybrid", "intergrade", "domestic"])
      expect(mayBeSpeciesLevel({ comName: "Anything", category })).toBe(false);
  });
  it("no Category column: eBird naming conventions (names seen unmatched on prod 2026-10-09)", () => {
    for (const comName of [
      "Mallard x Mottled Duck (hybrid)",
      "Mallard/Mottled Duck",
      "Greater/Lesser Scaup",
      "duck sp.",
      "Accipitrine hawk sp. (former Accipiter sp.)",
      "Mallard (Domestic type)",
    ])
      expect(mayBeSpeciesLevel({ comName, category: null })).toBe(false);
    expect(mayBeSpeciesLevel({ comName: "Pacific-slope Flycatcher", category: null })).toBe(true);
  });
  it("the owner note names the misses and the kept rows, or is null", () => {
    expect(partialImportNote({ unmatchedSpecies: [], retainedNames: ["X Bird"] })).toBeNull();
    const note = partialImportNote({
      unmatchedSpecies: ["A Bird", "B Bird", "C Bird", "D Bird"],
      retainedNames: ["Old Bird"],
    })!;
    expect(note).toContain("4 species from eBird didn't match");
    expect(note).toContain("A Bird, B Bird, C Bird, …");
    expect(note).toContain("Kept from your earlier list so nothing is lost: Old Bird (1)");
    expect(note).toContain("may include a bird you've since removed on eBird");
    expect(note).toContain("Sync taxonomy");
  });
});

describe.runIf(dbUp)("split survival on import (td-b52a90, test cluster)", () => {
  const HEADER =
    "Row #,Taxon Order,Category,Common Name,Scientific Name,Count,Location,S/P,Date,LocID,SubID,Exotic,Countable";
  const row = (n: number, category: string, com: string, sci: string) =>
    `${n},1,${category},${com},${sci},1,Somewhere,US-FL,01 Jan 2020,L1,S1,,1`;

  async function fixtureUser(): Promise<number> {
    const id = (
      await query<{ id: number }>(
        `INSERT INTO users (username, display_name, password_hash, role)
         VALUES ($1, 'Split survival QA', '!unset', 'user') RETURNING id`,
        [`split-survival-${randomUUID()}`],
      )
    ).rows[0].id;
    await query("INSERT INTO user_ebird (user_id) VALUES ($1)", [id]);
    return id;
  }
  const statusOf = async (uid: number) =>
    (
      await query<{ life_list_status: string | null; life_list_error: string | null }>(
        "SELECT life_list_status, life_list_error FROM user_ebird WHERE user_id = $1",
        [uid],
      )
    ).rows[0];
  const codesOf = async (uid: number) =>
    (
      await query<{ species_code: string; source: string }>(
        "SELECT species_code, source FROM seen_species WHERE user_id = $1 ORDER BY species_code",
        [uid],
      )
    ).rows;

  it("a species-level miss (eBird renamed it, our taxonomy is behind) keeps the earlier row instead of deleting it", async () => {
    const uid = await fixtureUser();
    try {
      await importLifeList(
        uid,
        parseLifeListCsv(
          [
            HEADER,
            row(1, "species", "Gull-billed Tern", "Gelochelidon nilotica"),
            row(2, "species", "Red-breasted Nuthatch", "Sitta canadensis"),
          ].join("\n"),
        ),
        "ebird_sync",
      );
      // eBird's next export: the tern now carries a post-split name the
      // cached taxonomy doesn't know yet; a hybrid stays unmatched as usual.
      const res = await importLifeList(
        uid,
        parseLifeListCsv(
          [
            HEADER,
            row(1, "species", "Zzsplit Gull-billed Tern", "Gelochelidon zzsplitensis"),
            row(2, "species", "Red-breasted Nuthatch", "Sitta canadensis"),
            row(3, "hybrid", "Mallard x Mottled Duck (hybrid)", "Anas platyrhynchos x fulvigula"),
          ].join("\n"),
        ),
        "ebird_sync",
      );
      expect(res.matched).toBe(1);
      expect(res.unmatchedSpecies).toEqual(["Zzsplit Gull-billed Tern"]);
      expect(res.retained).toEqual(["gubter2"]);
      expect(res.retainedNames).toEqual(["Gull-billed Tern"]);
      expect(await codesOf(uid)).toEqual([
        { species_code: "gubter2", source: "ebird_sync" },
        { species_code: "rebnut", source: "ebird_sync" },
      ]);
      // Durable owner-facing state, written by the import itself.
      const st = await statusOf(uid);
      expect(st.life_list_status).toBe("partial");
      expect(st.life_list_error).toContain("Gull-billed Tern");
    } finally {
      await query(`DELETE FROM users WHERE id = $1`, [uid]);
    }
  });

  it("only non-species misses (the permanent hybrids/slashes) still prune a lifer eBird no longer lists", async () => {
    const uid = await fixtureUser();
    try {
      await importLifeList(
        uid,
        parseLifeListCsv(
          [
            HEADER,
            row(1, "species", "Gull-billed Tern", "Gelochelidon nilotica"),
            row(2, "species", "Red-breasted Nuthatch", "Sitta canadensis"),
          ].join("\n"),
        ),
        "ebird_sync",
      );
      const res = await importLifeList(
        uid,
        parseLifeListCsv(
          [
            HEADER,
            row(1, "species", "Red-breasted Nuthatch", "Sitta canadensis"),
            row(2, "slash", "Greater/Lesser Scaup", "Aythya marila/affinis"),
          ].join("\n"),
        ),
        "ebird_sync",
      );
      expect(res.unmatched).toEqual(["Greater/Lesser Scaup"]);
      expect(res.unmatchedSpecies).toEqual([]);
      expect(res.retained).toEqual([]);
      expect(partialImportNote(res)).toBeNull();
      expect(await codesOf(uid)).toEqual([{ species_code: "rebnut", source: "ebird_sync" }]);
      expect(await statusOf(uid)).toEqual({ life_list_status: "ok", life_list_error: null });
    } finally {
      await query(`DELETE FROM users WHERE id = $1`, [uid]);
    }
  });

  it("the trade-off, disclosed: while a species-level name misses, a lifer removed on eBird is kept too, and a CSV import's partial state persists until a complete import", async () => {
    const uid = await fixtureUser();
    try {
      await importLifeList(
        uid,
        parseLifeListCsv(
          [
            HEADER,
            row(1, "species", "Gull-billed Tern", "Gelochelidon nilotica"),
            row(2, "species", "Red-breasted Nuthatch", "Sitta canadensis"),
            row(3, "species", "Egyptian Goose", "Alopochen aegyptiaca"),
          ].join("\n"),
        ),
        "csv_import",
      );
      // The goose was removed on eBird; the tern was renamed upstream.
      const partial = await importLifeList(
        uid,
        parseLifeListCsv(
          [
            HEADER,
            row(1, "species", "Zzsplit Gull-billed Tern", "Gelochelidon zzsplitensis"),
            row(2, "species", "Red-breasted Nuthatch", "Sitta canadensis"),
          ].join("\n"),
        ),
        "csv_import",
      );
      expect(partial.retained).toEqual(["egygoo", "gubter2"]);
      expect((await statusOf(uid)).life_list_status).toBe("partial");
      // CSV only, never an eBird sync: no timestamp, but the state is durable.
      expect(
        (await query("SELECT life_list_synced_at FROM user_ebird WHERE user_id = $1", [uid])).rows[0]
          .life_list_synced_at,
      ).toBeNull();
      expect((await statusOf(uid)).life_list_error).toContain("Egyptian Goose");
      expect((await statusOf(uid)).life_list_error).toContain("removed on eBird");
      // Taxonomy caught up: the export now matches completely → the goose prunes.
      const complete = await importLifeList(
        uid,
        parseLifeListCsv(
          [
            HEADER,
            row(1, "species", "Gull-billed Tern", "Gelochelidon nilotica"),
            row(2, "species", "Red-breasted Nuthatch", "Sitta canadensis"),
          ].join("\n"),
        ),
        "csv_import",
      );
      expect(complete.retained).toEqual([]);
      expect((await codesOf(uid)).map((r) => r.species_code)).toEqual(["gubter2", "rebnut"]);
      expect(await statusOf(uid)).toEqual({ life_list_status: "ok", life_list_error: null });
    } finally {
      await query(`DELETE FROM users WHERE id = $1`, [uid]);
    }
  });

  it("the orphan audit counts a life-list code the taxonomy no longer has", async () => {
    const uid = await fixtureUser();
    try {
      const before = await lifeListOrphans();
      await query(
        `INSERT INTO seen_species (user_id, species_code, source) VALUES ($1, 'zzretired1', 'ebird_sync')`,
        [uid],
      );
      const after = await lifeListOrphans();
      expect(after.rows).toBe(before.rows + 1);
      expect(after.users).toBe(before.users + 1);
    } finally {
      await query(`DELETE FROM users WHERE id = $1`, [uid]);
    }
  });
});

describe("incomplete status renders without an eBird sync timestamp (td-b52a90, CODEX1)", () => {
  // A first CSV import can be 'partial' with life_list_synced_at NULL; the
  // badge must not live inside the timestamp branch on Settings or Home.
  const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
  it("Settings shows the partial note outside the last-sync block", () => {
    const src = read("../../routes/settings/+page.svelte");
    const syncBlock = src.slice(
      src.indexOf("{#if data.ebird.life_list_synced_at}"),
      src.indexOf("Never synced from eBird."),
    );
    expect(syncBlock).not.toContain('"partial"');
    expect(src).toContain('{#if data.ebird.life_list_status === "partial"}');
  });
  it("Home shows the sync-incomplete badge outside the synced-date branch", () => {
    const src = read("../../routes/+page.svelte");
    const branch = src.slice(src.indexOf("{#if data.lifeListSyncedAt}"), src.indexOf('<a href="/settings">not synced</a>'));
    expect(branch).not.toContain('"partial"');
    expect(src).toContain('{#if data.lifeListStatus === "partial" && !isViewer}');
  });
});
