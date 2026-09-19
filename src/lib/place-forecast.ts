import { canonicalHref, withReturnTo } from "$lib/navigation-context";

export function hotspotForecastHref(input: {
  locId: string;
  locName: string | null | undefined;
  lat: number | null | undefined;
  lng: number | null | undefined;
  month: number;
  returnTo?: string | null;
}): string {
  const source =
    canonicalHref(input.returnTo) ??
    `/hotspots/${encodeURIComponent(input.locId)}`;
  const valid =
    Number.isFinite(input.lat) &&
    Number.isFinite(input.lng) &&
    input.lat! >= -90 &&
    input.lat! <= 90 &&
    input.lng! >= -180 &&
    input.lng! <= 180;
  if (!valid)
    return withReturnTo(
      `/forecast?chooseLocation=1&month=${input.month}`,
      source,
      undefined,
      input.locName ?? input.locId,
    );
  const params = new URLSearchParams({
    lat: input.lat!.toFixed(5),
    lng: input.lng!.toFixed(5),
    loc: input.locName?.trim() || input.locId,
    month: String(input.month),
  });
  return withReturnTo(
    `/forecast?${params}`,
    source,
    undefined,
    input.locName ?? input.locId,
  );
}
