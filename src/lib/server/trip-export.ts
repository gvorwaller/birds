/**
 * Trip export builders (td-8b959f): one gathered-data object, two renderings.
 * The route gathers (auth, trip, stops, needs) and dispatches; THIS module
 * owns what an export contains — mirroring the ~/trips app's trip-export
 * builder precedent, and keeping both formats from drifting apart.
 *
 * Formats:
 *  - Markdown: the original export, kept byte-compatible in structure, plus
 *    the additive content below (a regression pin holds the old lines).
 *  - HTML: a single SELF-CONTAINED document (inline CSS, no JS, no external
 *    assets) served inline so it opens in a browser tab, saves as one file,
 *    and prints as a field sheet.
 *
 * Content both formats share: "Open in app" link, per-stop deep links back
 * into the app (hotspot pages, field-guide species pages), per-stop AI field
 * tips, and the actual needed-species lists — which needsCountForStops always
 * computed and the old export threw away, keeping only `.size`.
 */
import type { Trip, TripStop } from '$server/trips';
import { mapsPlaceUrl, mapsDirectionsUrl, mapsRouteUrl } from '$lib/geo';
import { normalizeTripStopNote } from '$lib/planner-note';

export interface TripExportData {
	trip: Trip;
	stops: TripStop[];
	counts: Map<number, number>;
	species: Map<number, { code: string; comName: string }[]>;
	/** Absolute origin for links back into the app (e.g. https://birds.gaylon.photos). */
	origin: string;
	/**
	 * 'shared' renders the PUBLIC variant (td-8b959f follow-up): no app deep
	 * links (the recipient has no login — Open-in-app, /hotspots/ and
	 * /species/ links all go), needs relabelled neutrally as targets, and a
	 * "Shared from" footer. External eBird and Google Maps links stay.
	 * Default 'owner' keeps every existing call site byte-identical.
	 */
	mode?: 'owner' | 'shared';
	/** Injectable for deterministic tests; defaults to now. */
	generatedAt?: Date;
}

export function tripExportFilename(tripName: string): string {
	const slug =
		tripName
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 60) || 'trip';
	return `trip-${slug}.md`;
}

function fmtDate(d: string): string {
	return new Date(d + 'T00:00:00').toLocaleDateString('en-US', {
		weekday: 'short',
		year: 'numeric',
		month: 'short',
		day: 'numeric'
	});
}

function fmtDates(trip: Trip): string | null {
	if (trip.start_date && trip.end_date) {
		return trip.start_date === trip.end_date
			? fmtDate(trip.start_date)
			: `${fmtDate(trip.start_date)} – ${fmtDate(trip.end_date)}`;
	}
	if (trip.start_date) return fmtDate(trip.start_date);
	if (trip.end_date) return fmtDate(trip.end_date);
	return null;
}

/** Every user-influenced string rendered into HTML goes through this. */
function esc(s: string): string {
	return s.replace(/[&<>"']/g, (c) => {
		switch (c) {
			case '&':
				return '&amp;';
			case '<':
				return '&lt;';
			case '>':
				return '&gt;';
			case '"':
				return '&quot;';
			default:
				return '&#39;';
		}
	});
}

function speciesUrl(origin: string, code: string, tripId: number): string {
	return `${origin}/species/${code}?returnTo=${encodeURIComponent(`/trips/${tripId}`)}`;
}

function stopName(s: TripStop): string {
	return s.custom_name ?? 'Stop';
}

function routePoints(stops: TripStop[]): { lat: number; lng: number }[] {
	return stops
		.filter((s) => s.lat != null && s.lon != null)
		.map((s) => ({ lat: s.lat as number, lng: s.lon as number }));
}

function needsLabel(n: number, shared: boolean): string {
	// The owner phrasing is personal ("your needs"); the public page describes
	// the same data as the owner's targets without claiming them for the reader.
	return shared
		? `${n} target species reported here (last 14 days, ≤16 km)`
		: `${n} of your needs reported here (last 14 days, ≤16 km)`;
}

/* ------------------------------------------------------------------ */
/* Markdown                                                            */
/* ------------------------------------------------------------------ */

