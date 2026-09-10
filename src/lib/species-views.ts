/** Exact personal-write exceptions; these never authorize owner-data writes. */
export function isSpeciesViewsRequest(
  path: string,
  method: string,
  action?: string,
): boolean {
  return (
    method === "POST" &&
    (path === "/api/species-views" ||
      (path === "/viewed" && (action === "/tracking" || action === "/clear")))
  );
}
export interface SpeciesView {
  firstViewedAt: string;
  lastViewedAt: string;
}
export interface SpeciesViewResult {
  enabled: boolean;
  view: SpeciesView | null;
}
export function viewedDate(value: string): string {
  return (
    new Date(value).toLocaleString("en-US", {
      timeZone: "UTC",
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }) + " UTC"
  );
}
