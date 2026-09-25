import { error } from "@sveltejs/kit";
import { query } from "$lib/db";
import { haversineKm, MILES_TO_KM } from "$lib/geo";
import { isHotspotLocId } from "$lib/loc-id";
import { parseRegionCode } from "$lib/region-code";
import type { GuideLocationSelection } from "$lib/guide-location";
import { countyMeta } from "$server/county-meta";
import { getRegion, regionLabel, subnational1Of } from "$server/regions";
import { comparePlaceChoices } from "$lib/place-filter";
import type { GuideChoicesLevel } from "$lib/guide-location";

interface LoadedLocation {
  loc_code: string;
  loc_kind: "region" | "hotspot";
  region_code: string | null;
  begin_year: number;
  end_year: number;
}

export interface GuideCoverage {
  locCodes: string[];
  wholeArea: boolean;
  beginYear: number | null;
  endYear: number | null;
}

export interface GuideChoice {
  code: string;
  name: string;
}

export interface ResolvedGuideLocation extends GuideCoverage {
  kind: "country" | "region" | "county" | "hotspot" | "map";
  /** The label shown for the selection itself. */
  label: string;
  /** County labels come from the official county-equivalent table. */
  officialCountyName: boolean;
  /** Validated ancestry; null where the selection is shallower. */
  ancestry: {
    country: string | null;
    region: string | null;
    county: string | null;
    hotspot: string | null;
  };
  /** Map/radius extras; null for hierarchical selections. */
  map: {
    place: string;
    lat: number;
    lng: number;
    dist: number;
    /** Loaded hotspots with no usable recorded coordinates (not evaluable). */
    coordinateMissing: number;
  } | null;
}

/** No external calls: membership comes from recorded eBird geography, never
 * from prose, a bounding box, or country-name text matching. */
export async function guideLocationCoverage(code: string): Promise<GuideCoverage> {
  const { rows } = await query<LoadedLocation>(
    `SELECT loc_code, loc_kind, region_code, begin_year, end_year
			 FROM frequency_fetch
			 WHERE (loc_kind = 'region' AND (loc_code = $1 OR loc_code LIKE $2))
			    OR (loc_kind = 'hotspot' AND (region_code = $1 OR region_code LIKE $2))`,
    [code, `${code}-%`],
  );
  // Include every recorded source: even a statewide export can omit a taxon
  // present in a county or hotspot export covering the same years.
  const sources = rows;
  return {
    locCodes: sources.map((r) => r.loc_code),
    wholeArea: sources.some(
      (r) => r.loc_kind === "region" && r.loc_code === code,
    ),
    beginYear: sources.length
      ? Math.min(...sources.map((r) => r.begin_year))
      : null,
    endYear: sources.length
      ? Math.max(...sources.map((r) => r.end_year))
      : null,
  };
}

// One fixed, runtime-locale-independent order shared with the combobox
// (td-daff98): name, then code.
const byNameThenCode = comparePlaceChoices;

/** The display name of a county-equivalent: official label when this exact
 * code is known, otherwise the stored eBird name unchanged. */
function countyName(code: string, storedName: string): string {
  return countyMeta(code)?.name ?? storedName;
}

/** A country's first-level regions (states), name-sorted with the shared order. */
export async function guideRegions(country: string): Promise<GuideChoice[]> {
  return (await subnational1Of(country))
    .map(({ code, name }) => ({ code, name }))
    .sort(byNameThenCode);
}

/**
 * Choices for one Place level beneath an already-validated `parent`
 * (td-daff98's /api/guide-locations). The parent's IDENTITY is proven first:
 * the list helpers return [] for a well-shaped code that doesn't exist, which
 * must not read as "a real place with nothing loaded". Returns null for an
 * unknown parent; [] means the parent is real and has no loaded children.
 * Reads DB/reference data only.
 */
