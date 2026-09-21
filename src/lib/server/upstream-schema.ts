/** Runtime contracts for provider payloads. Types alone disappear at the HTTP
 * boundary; these checks keep renamed/missing keys from becoming blank UI or
 * poisoned cache rows. Unknown extra fields remain forward-compatible. */

export class UpstreamSchemaError extends Error {
  constructor(
    public provider: "eBird" | "NWS" | "NOAA",
    public endpoint: string,
    public issues: string[],
  ) {
    super(`${provider} schema drift at ${endpoint}: ${issues.slice(0, 5).join("; ")}`);
    this.name = "UpstreamSchemaError";
  }
}

type Obj = Record<string, unknown>;
const object = (value: unknown): value is Obj => value != null && typeof value === "object" && !Array.isArray(value);
const string = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function optional(value: unknown, test: (v: unknown) => boolean): boolean {
  return value == null || test(value);
}

export function validateEbirdObservations(value: unknown, endpoint: string): unknown[] {
  if (!Array.isArray(value)) throw new UpstreamSchemaError("eBird", endpoint, ["response must be an array"]);
  const issues: string[] = [];
  value.forEach((row, i) => {
    if (!object(row)) { issues.push(`[${i}] must be an object`); return; }
    for (const key of ["speciesCode", "comName", "sciName", "locId", "locName", "obsDt"])
      if (!string(row[key])) issues.push(`[${i}].${key} must be a non-empty string`);
    for (const key of ["lat", "lng"])
      if (!finite(row[key])) issues.push(`[${i}].${key} must be a finite number`);
    if (typeof row.locationPrivate !== "boolean") issues.push(`[${i}].locationPrivate must be boolean`);
    if (!optional(row.howMany, finite)) issues.push(`[${i}].howMany must be numeric when present`);
    for (const key of ["obsValid", "obsReviewed"])
      if (!optional(row[key], (v) => typeof v === "boolean")) issues.push(`[${i}].${key} must be boolean when present`);
    if (!optional(row.subId, string)) issues.push(`[${i}].subId must be a non-empty string when present`);
  });
  if (issues.length) throw new UpstreamSchemaError("eBird", endpoint, issues);
  return value;
}

export function validateEbirdHotspots(value: unknown, endpoint: string): unknown[] {
  if (!Array.isArray(value)) throw new UpstreamSchemaError("eBird", endpoint, ["response must be an array"]);
  const issues: string[] = [];
  value.forEach((row, i) => {
    if (!object(row)) { issues.push(`[${i}] must be an object`); return; }
    for (const key of ["locId", "locName"])
      if (!string(row[key])) issues.push(`[${i}].${key} must be a non-empty string`);
    for (const key of ["lat", "lng"])
      if (!finite(row[key])) issues.push(`[${i}].${key} must be a finite number`);
    if (!optional(row.numSpeciesAllTime, finite)) issues.push(`[${i}].numSpeciesAllTime must be numeric when present`);
    for (const key of ["latestObsDt", "subnational1Code", "subnational2Code"])
      if (!optional(row[key], string)) issues.push(`[${i}].${key} must be a non-empty string when present`);
  });
  if (issues.length) throw new UpstreamSchemaError("eBird", endpoint, issues);
  return value;
}

export function validateEbirdHotspotInfo(value: unknown, endpoint: string): Obj {
  if (!object(value)) throw new UpstreamSchemaError("eBird", endpoint, ["response must be an object"]);
  const issues: string[] = [];
  if (!string(value.locId) && !string(value.locID)) issues.push("locId or locID must be a non-empty string");
  if (!string(value.name) && !string(value.locName)) issues.push("name or locName must be a non-empty string");
  if (!finite(value.latitude) && !finite(value.lat)) issues.push("latitude or lat must be a finite number");
  if (!finite(value.longitude) && !finite(value.lng)) issues.push("longitude or lng must be a finite number");
  if (typeof value.isHotspot !== "boolean") issues.push("isHotspot must be boolean");
  if (issues.length) throw new UpstreamSchemaError("eBird", endpoint, issues);
  return value;
}

/** The life-list coordinate resolver intentionally consumes only the stable
 * coordinate subset of hotspot-info. It still validates that subset so a key
 * rename cannot be recorded as a legitimate coordinate miss. */
