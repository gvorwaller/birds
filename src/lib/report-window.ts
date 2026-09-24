/**
 * Calendar window for an eBird local timestamp ("YYYY-MM-DD" or
 * "YYYY-MM-DD HH:mm"). No zone is stored on the timestamp.
 *
 * eBird's back=1 is a rolling last-24-hours query. Include the preceding
 * calendar boundary and reject only clearly old or future dates.
 */

function localDateOf(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:\s+\d{2}:\d{2})?$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    return null;
  }
  return `${match[1]}-${match[2]}-${match[3]}`;
}

export function observationDateInWindow(
  obsDt: string,
  backDays: number,
  now = new Date(),
): boolean {
  const date = localDateOf(obsDt);
  if (!date) return false;
  const end = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  )
    .toISOString()
    .slice(0, 10);
  const start = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() - backDays - 1,
    ),
  )
    .toISOString()
    .slice(0, 10);
  return date >= start && date <= end;
}
