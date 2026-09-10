import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { query } from "$lib/db";
import {
  searchEnrichment,
  upsertAiData,
  upsertWikiOk,
} from "$server/species-enrichment";
import { guideLocationCoverage } from "$server/guide-location";
import { load } from "./+page.server";
import { countriesList } from "$server/regions";

const dbUp = await query("SELECT 1")
  .then(() => true)
  .catch(() => false);
const A = "glocqa1",
  B = "glocqa2",
  C = "glocqa3";
const HERE = "L99887101",
  THERE = "L99887102";
const distractors = Array.from({ length: 55 }, (_, i) => `glocnoise${i}`);
const codes = [A, B, C, ...distractors];

function event(path: string, scopeId: number) {
  return {
    locals: { scopeId, user: { id: scopeId } },
    depends: () => {},
    url: new URL(`http://localhost${path}`),
  } as Parameters<typeof load>[0];
}

describe.runIf(dbUp)("Field Guide location and thumbnail integration", () => {
  let uid: number;
  beforeAll(async () => {
    uid = (
      await query<{ id: number }>(
        "SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1",
      )
    ).rows[0].id;
    for (const code of codes) {
      await query(
        `INSERT INTO taxonomy_cache (species_code,com_name,sci_name,category)
			 VALUES ($1,$2,$3,'species')`,
        [
          code,
          `${distractors.includes(code) ? "Aardvark" : "Zebra"} Guidelocation ${code}`,
          `Testus ${code}`,
        ],
      );
    }
    for (const code of [B, C]) {
      await upsertWikiOk(code, {
        title: code,
        revId: 1,
        extract: "Guidelocation bird probing mudflats.",
        sections: [],
      });
      await upsertAiData(code, {
        fieldCraft: "Probe mudflats.",
        tags: ["forage:probing-shorebird", "habitat:mudflat"],
        model: "test",
        sourceRevId: 1,
      });
    }
    for (const [loc, region] of [
      [HERE, "US-FL"],
      [THERE, "US-TX"],
    ]) {
      await query(
        `INSERT INTO frequency_fetch
			 (loc_code,loc_kind,loc_name,begin_year,end_year,sample_sizes,n_species,region_code)
			 VALUES ($1,'hotspot','Location test fixture',2016,2025,$2,3,$3)`,
        [loc, Array(48).fill(10), region],
      );
    }
    await query(
      `INSERT INTO species_month_freq (loc_code,species_code,month,num)
		 VALUES ($1,$3,1,2),($1,$3,2,3),($1,$4,12,2),($1,$5,6,0),($2,$5,6,2)`,
      [HERE, THERE, A, B, C],
    );
    await query(
      `INSERT INTO species_media
		 (species_code,kind,rank,provider,provider_id,media_url,thumbnail_url,source_url,creator,license_code,license_url)
		 VALUES ($1,'photo',1,'wikimedia_commons','guide-test','https://example.org/original.jpg',
		 'https://example.org/thumb.jpg','https://example.org/source','Test photographer','CC BY 4.0','https://example.org/license')`,
      [B],
    );
  });
  afterAll(async () => {
    await query("DELETE FROM species_media WHERE species_code=ANY($1)", [
      codes,
    ]);
    await query("DELETE FROM frequency_fetch WHERE loc_code=ANY($1)", [
      [HERE, THERE],
    ]);
    await query("DELETE FROM species_enrichment WHERE species_code=ANY($1)", [
      codes,
    ]);
    await query("DELETE FROM taxonomy_cache WHERE species_code=ANY($1)", [
      codes,
    ]);
  });

  it("location alone includes unenriched birds and winter-only reports, once each; zero is not presence", async () => {
    const rows = await searchEnrichment("", [], uid, [HERE]);
    expect(rows.map((r) => r.species_code).sort()).toEqual([A, B]);
    expect(rows.find((r) => r.species_code === A)?.photo).toBeNull();
    expect(rows.find((r) => r.species_code === B)?.photo).toEqual({
      url: "https://example.org/thumb.jpg",
      creator: "Test photographer",
      sourceUrl: "https://example.org/source",
      licenseCode: "CC BY 4.0",
      licenseUrl: "https://example.org/license",
    });
  });
  it("location applies before the limit and intersects both text and every tag", async () => {
    const rows = await searchEnrichment("Guidelocation", [], uid, [HERE]);
    expect(rows.map((r) => r.species_code).sort()).toEqual([A, B]);
    const tagged = await searchEnrichment(
      "Guidelocation",
      ["forage:probing-shorebird", "habitat:mudflat"],
      uid,
      [HERE],
    );
    expect(tagged.map((r) => r.species_code)).toEqual([B]);
    expect(await searchEnrichment(C, [], uid, [HERE])).toEqual([]);
    expect(
      await searchEnrichment("Guidelocation", ["habitat:alpine-meadow"], uid, [
        HERE,
      ]),
    ).toEqual([]);
  });
  it("no loaded sources yields no matches, while Anywhere retains the worldwide search", async () => {
    expect(await searchEnrichment(B, [], uid, [])).toEqual([]);
    expect(
      (await searchEnrichment(C, [], uid)).map((r) => r.species_code),
    ).toEqual([C]);
  });
  it("includes child hotspot evidence even if statewide coverage exists, without crossing state boundaries", async () => {
    const florida = await guideLocationCoverage("US-FL");
    expect(florida.locCodes).toContain(HERE);
    expect(florida.locCodes).not.toContain(THERE);
    const country = await guideLocationCoverage("US");
    expect(country.locCodes).toEqual(expect.arrayContaining([HERE, THERE]));
    const missing = await guideLocationCoverage("ZZ-NO");
    expect(missing).toEqual({
      locCodes: [],
      wholeArea: false,
      beginYear: null,
      endYear: null,
    });
  });
  it("validates country/region identity and preserves location-only state in the route", async () => {
    const data = (await load(
      event(`/species?q=${B}&region=us-fl&tags=habitat%3Amudflat`, uid),
    )) as any;
    expect(data.country).toBe("US");
    const countries = await countriesList();
    expect(data.countries.map((c: { code: string }) => c.code)).toEqual([
      "US",
      ...countries.filter((c) => c.code !== "US").map((c) => c.code),
    ]);
    expect(data.region).toBe("US-FL");
    expect(data.location.label).toBe("Florida, United States");
    expect(
      data.results.map((r: { species_code: string }) => r.species_code),
    ).toEqual([B]);
    for (const path of [
      "/species?country=invalid",
      "/species?region=US-ZZ",
      "/species?country=CA&region=US-FL",
    ]) {
      await expect(load(event(path, uid))).rejects.toMatchObject({
        status: 400,
      });
    }
  });
});