export async function guideChoicesFor(
  level: GuideChoicesLevel,
  parent: string,
): Promise<GuideChoice[] | null> {
  if (level === "region") {
    if ((await getRegion(parent))?.level !== "country") return null;
    return guideRegions(parent);
  }
  if (level === "county") {
    if ((await getRegion(parent))?.level !== "subnational1") return null;
    return guideCounties(parent);
  }
  // A hotspot list needs the exact loaded county row, as the loader requires
  // before it accepts a county selection (resolveGuideLocation).
  const { rows } = await query<{ n: number }>(
    `SELECT 1 AS n FROM frequency_fetch WHERE loc_kind = 'region' AND loc_code = $1`,
    [parent],
  );
  if (rows.length === 0 || parseRegionCode(parent)?.level !== "subnational2") return null;
  return guideHotspots(parent);
}

/** Every loaded second-level region directly beneath `region`, name-sorted. */
export async function guideCounties(region: string): Promise<GuideChoice[]> {
  const { rows } = await query<{ loc_code: string; loc_name: string }>(
    `SELECT loc_code, loc_name FROM frequency_fetch
		  WHERE loc_kind = 'region' AND loc_code LIKE $1`,
    [`${region}-%`],
  );
  return rows
    .filter((r) => {
      const parsed = parseRegionCode(r.loc_code);
      return parsed?.level === "subnational2" && parsed.parent === region;
    })
    .map((r) => ({ code: r.loc_code, name: countyName(r.loc_code, r.loc_name) }))
    .sort(byNameThenCode);
}

/** Every loaded hotspot recorded under `county`, name-sorted. */
export async function guideHotspots(county: string): Promise<GuideChoice[]> {
  const { rows } = await query<{ loc_code: string; loc_name: string }>(
    `SELECT loc_code, loc_name FROM frequency_fetch
		  WHERE loc_kind = 'hotspot' AND region_code = $1`,
    [county],
  );
  return rows
    .filter((r) => isHotspotLocId(r.loc_code))
    .map((r) => ({ code: r.loc_code, name: r.loc_name }))
    .sort(byNameThenCode);
}

/** Kilometres per degree of latitude on the haversine sphere (R = 6371 km). */
const KM_PER_LAT_DEGREE = (Math.PI * 6371) / 180;

/**
 * Loaded, coordinate-known eBird hotspots within `dist` miles of a point.
 * Latitude bands never wrap, so the SQL prefilter is antimeridian-safe; the
 * exact test is the shared haversine, which is periodic in longitude.
 */
async function mapCoverage(
  lat: number,
  lng: number,
  dist: number,
): Promise<{ coverage: GuideCoverage; coordinateMissing: number }> {
  const km = dist * MILES_TO_KM;
  const pad = (km / KM_PER_LAT_DEGREE) * 1.001 + 1e-6;
  const [inBand, missing] = await Promise.all([
    query<{
      loc_code: string;
      begin_year: number;
      end_year: number;
      lat: number;
      lng: number;
    }>(
      `SELECT f.loc_code, f.begin_year, f.end_year, e.lat, e.lng
			   FROM frequency_fetch f
			   JOIN ebird_locations e ON e.loc_id = f.loc_code
			  WHERE f.loc_kind = 'hotspot' AND f.loc_code ~ '^L[0-9]+$'
			    AND e.lat BETWEEN $1 AND $2`,
      [lat - pad, lat + pad],
    ),
    query<{ n: number }>(
      `SELECT count(*)::int AS n FROM frequency_fetch f
			  WHERE f.loc_kind = 'hotspot'
			    AND NOT EXISTS (
			      SELECT 1 FROM ebird_locations e
			       WHERE e.loc_id = f.loc_code
			         AND e.lat <> 'NaN'::float8 AND e.lng <> 'NaN'::float8)`,
    ),
  ]);
  const inside = inBand.rows.filter(
    (r) =>
      Number.isFinite(r.lat) &&
      Number.isFinite(r.lng) &&
      haversineKm(lat, lng, r.lat, r.lng) <= km,
  );
  return {
    coverage: {
      locCodes: inside.map((r) => r.loc_code),
      wholeArea: false,
      beginYear: inside.length
        ? Math.min(...inside.map((r) => r.begin_year))
        : null,
      endYear: inside.length ? Math.max(...inside.map((r) => r.end_year)) : null,
    },
    coordinateMissing: missing.rows[0]?.n ?? 0,
  };
}

