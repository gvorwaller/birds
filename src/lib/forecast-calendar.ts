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

const MONTH_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/**
 * "Dec–Mar" from [12, 1, 2, 3]: group months (1-12) into consecutive runs,
 * joining a run that wraps the year boundary (…, 12) + (1, …). Client-safe
 * pure formatter for the good-months window. Non-consecutive groups join
 * with commas ("Dec–Mar, Jun"); an all-year window reads "year-round".
 */
export function formatMonthWindow(months: readonly number[]): string {
  const uniq = [...new Set(months.filter((m) => m >= 1 && m <= 12))].sort(
    (a, b) => a - b,
  );
  if (uniq.length === 0) return "";
  if (uniq.length === 12) return "year-round";

  // Build consecutive runs over the sorted list.
  const runs: number[][] = [];
  for (const m of uniq) {
    const last = runs[runs.length - 1];
    if (last && m === last[last.length - 1] + 1) last.push(m);
    else runs.push([m]);
  }
  // Wrap: a run ending in Dec continues a run starting in Jan. The merged
  // boundary-spanning range reads last ("Jun, Dec–Jan"), keeping the rest in
  // calendar order.
  if (
    runs.length > 1 &&
    runs[0][0] === 1 &&
    runs[runs.length - 1].at(-1) === 12
  ) {
    const janRun = runs.shift()!;
    const decRun = runs.pop()!;
    runs.push([...decRun, ...janRun]);
  }
  return runs
    .map((run) =>
      run.length === 1
        ? MONTH_SHORT[run[0] - 1]
        : `${MONTH_SHORT[run[0] - 1]}–${MONTH_SHORT[run[run.length - 1] - 1]}`,
    )
    .join(", ");
}
