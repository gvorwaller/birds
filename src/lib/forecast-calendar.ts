/** Owner's local calendar. The droplet is UTC; after ~19:00 ET on the last
 *  day of a month `Date#getMonth()` would already be next month. */
export const FORECAST_CALENDAR_TZ = "America/New_York";

export function calendarMonth(now = new Date()): number {
  const raw = new Intl.DateTimeFormat("en-US", {
    timeZone: FORECAST_CALENDAR_TZ,
    month: "numeric",
  }).format(now);
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 12 ? n : 1;
}
