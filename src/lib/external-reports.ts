/**
 * Wording and small helpers for external-source report counts (td-eec7db
 * Phase 3), shared by the server and the pages. The rules: counts of
 * reports, never "likely" or "frequency"; a percentage only in full prose
 * beside its denominator.
 */
export const MONTH_LONG = [
	'January',
	'February',
	'March',
	'April',
	'May',
	'June',
	'July',
	'August',
	'September',
	'October',
	'November',
	'December'
] as const;
export const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** "What can I see?": needed species shown before "Show all" (td-46fff6). */
export const NEAR_SPECIES_SHOWN = 25;

/** "Oct 2024 – Sep 2026" for an inclusive YYYY-MM-DD window. */
export function windowLabel(start: string, end: string): string {
	const part = (d: string) => `${MONTH_SHORT[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;
	return `${part(start)} – ${part(end)}`;
}

/** "reports" with its number: "1 report", "1,204 reports". */
export function reportsText(n: number): string {
	return `${n.toLocaleString('en-US')} report${n === 1 ? '' : 's'}`;
}

/** A share in prose: "1.8%", "under 0.1%". Null without a denominator. */
export function shareText(reports: number, total: number): string | null {
	if (!(total > 0)) return null;
	const pct = (reports / total) * 100;
	if (reports > 0 && pct < 0.1) return 'under 0.1%';
	return `${pct.toFixed(1)}%`;
}

/**
 * The selected month's caption, the one place the share appears:
 * "142 reports in June — 1.8% of all 7,890 bird reports in Nordland that month."
 */
export function monthCaption(reports: number, total: number, month: number, regionName: string): string {
	const name = MONTH_LONG[month - 1];
	const head = `${reportsText(reports)} in ${name}`;
	const share = shareText(reports, total);
	if (share === null) return `${head} — share unavailable (no bird reports counted in ${regionName} that month).`;
	return `${head} — ${share} of all ${total.toLocaleString('en-US')} bird reports in ${regionName} that month.`;
}

/** The busiest months by report count, most first (ties keep calendar order). */
export function busiestMonths(months: readonly number[], n = 3): number[] {
	return months
		.map((reports, i) => ({ month: i + 1, reports }))
		.filter((m) => m.reports > 0)
		.sort((a, b) => b.reports - a.reports || a.month - b.month)
		.slice(0, n)
		.map((m) => m.month);
}

/**
 * The region a "Load a region" picker submits: the one picked while it is
 * still offered, else the first offered (CODEX1 F5: a region just queued
 * leaves the list, and a stale pick made the select submit nothing).
 */
export function pickedRegion(picked: string | undefined, offered: readonly { code: string }[]): string {
	return picked && offered.some((r) => r.code === picked) ? picked : (offered[0]?.code ?? '');
}

/** A region's row in Hotspots & data's "Reports from other sources" card. */
export const externalRegionId = (regionCode: string) => `ext-${regionCode}`;
export function externalRegionHref(regionCode: string): string {
	return `/forecast/data#${externalRegionId(regionCode)}`;
}

/** "Mon 27 Oct" for a YYYY-MM-DD date, without time-zone drift. */
export function reportDate(isoDate: string): string {
	const [y, m, d] = isoDate.split('-').map(Number);
	return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
		weekday: 'short',
		day: 'numeric',
		month: 'short',
		timeZone: 'UTC'
	});
}

/** The trip planner prefilled at a place (trips/plan reads these params). */
export function tripPlanHref(place: string, lat: number, lon: number): string {
	const p = new URLSearchParams();
	p.set('place', place);
	p.set('lat', lat.toFixed(5));
	p.set('lng', lon.toFixed(5));
	return `/trips/plan?${p.toString()}`;
}

/** The "Where and when to look" view for a source's region (Phase 4). */
export function whereWhenHref(
	sourceId: string,
	regionCode: string,
	opts: { month?: number | null; place?: string | null; view?: 'month' | 'species'; seen?: 'needs' | 'all' } = {}
): string {
	const p = new URLSearchParams();
	if (opts.view === 'species') p.set('view', 'species');
	if (opts.place) p.set('place', opts.place);
	if (opts.month) p.set('month', String(opts.month));
	if (opts.seen === 'all') p.set('seen', 'all');
	const q = p.toString();
	return `/reports/${encodeURIComponent(sourceId)}/${encodeURIComponent(regionCode)}${q ? `?${q}` : ''}`;
}

interface MonthSpecies {
	name: string;
	seen: boolean;
	months: readonly number[];
}

/** The species to list: needs only (not seen) or all of them. */
export function speciesShown<T extends { seen: boolean }>(species: readonly T[], needsOnly: boolean): T[] {
	return needsOnly ? species.filter((s) => !s.seen) : [...species];
}

/** Species reported in a month, most reports first (ties by name). */
export function speciesInMonth<T extends MonthSpecies>(species: readonly T[], month: number): T[] {
	return species
		.filter((s) => s.months[month - 1] > 0)
		.sort((a, b) => b.months[month - 1] - a.months[month - 1] || a.name.localeCompare(b.name));
}

interface PlaceFigures {
	name: string;
	monthSpecies: number;
	monthNeeds: number;
	species: number;
	needs: number;
}

/**
 * Municipalities, most needs (or species) first, for the month or the whole
 * window; ties in Norwegian name order.
 */
export function rankPlaces<T extends PlaceFigures>(rows: readonly T[], byMonth: boolean, needsOnly: boolean): T[] {
	const key = (r: T) => (byMonth ? (needsOnly ? r.monthNeeds : r.monthSpecies) : needsOnly ? r.needs : r.species);
	return [...rows].sort((a, b) => key(b) - key(a) || a.name.localeCompare(b.name, 'nb'));
}
