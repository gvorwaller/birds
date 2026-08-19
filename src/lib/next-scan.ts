/**
 * "today 1:11 PM ET" / "tomorrow …" / "Friday …" for the hub's scheduled-scan
 * line, in the app's calendar zone (td-b7d021 GROK pin a). Extracted from the
 * page for the DST contract below.
 */
const APP_TZ = "America/New_York";

const dayIn = (x: Date) => x.toLocaleDateString("en-CA", { timeZone: APP_TZ }); // YYYY-MM-DD

export function fmtNextScan(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString("en-US", {
    timeZone: APP_TZ,
    hour: "numeric",
    minute: "2-digit",
  });
  const today = dayIn(now);
  // Tomorrow is the next CALENDAR date in the zone — never now+24h, which
  // skips a date across the 23-hour spring-forward day (CODEX1 follow-up).
  // Date.UTC absorbs the +1 overflow; noon UTC formats to the same calendar
  // date in any US zone.
  const [y, m, dd] = today.split("-").map(Number);
  const tomorrow = dayIn(new Date(Date.UTC(y, m - 1, dd + 1, 12)));
  const scanDay = dayIn(d);
  const day =
    scanDay === today
      ? "today"
      : scanDay === tomorrow
        ? "tomorrow"
        : d.toLocaleDateString("en-US", { timeZone: APP_TZ, weekday: "long" });
  return `${day} ${time} ET`;
}
