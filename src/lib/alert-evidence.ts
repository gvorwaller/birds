/**
 * Alert history presented next to live eBird feeds (td-48c22e).
 *
 * The alerts page stores the checklist that was sent. The species page
 * asks different feeds. These helpers keep the stored line and the
 * "sent N days ago" stamp from drifting away from that contract.
 */
import { observationDateInWindow } from "$lib/report-window";

export interface StoredAlertReport {
  subId: string | null;
  locName: string;
  obsDt: string;
  distanceMi: number;
  sentAt: string;
}

const OBS_DT = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}:\d{2}))?$/;
const MONTHS_SHORT = [
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

/** Local calendar-day difference. Same function the alerts day header uses. */
export function calendarDaysBefore(then: Date, now: Date): number {
  const sent = Date.UTC(then.getFullYear(), then.getMonth(), then.getDate());
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.floor((today - sent) / 86_400_000);
}

/**
 * Age of an alert send. Days follow the local calendar so two sends on
 * Saturday cannot read as different day counts. Within the sent day,
 * minutes and hours stay exact.
 */
export function relativeAge(iso: string, now = new Date()): string {
  const then = new Date(iso);
  const t = then.getTime();
  if (!Number.isFinite(t)) return iso;
  const days = calendarDaysBefore(then, now);
  if (days >= 7) {
    return then.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }
  if (days >= 1) return `${days} day${days === 1 ? "" : "s"} ago`;
  const mins = Math.max(0, Math.round((now.getTime() - t) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.max(1, Math.round(mins / 60));
  return `${hours} hr ago`;
}

/** eBird's naive local clock, formatted the way the alerts page already shows it. */
export function formatAlertObsDt(obsDt: string): string {
  const m = OBS_DT.exec(obsDt);
  if (!m) return obsDt;
  const mon = MONTHS_SHORT[Number(m[2]) - 1] ?? m[2];
  const day = Number(m[3]);
  return m[4] ? `seen ${mon} ${day}, ${m[4]}` : `seen ${mon} ${day}`;
}

export function alertReportKey(
  report: Pick<StoredAlertReport, "subId" | "locName" | "obsDt">,
): string {
  return report.subId
    ? `sub:${report.subId}`
    : `anon:${report.locName}|${report.obsDt}`;
}

function parseReport(value: unknown, sentAt: string): StoredAlertReport | null {
  if (value == null || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.locName !== "string" || row.locName.length === 0) return null;
  if (typeof row.obsDt !== "string" || !OBS_DT.test(row.obsDt)) return null;
  if (typeof row.distanceMi !== "number" || !Number.isFinite(row.distanceMi))
    return null;
  const subId =
    typeof row.subId === "string" && row.subId.length > 0 ? row.subId : null;
  return {
    subId,
    locName: row.locName,
    obsDt: row.obsDt,
    distanceMi: row.distanceMi,
    sentAt,
  };
}

/**
 * Newest-first stored reports for one species, deduped and limited to the
 * page's report window. `rows` must already be newest send first.
 */
export function storedAlertReports(
  rows: { sentAt: string; reports: unknown }[],
  backDays: number,
  now = new Date(),
): StoredAlertReport[] {
  const seen = new Set<string>();
  const out: StoredAlertReport[] = [];
  for (const row of rows) {
    const reports = Array.isArray(row.reports) ? row.reports : [];
    for (const item of reports) {
      const report = parseReport(item, row.sentAt);
      if (!report || !observationDateInWindow(report.obsDt, backDays, now))
        continue;
      const key = alertReportKey(report);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(report);
    }
  }
  return out;
}

/** Drop stored checklists the live feeds already returned. */
export function omittedAlertReports(
  stored: StoredAlertReport[],
  live: { subId?: string | null; locName: string; obsDt: string }[],
): StoredAlertReport[] {
  const liveKeys = new Set(
    live.map((row) =>
      alertReportKey({
        subId: row.subId ?? null,
        locName: row.locName,
        obsDt: row.obsDt,
      }),
    ),
  );
  return stored.filter((report) => !liveKeys.has(alertReportKey(report)));
}
