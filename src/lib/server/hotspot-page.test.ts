import { describe, expect, it } from "vitest";
import { query } from "$lib/db";
import {
	groupRecent,
  hotspotFromCache,
  hotspotMonthly,
  hotspotPlace,
  regionNames,
  validLocId,
} from "./hotspot-page";

const dbUp = await query("SELECT 1")
  .then(() => true)
  .catch(() => false);

describe("validLocId", () => {
  it("accepts L+digits only — malformed ids 404, never 500 (GROK pin)", () => {
    expect(validLocId("L123456")).toBe(true);
    expect(validLocId("L1")).toBe(true);
    for (const bad of ["", "123", "Labc", "L123x", "l123", "L123; DROP", "L123 "])
      expect(validLocId(bad), bad).toBe(false);
  });
});

describe.runIf(dbUp)("hotspot-page gateway (test cluster)", () => {
  const KEY = "hotspots:0.00:0.00:1"; // synthetic cache row, wiped per test
  const LOC = "L999999901";

  async function seedCache() {
    await query(
      `INSERT INTO ebird_cache (cache_key, payload, fetched_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (cache_key) DO UPDATE SET payload = $2, fetched_at = NOW()`,
      [
        KEY,
        JSON.stringify([
          {
            locId: LOC,
            locName: "Test Flats Park",
            lat: 27.5,
            lng: -82.7,
            subnational1Code: "US-FL",
            subnational2Code: "US-FL-103",
            numSpeciesAllTime: 217,
            latestObsDt: "2026-08-18 07:55",
          },
        ]),
      ],
    );
  }
  const wipe = async () => {
    await query(`DELETE FROM ebird_cache WHERE cache_key = $1`, [KEY]);
    await query(`DELETE FROM ebird_locations WHERE loc_id = $1`, [LOC]);
  };

  it("hotspotFromCache resolves a locId from raw cached payloads", async () => {
    await seedCache();
    try {
      const meta = await hotspotFromCache(LOC);
      expect(meta).toMatchObject({
        locId: LOC,
        locName: "Test Flats Park",
        countyCode: "US-FL-103",
        stateCode: "US-FL",
        numSpeciesAllTime: 217,
        isHotspot: true,
      });
      expect(await hotspotFromCache("L999999999")).toBeNull();
    } finally {
      await wipe();
    }
  });

  it("hotspotPlace gates venue chips on matched status + confidence (GROK pin)", async () => {
    await wipe();
    await query(
      `INSERT INTO ebird_locations
         (loc_id, loc_name, lat, lng, google_place_id, google_place_name,
          google_place_types, google_place_confidence, google_place_status)
       VALUES ($1, 'Test Flats Park', 27.5, -82.7, 'gp1', 'Test Flats County Park',
               ARRAY['park','establishment','point_of_interest'], 0.9, 'matched')`,
      [LOC],
    );
    try {
      let p = await hotspotPlace(LOC);
      expect(p.venueTypes).toEqual(["park"]); // generic types dropped
      expect(p.googlePlaceId).toBe("gp1");

      // Low confidence → chips suppressed (never junk), but the place id
      // stays: a weak match still beats raw coords as a Maps pin (GROK).
      await query(
        `UPDATE ebird_locations SET google_place_confidence = 0.3 WHERE loc_id = $1`,
        [LOC],
      );
      p = await hotspotPlace(LOC);
      expect(p.venueTypes).toEqual([]);
      expect(p.googlePlaceId).toBe("gp1");
      expect(p.locName).toBe("Test Flats Park"); // name still usable

      // Unmatched → nothing, regardless of confidence.
      await query(
        `UPDATE ebird_locations SET google_place_status = 'no_match' WHERE loc_id = $1`,
        [LOC],
      );
      p = await hotspotPlace(LOC);
      expect(p.venueTypes).toEqual([]);
      expect(p.googlePlaceId).toBeNull();
    } finally {
      await wipe();
    }
  });

  it("hotspotMonthly: needs-first month list + year strip from stored weeks", async () => {
    const CODE_NEED = "hptst1";
    const CODE_SEEN = "hptst2";
    const uid = (
      await query<{ id: number }>(`SELECT id FROM users ORDER BY id LIMIT 1`)
    ).rows[0].id;
    await query(
      `INSERT INTO taxonomy_cache (species_code, com_name, sci_name, category, family)
       VALUES ($1,'Testneed Warbler','T n','species','X'), ($2,'Testseen Wren','T s','species','X')
       ON CONFLICT (species_code) DO UPDATE SET category='species'`,
      [CODE_NEED, CODE_SEEN],
    );
    // species_frequency FKs to frequency_fetch — seed the parent row.
    await query(
      `INSERT INTO frequency_fetch
         (loc_code, loc_kind, loc_name, begin_year, end_year, sample_sizes, n_species, n_unmatched, unmatched_names)
       VALUES ($1, 'hotspot', 'Test Flats Park', 2016, 2025,
               (SELECT array_agg(20) FROM generate_series(1,48)), 2, 0, '{}')
       ON CONFLICT (loc_code) DO NOTHING`,
      [LOC],
    );
    // June = weeks 21-24; give both species freq there.
    for (const [code, f] of [
      [CODE_NEED, 0.4],
      [CODE_SEEN, 0.1],
    ] as const) {
      for (let w = 21; w <= 24; w++) {
        await query(
          `INSERT INTO species_frequency (loc_code, species_code, week, freq)
           VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
          [LOC, code, w, f],
        );
      }
    }
    const seen = new Set([CODE_SEEN]);
    const sampleSizes = Array.from({ length: 48 }, () => 20);
    try {
      const m = await hotspotMonthly(LOC, 6, seen, sampleSizes);
      expect(m.species.map((s) => s.speciesCode)).toEqual([CODE_NEED, CODE_SEEN]); // needs first
      expect(m.species[0]).toMatchObject({ need: true, band: "likely", lowSample: false });
      expect(m.species[1]).toMatchObject({ need: false, band: "possible" });
      // Year strip counts NEEDS only: June has 1 likely need, other months 0.
      expect(m.year[5]).toMatchObject({ month: 6, likely: 1 });
      expect(m.year[0]).toMatchObject({ month: 1, likely: 0, possible: 0 });
    } finally {
      await query(`DELETE FROM species_frequency WHERE loc_code = $1`, [LOC]);
      await query(`DELETE FROM frequency_fetch WHERE loc_code = $1`, [LOC]);
      await query(`DELETE FROM taxonomy_cache WHERE species_code IN ($1,$2)`, [
        CODE_NEED,
        CODE_SEEN,
      ]);
    }
  });

  it("regionNames resolves from cached subregion lists", async () => {
    const RKEY = "regions:subnational2:US-ZZ";
    await query(
      `INSERT INTO ebird_cache (cache_key, payload, fetched_at)
       VALUES ($1, $2, NOW()) ON CONFLICT (cache_key) DO UPDATE SET payload = $2`,
      [RKEY, JSON.stringify([{ code: "US-ZZ-001", name: "Testville County" }])],
    );
    try {
      const names = await regionNames(["US-ZZ-001", "US-XX-999"]);
      expect(names.get("US-ZZ-001")).toBe("Testville County");
      expect(names.has("US-XX-999")).toBe(false);
    } finally {
      await query(`DELETE FROM ebird_cache WHERE cache_key = $1`, [RKEY]);
    }
  });
});

describe("groupRecent (latest-report-per-species semantics)", () => {
	// eBird's /data/obs/{locId}/recent returns ONLY the latest observation of
	// each species. This fixture mirrors that contract: two checklists (S1,
	// S2) each really had both species, but the feed carries species A only
	// from S2 (its latest) and species B only from S1. The display contract
	// this locks: one row per species linking to its own checklist — rows are
	// NEVER presented as checklist contents (CODEX1 blocker on 84a1c4b).
	const obs = [
		{
			speciesCode: "amecro",
			comName: "American Crow",
			obsDt: "2026-08-18 09:15",
			subId: "S2",
			howMany: 3,
			obsValid: true,
			obsReviewed: true,
		},
		{
			speciesCode: "blujay",
			comName: "Blue Jay",
			obsDt: "2026-08-17 07:30",
			subId: "S1",
			howMany: 1,
			obsValid: false,
			obsReviewed: false,
		},
		{
			speciesCode: "norcar",
			comName: "Northern Cardinal",
			obsDt: "2026-08-17 06:00",
			subId: null,
			howMany: null,
			obsValid: true,
			obsReviewed: true,
		},
	// The loose fixture shape is intentional (subId/howMany nullable).
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	] as any[];

	it("emits exactly one row per species, each tied to its own checklist", () => {
		const days = groupRecent(obs, new Set(["amecro"]));
		const all = days.flatMap((d) => d.reports);
		expect(all).toHaveLength(3);
		expect(new Set(all.map((r) => r.speciesCode)).size).toBe(3);
		// No structure groups species under a shared checklist: each row
		// carries its OWN subId (or null), so nothing can read as "checklist
		// S2 contained N species".
		expect(all.find((r) => r.speciesCode === "amecro")?.subId).toBe("S2");
		expect(all.find((r) => r.speciesCode === "blujay")?.subId).toBe("S1");
		expect(all.find((r) => r.speciesCode === "norcar")?.subId).toBeNull();
	});

	it("groups by day, newest first, needs before seen within a day", () => {
		const days = groupRecent(obs, new Set(["amecro"]));
		expect(days.map((d) => d.date)).toEqual(["2026-08-18", "2026-08-17"]);
		// 08-17 holds blujay (need) and norcar (need) — flip norcar to seen:
		const days2 = groupRecent(obs, new Set(["amecro", "norcar"]));
		expect(days2[1].reports.map((r) => r.speciesCode)).toEqual(["blujay", "norcar"]);
		expect(days2[1].reports.map((r) => r.need)).toEqual([true, false]);
	});

	it("maps seen/need and unconfirmed truthfully", () => {
		const days = groupRecent(obs, new Set(["amecro"]));
		const all = days.flatMap((d) => d.reports);
		expect(all.find((r) => r.speciesCode === "amecro")).toMatchObject({
			need: false,
			unconfirmed: false,
			howMany: 3,
			time: "09:15",
		});
		expect(all.find((r) => r.speciesCode === "blujay")).toMatchObject({
			need: true,
			unconfirmed: true,
		});
	});
});