export function validateEbirdHotspotCoordinates(
  value: unknown,
  endpoint: string,
): { name?: string; latitude: number; longitude: number } {
  if (!object(value)) throw new UpstreamSchemaError("eBird", endpoint, ["response must be an object"]);
  const issues: string[] = [];
  if (!finite(value.latitude)) issues.push("latitude must be a finite number");
  if (!finite(value.longitude)) issues.push("longitude must be a finite number");
  if (!optional(value.name, string)) issues.push("name must be a non-empty string when present");
  if (issues.length) throw new UpstreamSchemaError("eBird", endpoint, issues);
  return value as { name?: string; latitude: number; longitude: number };
}

export function validateEbirdRegions(value: unknown, endpoint: string): unknown[] {
  if (!Array.isArray(value)) throw new UpstreamSchemaError("eBird", endpoint, ["response must be an array"]);
  const issues: string[] = [];
  value.forEach((row, i) => {
    if (!object(row)) { issues.push(`[${i}] must be an object`); return; }
    for (const key of ["code", "name"])
      if (!string(row[key])) issues.push(`[${i}].${key} must be a non-empty string`);
  });
  if (issues.length) throw new UpstreamSchemaError("eBird", endpoint, issues);
  return value;
}

export interface NwsPointsContract { forecastUrl: string; label: string | null }
export function validateNwsPoints(value: unknown): NwsPointsContract {
  const issues: string[] = [];
  const root = object(value) ? value : {};
  const properties = object(root.properties) ? root.properties : {};
  if (!string(properties.forecast)) issues.push("properties.forecast must be a non-empty string");
  const relative = object(properties.relativeLocation) && object(properties.relativeLocation.properties)
    ? properties.relativeLocation.properties : null;
  let label: string | null = null;
  if (relative?.city != null || relative?.state != null) {
    if (!string(relative.city)) issues.push("properties.relativeLocation.properties.city must be a non-empty string");
    if (!string(relative.state)) issues.push("properties.relativeLocation.properties.state must be a non-empty string");
    if (string(relative.city) && string(relative.state)) label = `${relative.city}, ${relative.state}`;
  }
  if (issues.length) throw new UpstreamSchemaError("NWS", "/points", issues);
  return { forecastUrl: properties.forecast as string, label };
}

export interface NwsPeriodContract {
  name: string; isDaytime: boolean; tempF: number; precipPct: number | null;
  windSpeed: string; windDirection: string; shortForecast: string;
}
export function validateNwsForecast(value: unknown): NwsPeriodContract[] {
  const root = object(value) ? value : {};
  const properties = object(root.properties) ? root.properties : {};
  if (!Array.isArray(properties.periods))
    throw new UpstreamSchemaError("NWS", "/gridpoints/*/forecast", ["properties.periods must be an array"]);
  const issues: string[] = [];
  const periods = properties.periods.slice(0, 4).map((raw, i) => {
    const row = object(raw) ? raw : {};
    for (const key of ["name", "windSpeed", "windDirection", "shortForecast"])
      if (!string(row[key])) issues.push(`properties.periods[${i}].${key} must be a non-empty string`);
    if (typeof row.isDaytime !== "boolean") issues.push(`properties.periods[${i}].isDaytime must be boolean`);
    if (!finite(row.temperature)) issues.push(`properties.periods[${i}].temperature must be a finite number`);
    const probability = object(row.probabilityOfPrecipitation) ? row.probabilityOfPrecipitation.value : null;
    if (probability != null && !finite(probability)) issues.push(`properties.periods[${i}].probabilityOfPrecipitation.value must be numeric or null`);
    return {
      name: row.name as string, isDaytime: row.isDaytime as boolean,
      tempF: row.temperature as number, precipPct: probability as number | null,
      windSpeed: row.windSpeed as string, windDirection: row.windDirection as string,
      shortForecast: row.shortForecast as string,
    };
  });
  if (issues.length) throw new UpstreamSchemaError("NWS", "/gridpoints/*/forecast", issues);
  return periods;
}

export function reportSchemaDrift(error: unknown, context: string): void {
  if (error instanceof UpstreamSchemaError) {
    // No payload or credentials: only provider, safe endpoint/cache namespace,
    // and field paths. Worker callers also persist this message in job events.
    console.warn(`upstream-schema ${context}: ${error.message}`);
  }
}
