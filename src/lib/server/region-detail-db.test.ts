/**
 * td-327dd6 (CODEX1): which Hotspots & data state-hotspot rows link to the
 * Field Guide. Shared birds_test: own per-run hotspot rows only, exact
 * cleanup, no seed/reset.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { env } from "$env/dynamic/private";
import { query } from "$lib/db";
import { guidePlaceListHref, parseGuideLocation } from "$lib/guide-location";
import { regionDetail } from "./region-detail";
import { resolveGuideLocation } from "./guide-location";

const RUN = String(process.pid % 100000).padStart(5, "0");
const DIRECT = `L96${RUN}1`; // recorded exactly under US-FL, no county
const RESIDUAL = `L96${RUN}2`; // a malformed deeper code the prefix query still matches
const CODES = [DIRECT, RESIDUAL];

beforeAll(async () => {
  if (env.PGHOST !== "127.0.0.1" || env.PGPORT !== "15436" || env.PGDATABASE !== "birds_test")
    throw Error("Requires dedicated birds_test");
  const row = (code: string, name: string, region: string) =>
    query(
      `INSERT INTO frequency_fetch (loc_code, loc_kind, loc_name, begin_year, end_year, sample_sizes, n_species, region_code)
       VALUES ($1, 'hotspot', $2, 2015, 2024, array_fill(0, ARRAY[48]), 3, $3)`,
      [code, name, region],
    );
  await row(DIRECT, "Zz Direct Fixture", "US-FL");
  await row(RESIDUAL, "Zz Residual Fixture", "US-FL-115-ZZ");
});

afterAll(async () => {
  await query("DELETE FROM frequency_fetch WHERE loc_code = ANY($1::text[]) AND loc_name LIKE 'Zz % Fixture'", [CODES]);
  const left = await query<{ n: number }>("SELECT count(*)::int AS n FROM frequency_fetch WHERE loc_code = ANY($1::text[])", [CODES]);
  expect(left.rows[0].n).toBe(0);
});

describe("regionDetail state hotspots (td-327dd6)", () => {
  it("gives a Field Guide parent only to a hotspot recorded exactly under the state", async () => {
    const detail = await regionDetail("US-FL", "Florida");
    const direct = detail.stateHotspots.find((r) => r.locCode === DIRECT);
    const residual = detail.stateHotspots.find((r) => r.locCode === RESIDUAL);
    expect(direct).toMatchObject({ guideParent: "US-FL", nSpecies: 3 });
    // The residual row stays visible with its count, but gets no link.
    expect(residual).toMatchObject({ nSpecies: 3 });
    expect(residual?.guideParent).toBeUndefined();
    expect(guidePlaceListHref(RESIDUAL, residual?.guideParent ?? null)).toBeNull();
  });

  it("the direct row's link resolves in the Field Guide", async () => {
    const detail = await regionDetail("US-FL", "Florida");
    const direct = detail.stateHotspots.find((r) => r.locCode === DIRECT)!;
    const href = guidePlaceListHref(DIRECT, direct.guideParent ?? null)!;
    const parsed = parseGuideLocation(new URL(href, "http://x").searchParams);
    if (!parsed.ok) throw new Error(parsed.message);
    await expect(resolveGuideLocation(parsed.selection)).resolves.toMatchObject({
      kind: "hotspot",
      ancestry: { region: "US-FL", county: null, hotspot: DIRECT },
    });
  });

  it("a country's own hotspots never get a parent", async () => {
    const detail = await regionDetail("US", "United States");
    expect(detail.stateHotspots.every((r) => r.guideParent === undefined)).toBe(true);
  });
});
