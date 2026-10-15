/**
 * The app sections Admin → Users reports (td-c8e6a3). A page counts toward
 * the section of its route; the usage-features test fails when a new page
 * route has no section, so a new page is never silently uncounted.
 */
export const USAGE_FEATURES = [
  "home",
  "field_guide",
  "forecast",
  "hotspots_data",
  "trips",
  "photos",
  "life_list",
  "nearest",
  "study",
  "alerts",
  "settings",
  "help",
  "admin",
] as const;
export type UsageFeature = (typeof USAGE_FEATURES)[number];

export const USAGE_FEATURE_LABEL: Record<UsageFeature, string> = {
  home: "Home",
  field_guide: "Field guide",
  forecast: "Forecast",
  hotspots_data: "Hotspots & data",
  trips: "Trips",
  photos: "Photos",
  life_list: "Life list",
  nearest: "Nearest",
  study: "Study lists",
  alerts: "Alerts",
  settings: "Settings",
  help: "Help & About",
  admin: "Admin",
};

/** Route id (SvelteKit `event.route.id`) → section; most specific first. */
const ROUTE_FEATURES: [prefix: string, feature: UsageFeature][] = [
  ["/forecast/data", "hotspots_data"],
  ["/hotspots", "hotspots_data"],
  ["/forecast", "forecast"],
  ["/species", "field_guide"],
  ["/taxonomy", "field_guide"],
  ["/parts-of-a-bird", "field_guide"],
  ["/trips", "trips"],
  ["/photos", "photos"],
  ["/life", "life_list"],
  ["/nearest", "nearest"],
  ["/viewed", "study"],
  ["/special-interest", "study"],
  ["/alerts", "alerts"],
  ["/settings", "settings"],
  ["/help", "help"],
  ["/about", "help"],
  ["/admin", "admin"],
];

/** Pages that are not a use of the app: signing in and the old /targets
 * redirect. Only pages count: the browser reports a page it finished showing
 * (src/lib/usage-report.ts), never an endpoint. */
const UNCOUNTED_ROUTES = new Set(["/login", "/targets"]);

/** The section a page route belongs to, or null for an uncounted route. */
export function usageFeatureFor(routeId: string | null): UsageFeature | null {
  if (!routeId || UNCOUNTED_ROUTES.has(routeId) || routeId.startsWith("/api/")) return null;
  if (routeId === "/") return "home";
  for (const [prefix, feature] of ROUTE_FEATURES)
    if (routeId === prefix || routeId.startsWith(`${prefix}/`)) return feature;
  return null;
}

/** Exported for the coverage test: routes deliberately not counted. */
export const UNCOUNTED_PAGE_ROUTES: ReadonlySet<string> = UNCOUNTED_ROUTES;

/** The usage report a viewer may send (hooks.server.ts allows it). */
export function isActivityRequest(path: string, method: string): boolean {
  return method === "POST" && path === "/api/activity";
}