export function buildTripMarkdown(data: TripExportData): string {
	const { trip, stops, counts, species, origin } = data;
	const shared = data.mode === 'shared';
	const lines: string[] = [];
	lines.push(`# ${trip.name}`, '');
	if (!shared) lines.push(`[Open in app](${origin}/trips/${trip.id})`, '');

	const dates = fmtDates(trip);
	if (dates) lines.push(`**Dates:** ${dates}`, '');
	if (trip.notes) lines.push(trip.notes, '');

	lines.push(`## Stops (${stops.length})`, '');
	if (stops.length === 0) {
		lines.push('_No stops yet._', '');
	}
	const points = routePoints(stops);
	if (points.length >= 2) {
		lines.push(`[🧭 Navigate all stops](${mapsRouteUrl(points)})`, '');
	}
	stops.forEach((s, i) => {
		const name = stopName(s);
		// Deep link into the app's own hotspot page when the stop IS a hotspot;
		// the external eBird link below stays for the eBird-native view.
		lines.push(
			s.hotspot_id && !shared
				? `### ${i + 1}. [${name}](${origin}/hotspots/${s.hotspot_id})`
				: `### ${i + 1}. ${name}`
		);
		const meta: string[] = [];
		const n = counts.get(s.id);
		if (n !== undefined) meta.push(needsLabel(n, shared));
		if (s.lat != null && s.lon != null) {
			const place = {
				name,
				lat: s.lat,
				lng: s.lon,
				google_place_id: s.google_place_id
			};
			meta.push(`[📍 Map](${mapsPlaceUrl(place)})`);
			meta.push(`[Directions](${mapsDirectionsUrl(place)})`);
		}
		if (s.hotspot_id) {
			meta.push(`[eBird hotspot](https://ebird.org/hotspot/${s.hotspot_id})`);
		}
		if (meta.length) lines.push('', meta.join(' · '));
		const needed = species.get(s.id);
		if (needed && needed.length > 0) {
			lines.push(
				'',
				shared
					? `Targets: ` + needed.map((sp) => sp.comName).join(' · ')
					: `Needs: ` +
							needed
								.map((sp) => `[${sp.comName}](${speciesUrl(origin, sp.code, trip.id)})`)
								.join(' · ')
			);
		}
		if (s.field_tip) lines.push('', `> 💡 ${s.field_tip}`);
		if (s.notes) lines.push('', `> ${normalizeTripStopNote(s.notes)}`);
		lines.push('');
	});

	lines.push('---', '');
	const when = (data.generatedAt ?? new Date()).toLocaleDateString('en-US');
	lines.push(
		shared
			? `_Shared from birds.gaylon.photos on ${when}. Data from eBird.org._`
			: `_Generated by birds.gaylon.photos on ${when}. Data from eBird.org._`
	);
	return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* HTML                                                                */
/* ------------------------------------------------------------------ */

/**
 * Self-contained field sheet. Page-local custom props only — this document
 * lives outside the app and cannot share its stylesheet; dark mode and print
 * each get one small override block.
 */
const HTML_STYLE = `
:root {
  --bg: #fdfdfb; --fg: #1e2a22; --muted: #67706a;
  --accent: #1c6b45; --rule: #dde3de;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #161a17; --fg: #e6ebe7; --muted: #97a29b; --accent: #6cc397; --rule: #313832; }
}
* { box-sizing: border-box; }
body {
  margin: 0 auto; padding: 20px 16px 48px; max-width: 42rem;
  background: var(--bg); color: var(--fg);
  font: 16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
h1 { font-size: 1.5rem; margin: 0 0 4px; }
h2 { font-size: 1.1rem; margin: 24px 0 8px; border-bottom: 1px solid var(--rule); padding-bottom: 4px; }
h3 { font-size: 1rem; margin: 20px 0 4px; }
a { color: var(--accent); }
.muted { color: var(--muted); font-size: 0.9rem; }
.openapp {
  display: inline-flex; align-items: center; min-height: 48px; padding: 0 20px;
  margin: 10px 0; border-radius: 8px; background: var(--accent); color: var(--bg);
  text-decoration: none; font-weight: 600;
}
.meta { font-size: 0.9rem; margin: 2px 0 0; }
.needs { font-size: 0.95rem; margin: 6px 0 0; }
.tip {
  margin: 8px 0 0; padding: 8px 12px; border-left: 3px solid var(--accent);
  background: color-mix(in srgb, var(--accent) 8%, var(--bg)); border-radius: 0 6px 6px 0;
}
blockquote { margin: 8px 0 0; padding-left: 12px; border-left: 3px solid var(--rule); color: var(--muted); }
footer { margin-top: 32px; border-top: 1px solid var(--rule); padding-top: 8px; }
@media print {
  :root { --bg: #fff; --fg: #000; --muted: #444; --accent: #000; --rule: #999; }
  .openapp { display: none; }
}
`.trim();

export function buildTripHtml(data: TripExportData): string {
	const { trip, stops, counts, species, origin } = data;
	const shared = data.mode === 'shared';
	const parts: string[] = [];
	const dates = fmtDates(trip);

	parts.push(`<h1>${esc(trip.name)}</h1>`);
	if (dates) parts.push(`<p class="muted">${esc(dates)}</p>`);
	if (!shared) {
		parts.push(`<a class="openapp" href="${esc(`${origin}/trips/${trip.id}`)}">Open in app ↗</a>`);
	}
	if (trip.notes) parts.push(`<p>${esc(trip.notes)}</p>`);

	parts.push(`<h2>Stops (${stops.length})</h2>`);
	if (stops.length === 0) parts.push(`<p class="muted">No stops yet.</p>`);
	const points = routePoints(stops);
	if (points.length >= 2) {
		parts.push(`<p><a href="${esc(mapsRouteUrl(points))}">🧭 Navigate all stops</a></p>`);
	}

	stops.forEach((s, i) => {
		const name = stopName(s);
		parts.push(
			s.hotspot_id && !shared
				? `<h3>${i + 1}. <a href="${esc(`${origin}/hotspots/${s.hotspot_id}`)}">${esc(name)}</a></h3>`
				: `<h3>${i + 1}. ${esc(name)}</h3>`
		);
		const meta: string[] = [];
		const n = counts.get(s.id);
		if (n !== undefined) meta.push(esc(needsLabel(n, shared)));
		if (s.lat != null && s.lon != null) {
			const place = { name, lat: s.lat, lng: s.lon, google_place_id: s.google_place_id };
			meta.push(`<a href="${esc(mapsPlaceUrl(place))}">📍 Map</a>`);
			meta.push(`<a href="${esc(mapsDirectionsUrl(place))}">Directions</a>`);
		}
		if (s.hotspot_id) {
			meta.push(`<a href="${esc(`https://ebird.org/hotspot/${s.hotspot_id}`)}">eBird hotspot</a>`);
		}
		if (meta.length) parts.push(`<p class="meta">${meta.join(' · ')}</p>`);
		const needed = species.get(s.id);
		if (needed && needed.length > 0) {
			parts.push(
				shared
					? `<p class="needs">Targets: ` +
							needed.map((sp) => esc(sp.comName)).join(' · ') +
							`</p>`
					: `<p class="needs">Needs: ` +
							needed
								.map(
									(sp) =>
										`<a href="${esc(speciesUrl(origin, sp.code, trip.id))}">${esc(sp.comName)}</a>`
								)
								.join(' · ') +
							`</p>`
			);
		}
		if (s.field_tip) parts.push(`<p class="tip">💡 ${esc(s.field_tip)}</p>`);
		if (s.notes) parts.push(`<blockquote>${esc(normalizeTripStopNote(s.notes))}</blockquote>`);
	});

	const when = esc((data.generatedAt ?? new Date()).toLocaleDateString('en-US'));
	parts.push(
		shared
			? `<footer class="muted">Shared from birds.gaylon.photos on ${when}. Data from eBird.org.</footer>`
			: `<footer class="muted">Generated by birds.gaylon.photos on ${when}. Data from eBird.org.</footer>`
	);

	return [
		'<!doctype html>',
		'<html lang="en">',
		'<head>',
		'<meta charset="utf-8">',
		'<meta name="viewport" content="width=device-width, initial-scale=1">',
		// The token lives in this page's URL: search engines must not index it
		// and outbound clicks (eBird, Google Maps) must not receive it in the
		// Referer header.
		...(shared
			? ['<meta name="robots" content="noindex">', '<meta name="referrer" content="no-referrer">']
			: []),
		`<title>${esc(trip.name)}</title>`,
		`<style>${HTML_STYLE}</style>`,
		'</head>',
		'<body>',
		...parts,
		'</body>',
		'</html>'
	].join('\n');
}