/**
 * Verifies a parsed selection against the static region reference and the
 * loaded frequency sources, and derives its label and coverage. Invalid
 * identity is a 400; a valid selection with no loaded data is coverage of
 * zero sources (unavailable), never an error.
 */
export async function resolveGuideLocation(
  selection: GuideLocationSelection,
): Promise<ResolvedGuideLocation | null> {
  if (selection.kind === "anywhere") return null;

  if (selection.kind === "map") {
    const { coverage, coordinateMissing } = await mapCoverage(
      selection.lat,
      selection.lng,
      selection.dist,
    );
    return {
      ...coverage,
      kind: "map",
      label: selection.place,
      officialCountyName: false,
      ancestry: { country: null, region: null, county: null, hotspot: null },
      map: {
        place: selection.place,
        lat: selection.lat,
        lng: selection.lng,
        dist: selection.dist,
        coordinateMissing,
      },
    };
  }

  let country: string | null = selection.country;
  let region: string | null = null;
  let county: string | null = null;
  let hotspot: string | null = null;

  if ("region" in selection) {
    const selectedRegion = await getRegion(selection.region);
    if (
      !selectedRegion ||
      selectedRegion.level !== "subnational1" ||
      !selectedRegion.parent
    )
      error(400, "Choose a recognized state or region.");
    if (selection.country !== selectedRegion.parent)
      error(400, "That region is not in the selected country.");
    region = selection.region;
  }
  if ((await getRegion(country))?.level !== "country")
    error(400, "Choose a recognized country.");

  if (selection.kind === "country" || selection.kind === "region") {
    const code = region ?? country;
    return {
      ...(await guideLocationCoverage(code)),
      kind: selection.kind,
      label: (await regionLabel(code)) ?? code,
      officialCountyName: false,
      ancestry: { country, region, county: null, hotspot: null },
      map: null,
    };
  }

  county = selection.county;
  const countyRow = (
    await query<{ loc_name: string; begin_year: number; end_year: number }>(
      `SELECT loc_name, begin_year, end_year FROM frequency_fetch
			  WHERE loc_kind = 'region' AND loc_code = $1`,
      [county],
    )
  ).rows[0];
  const parsedCounty = parseRegionCode(county);
  if (
    !countyRow ||
    parsedCounty?.level !== "subnational2" ||
    parsedCounty.parent !== region
  )
    error(400, "That county has no loaded data for the selected state or region.");
  const countyLabel = countyName(county, countyRow.loc_name);

  if (selection.kind === "county") {
    return {
      ...(await guideLocationCoverage(county)),
      kind: "county",
      label: countyLabel,
      officialCountyName: countyMeta(county) != null,
      ancestry: { country, region, county, hotspot: null },
      map: null,
    };
  }

  hotspot = selection.hotspot;
  const hotspotRow = (
    await query<{
      loc_name: string;
      region_code: string | null;
      begin_year: number;
      end_year: number;
    }>(
      `SELECT loc_name, region_code, begin_year, end_year FROM frequency_fetch
			  WHERE loc_kind = 'hotspot' AND loc_code = $1`,
      [hotspot],
    )
  ).rows[0];
  if (!hotspotRow || !isHotspotLocId(hotspot) || hotspotRow.region_code !== county)
    error(400, "That hotspot has no loaded data in the selected county.");
  return {
    locCodes: [hotspot],
    wholeArea: false,
    beginYear: hotspotRow.begin_year,
    endYear: hotspotRow.end_year,
    kind: "hotspot",
    label: hotspotRow.loc_name,
    officialCountyName: false,
    ancestry: { country, region, county, hotspot },
    map: null,
  };
}
