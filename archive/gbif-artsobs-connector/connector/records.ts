/**
 * One GBIF occurrence reduced to what the connector counts (td-eec7db
 * Phase 2). Observer names are never read.
 */

const INT4_MAX = 2_147_483_647;
const CONTROL = /[\u0000-\u001f\u007f]/g;

export interface CompactRecord {
	key: number;
	speciesKey: number | null;
	/** YYYY-MM-DD */
	date: string;
	month: number;
	stateProvince: string;
	/** Artsobservasjoner's own (current) municipality. */
	municipality: string | null;
	/** GBIF's GADM county, e.g. NOR.10_1; null when the point is in no polygon. */
	gid: string | null;
	locality: string | null;
	lat: number | null;
	lon: number | null;
	uncertainty: number | null;
	count: number | null;
	catalogNumber: string | null;
	generalized: boolean;
	withheld: boolean;
	/**
	 * The raw event date when it is an interval ("2025-06-30/2025-07-02"),
	 * else null. Only an interval can match two date slices, and only while
	 * it stays the same; fetchGroup compares it between sightings.
	 */
	range: string | null;
}

export type SkipReason = 'no_key' | 'undated' | 'no_state';

function cleanText(v: unknown, max: number): string | null {
	if (typeof v !== 'string') return null;
	const s = v.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
	return s.length === 0 ? null : s.slice(0, max);
}

function nonNegInt(v: unknown): number | null {
	if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
	const n = Math.round(v);
	return n <= INT4_MAX ? n : null;
}

function calendarDate(v: unknown): string | null {
	if (typeof v !== 'string') return null;
	const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
	if (!m) return null;
	const iso = `${m[1]}-${m[2]}-${m[3]}`;
	const d = new Date(`${iso}T00:00:00Z`);
	return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === iso ? iso : null;
}

export function compactRecord(raw: unknown): CompactRecord | SkipReason {
	const r = (raw ?? {}) as Record<string, unknown>;
	const key = r.key;
	if (typeof key !== 'number' || !Number.isSafeInteger(key) || key <= 0) return 'no_key';
	// An interval ("2025-06-01/2025-06-03") counts on its first day.
	const date = calendarDate(r.eventDate);
	if (!date) return 'undated';
	const range = typeof r.eventDate === 'string' && r.eventDate.includes('/') ? r.eventDate.trim().slice(0, 60) : null;
	const stateProvince = cleanText(r.stateProvince, 120);
	if (!stateProvince) return 'no_state';

	const speciesKey = typeof r.speciesKey === 'number' && Number.isSafeInteger(r.speciesKey) && r.speciesKey > 0 ? r.speciesKey : null;
	const municipality = cleanText(r.municipality, 120);
	const gadm = (r.gadm ?? {}) as { level1?: { gid?: unknown } };
	const gid = typeof gadm.level1?.gid === 'string' && /^[A-Z]{3}\.[0-9]+_[0-9]+$/.test(gadm.level1.gid) ? gadm.level1.gid : null;

	let lat: number | null = typeof r.decimalLatitude === 'number' ? r.decimalLatitude : null;
	let lon: number | null = typeof r.decimalLongitude === 'number' ? r.decimalLongitude : null;
	if (lat === null || lon === null || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
		lat = null;
		lon = null;
	}
	const catalog = cleanText(r.catalogNumber, 40);
	return {
		key,
		speciesKey,
		date,
		month: Number(date.slice(5, 7)),
		stateProvince,
		municipality,
		gid,
		locality: cleanText(r.locality, 300),
		lat,
		lon,
		uncertainty: nonNegInt(r.coordinateUncertaintyInMeters),
		count: nonNegInt(r.individualCount),
		catalogNumber: catalog,
		generalized: cleanText(r.dataGeneralizations, 1000) !== null,
		withheld: cleanText(r.informationWithheld, 1000) !== null,
		range
	};
}
