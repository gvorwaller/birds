/**
 * Counting and placing records for the Norway connector (td-eec7db Phase 2,
 * owner's option B). Pure: no I/O.
 *
 * Records stream into one GroupAggregate per 2024 county (`stateProvince`,
 * garbled spellings grouped) and are counted per (municipality, GADM county)
 * bucket; raw records are never kept, except recent ones. buildRegionPayload
 * then places each bucket in an app county:
 *   - the bucket's own GADM county when GBIF placed its points in one;
 *   - otherwise the county most of that municipality's GADM-placed records
 *     fall in (the coastal records GADM misses, Phase 0 finding 5);
 *   - otherwise nowhere: the records are reported as `unplaced_records`.
 */
import {
	GADM_TO_REGION,
	LOCALITIES_PER_PLACE,
	MAX_RECENT_ROWS,
	PIN_MAX_UNCERTAINTY_M,
	PIN_RADIUS_M,
	PIN_SHARE,
	RECENT_DAYS,
	RECENT_KEEP_DAYS,
	REGION_NAMES,
	sightingUrl
} from './config';
import type { CompactRecord } from './records';
import type { SpeciesInfo } from './gbif';
import type { DiagnosticRow, LocalityRow, PlaceRow, RecentRow, TaxonMonthRow, TotalsRow } from '$server/external-sources/contract';

export function addDays(iso: string, days: number): string {
	const d = new Date(`${iso}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
}

/** Spelling-insensitive key for a 2024 county: GBIF also returns "Tr��ndelag". */
export function normalizeState(name: string): string {
	return name
		.normalize('NFD')
		.toLowerCase()
		.replace(/[^a-z ]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}

interface LocalityAcc {
	n: number;
	lat: number[];
	lon: number[];
	unc: number[];
}

interface Bucket {
	municipality: string | null;
	gid: string | null;
	/** Every record, window and later, for the majority rule. */
	records: number;
	totals: number[];
	unkeyed: number[];
	noUncertainty: number;
	species: Map<number, number[]>;
	localities: Map<string, LocalityAcc>;
}

const months13 = () => new Array<number>(13).fill(0);

export interface Window {
	start: string;
	end: string;
	/** The last day fetched (today): recent reports may run past the window. */
	through: string;
}

export class GroupAggregate {
	readonly buckets = new Map<string, Bucket>();
	/** Recent candidates: records within RECENT_KEEP_DAYS of the newest date seen. */
	recent: CompactRecord[] = [];
	newest = '';
	readonly speciesKeys = new Set<number>();
	readonly stats = { records: 0, duplicates: 0, outsideDates: 0, withheld: 0, generalized: 0, skipped: 0 };
	private readonly seen = new Set<number>();
	/** The seen keys, sorted, once sealed: a load checks no record is in two groups. */
	keys: Float64Array = new Float64Array(0);
	private pruneAt = 4 * MAX_RECENT_ROWS;

	constructor(
		readonly name: string,
		readonly variants: string[],
		readonly window: Window
	) {}

	/**
	 * False when the record was already counted: a record dated as an interval
	 * can match two date slices. (Any other repeat moved while GBIF was read;
	 * fetchGroup reads the group again.)
	 */
	add(r: CompactRecord): boolean {
		if (this.seen.has(r.key)) {
			this.stats.duplicates++;
			return false;
		}
		this.seen.add(r.key);
		if (r.date < this.window.start || r.date > this.window.through) {
			this.stats.outsideDates++;
			return true;
		}
		this.stats.records++;
		if (r.withheld) this.stats.withheld++;
		if (r.generalized) this.stats.generalized++;
		const bkey = `${r.municipality ?? ''}\u0000${r.gid ?? ''}`;
		let b = this.buckets.get(bkey);
		if (!b) {
			b = {
				municipality: r.municipality,
				gid: r.gid,
				records: 0,
				totals: months13(),
				unkeyed: months13(),
				noUncertainty: 0,
				species: new Map(),
				localities: new Map()
			};
			this.buckets.set(bkey, b);
		}
		b.records++;
		if (r.date <= this.window.end) {
			b.totals[r.month]++;
			if (r.uncertainty === null) b.noUncertainty++;
			if (r.speciesKey === null) b.unkeyed[r.month]++;
			else {
				this.speciesKeys.add(r.speciesKey);
				let m = b.species.get(r.speciesKey);
				if (!m) b.species.set(r.speciesKey, (m = months13()));
				m[r.month]++;
			}
			if (r.locality) {
				let l = b.localities.get(r.locality);
				if (!l) b.localities.set(r.locality, (l = { n: 0, lat: [], lon: [], unc: [] }));
				l.n++;
				if (r.lat !== null && r.lon !== null) {
					l.lat.push(r.lat);
					l.lon.push(r.lon);
				}
				if (r.uncertainty !== null) l.unc.push(r.uncertainty);
			}
		}
		if (r.speciesKey !== null) {
			// Recent reports past the window need names too.
			this.speciesKeys.add(r.speciesKey);
			this.keepRecent(r);
		}
		return true;
	}

	/** Seen-set size: how many distinct records this group has taken in. */
	get distinct(): number {
		return this.seen.size;
	}

	/** Swap the per-record key set for a sorted array (8 bytes a record); the counts stay. */
	sealed(): this {
		this.keys = Float64Array.from(this.seen).sort();
		this.seen.clear();
		return this;
	}

	private keepRecent(r: CompactRecord): void {
		if (r.date > this.newest) this.newest = r.date;
		const cutoff = addDays(this.newest, -RECENT_KEEP_DAYS);
		if (r.date < cutoff) return;
		this.recent.push(r);
		// Prune only after the list doubles, so a long run of candidates that
		// all stay within the cutoff doesn't re-filter on every record.
		if (this.recent.length > this.pruneAt) {
			this.recent = this.recent.filter((x) => x.date >= cutoff);
			this.pruneAt = Math.max(4 * MAX_RECENT_ROWS, 2 * this.recent.length);
		}
	}
}

// ── Placement and payload ──────────────────────────────────────────────────

export interface RegionPayload {
	places: PlaceRow[];
	totals: TotalsRow[];
	taxon_month: TaxonMonthRow[];
	localities: LocalityRow[];
	recent: RecentRow[];
	diagnostics: DiagnosticRow[];
	stats: {
		records: number;
		unkeyed: number;
		placedByMunicipality: number;
		unplaced: number;
		municipalities: number;
		species: number;
		recentFrom: string | null;
		recentTo: string | null;
	};
}

interface PlaceAcc {
	name: string;
	totals: number[];
	unkeyed: number[];
	species: Map<number, number[]>;
	localities: Map<string, LocalityAcc>;
}

function median(xs: number[]): number {
	const s = [...xs].sort((a, b) => a - b);
	const mid = s.length >> 1;
	return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Great-circle distance in metres. */
export function distanceM(lat1: number, lon1: number, lat2: number, lon2: number): number {
	const rad = Math.PI / 180;
	const dLat = (lat2 - lat1) * rad;
	const dLon = (lon2 - lon1) * rad;
	const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
	return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Phase 0 finding 6: a pin at the median coordinate only when 90% of the
 * locality's records lie within 1 km of it and their median uncertainty is
 * at most 1 km. Otherwise the locality is text (no coordinates sent).
 * Both shares are of every record of the locality: a record without
 * coordinates is never near, and one without an uncertainty counts as
 * unbounded, so missing values can't prove agreement.
 */
export function placeLocality(l: LocalityAcc): Pick<LocalityRow, 'lat' | 'lon' | 'uncertainty_m' | 'placement'> {
	const unc = l.unc.length ? Math.round(median(l.unc)) : null;
	const text = { lat: null, lon: null, uncertainty_m: unc, placement: 'text' as const };
	if (l.n === 0 || l.lat.length === 0) return text;
	const allUnc = [...l.unc, ...new Array<number>(Math.max(0, l.n - l.unc.length)).fill(Infinity)];
	if (median(allUnc) > PIN_MAX_UNCERTAINTY_M) return text;
	const lat = median(l.lat);
	const lon = median(l.lon);
	let near = 0;
	for (let i = 0; i < l.lat.length; i++) if (distanceM(lat, lon, l.lat[i], l.lon[i]) <= PIN_RADIUS_M) near++;
	if (near / l.n < PIN_SHARE) return text;
	return { lat: Math.round(lat * 1e5) / 1e5, lon: Math.round(lon * 1e5) / 1e5, uncertainty_m: unc, placement: 'pin' };
}

function mergeLocalities(into: Map<string, LocalityAcc>, from: Map<string, LocalityAcc>): void {
	for (const [name, l] of from) {
		const t = into.get(name);
		if (!t) into.set(name, { n: l.n, lat: [...l.lat], lon: [...l.lon], unc: [...l.unc] });
		else {
			// Loops, not push(...xs): a locality can hold more values than a
			// call takes arguments.
			t.n += l.n;
			for (const x of l.lat) t.lat.push(x);
			for (const x of l.lon) t.lon.push(x);
			for (const x of l.unc) t.unc.push(x);
		}
	}
}

function addMonths(into: number[], from: number[]): void {
	for (let m = 1; m <= 12; m++) into[m] += from[m];
}

/** The app county a municipality's GADM-placed records mostly fall in (ties: lowest code). */
function municipalityCounties(group: GroupAggregate): Map<string, string> {
	const tally = new Map<string, Map<string, number>>();
	for (const b of group.buckets.values()) {
		const region = b.gid ? GADM_TO_REGION[b.gid] : undefined;
		if (!b.municipality || !region) continue;
		let t = tally.get(b.municipality);
		if (!t) tally.set(b.municipality, (t = new Map()));
		t.set(region, (t.get(region) ?? 0) + b.records);
	}
	const out = new Map<string, string>();
	for (const [muni, t] of tally) {
		const best = [...t.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
		out.set(muni, best[0]);
	}
	return out;
}

function bucketRegion(b: Bucket, majority: Map<string, string>): { region: string | null; how: 'gadm' | 'municipality' | 'none' } {
	const own = b.gid ? GADM_TO_REGION[b.gid] : undefined;
	if (own) return { region: own, how: 'gadm' };
	const byMuni = b.municipality ? majority.get(b.municipality) : undefined;
	return byMuni ? { region: byMuni, how: 'municipality' } : { region: null, how: 'none' };
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/**
 * GBIF keys two sealed groups share. A record moves between 2024 counties
 * only if GBIF re-indexed it during the load's reads; it would then count twice.
 */
export function sharedRecords(a: GroupAggregate, b: GroupAggregate): number {
	let shared = 0;
	for (let i = 0, j = 0; i < a.keys.length && j < b.keys.length; ) {
		if (a.keys[i] === b.keys[j]) {
			shared++;
			i++;
			j++;
		} else if (a.keys[i] < b.keys[j]) i++;
		else j++;
	}
	return shared;
}

export function buildRegionPayload(groups: GroupAggregate[], region: string, species: Map<number, SpeciesInfo>): RegionPayload {
	const regionName = REGION_NAMES[region];
	if (!regionName) throw new Error(`No Norwegian county ${region}`);
	const diag = new Map<string, DiagnosticRow>();
	const note = (code: string, detail: string, count: number) => {
		if (count <= 0) return;
		const k = `${code}\u0000${detail}`;
		const d = diag.get(k);
		if (d) d.count += count;
		else diag.set(k, { code, detail: detail.slice(0, 300), count });
	};

	const regionAcc: PlaceAcc = { name: regionName, totals: months13(), unkeyed: months13(), species: new Map(), localities: new Map() };
	const places = new Map<string, PlaceAcc>();
	/** Which group each municipality place name came from, to keep same-named ones apart. */
	const placeGroup = new Map<string, string>();
	const placeKeyOf = new Map<string, string | null>(); // `${group}\0${muni}` → place key
	let placedByMunicipality = 0;
	let unplaced = 0;
	let noUncertainty = 0;

	const keyFor = (group: GroupAggregate, muni: string): string => {
		const memo = `${group.name}\u0000${muni}`;
		const hit = placeKeyOf.get(memo);
		if (hit) return hit;
		let name = muni;
		const owner = placeGroup.get(muni);
		if (owner !== undefined && owner !== group.name) {
			name = `${muni} (${group.name})`.slice(0, 120);
			note('municipality_name_clash', `${muni}: ${owner} and ${group.name}`, 1);
		} else placeGroup.set(muni, group.name);
		const key = `${region}:${name}`;
		placeKeyOf.set(memo, key);
		if (!places.has(key)) places.set(key, { name, totals: months13(), unkeyed: months13(), species: new Map(), localities: new Map() });
		return key;
	};

	const addSpecies = (acc: PlaceAcc, speciesKey: number, months: number[]) => {
		let m = acc.species.get(speciesKey);
		if (!m) acc.species.set(speciesKey, (m = months13()));
		addMonths(m, months);
	};

	for (const group of groups) {
		const majority = municipalityCounties(group);
		// Municipalities whose records land in more than one app county.
		const spread = new Map<string, Map<string, number>>();
		for (const b of group.buckets.values()) {
			const { region: r, how } = bucketRegion(b, majority);
			const inWindow = sum(b.totals);
			if (b.municipality && r) {
				let s = spread.get(b.municipality);
				if (!s) spread.set(b.municipality, (s = new Map()));
				s.set(r, (s.get(r) ?? 0) + inWindow);
			}
			if (r === null) {
				unplaced += inWindow;
				note('unplaced_records', `${group.name}: ${b.municipality ?? '(no municipality)'}`, inWindow);
				continue;
			}
			if (r !== region) continue;
			if (how === 'municipality') {
				placedByMunicipality += inWindow;
				if (b.gid) note('foreign_gadm_county', `${b.gid} (placed by municipality)`, inWindow);
			}
			noUncertainty += b.noUncertainty;
			const targets: PlaceAcc[] = [regionAcc];
			if (b.municipality) targets.push(places.get(keyFor(group, b.municipality))!);
			// Species keys GBIF can't name at species rank count as unkeyed.
			const keyed = months13();
			for (const [sk, months] of b.species) {
				const info = species.get(sk);
				if (!info || info.rank !== 'SPECIES') {
					note('non_species_taxon', `GBIF key ${sk}${info ? ` ${info.canonicalName} (${info.rank})` : ''}`, sum(months));
					for (const t of targets) addMonths(t.unkeyed, months);
					continue;
				}
				addMonths(keyed, months);
				for (const t of targets) addSpecies(t, sk, months);
			}
			for (const t of targets) {
				addMonths(t.totals, b.totals);
				addMonths(t.unkeyed, b.unkeyed);
			}
			if (b.municipality) mergeLocalities(targets[1].localities, b.localities);
		}
		for (const [muni, s] of spread) {
			if (s.size > 1 && s.has(region)) {
				const parts = [...s.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([r, n]) => `${r} ${n}`);
				note('split_municipality', `${muni}: ${parts.join(', ')}`, s.get(region)!);
			}
		}
		note('outside_window_dates', group.name, group.stats.outsideDates);
		note('information_withheld', group.name, group.stats.withheld);
		note('generalized_coordinates', group.name, group.stats.generalized);
	}
	note('placed_by_municipality', 'records outside every GADM county, placed by their municipality', placedByMunicipality);
	note('no_uncertainty', 'records without a coordinate uncertainty', noUncertainty);

	// Rows.
	const placeRows: PlaceRow[] = [{ place_key: region, name: regionName, level: 'region', parent_key: null, lat: null, lon: null }];
	const all: [string, PlaceAcc][] = [[region, regionAcc]];
	for (const [key, acc] of [...places.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
		placeRows.push({ place_key: key, name: acc.name, level: 'subregion', parent_key: region, lat: null, lon: null });
		all.push([key, acc]);
	}
	const totals: TotalsRow[] = [];
	const taxonMonth: TaxonMonthRow[] = [];
	const localities: LocalityRow[] = [];
	for (const [key, acc] of all) {
		for (let m = 1; m <= 12; m++) totals.push({ place_key: key, month: m, reports: acc.totals[m], unkeyed: acc.unkeyed[m] });
		for (const [sk, months] of [...acc.species.entries()].sort((a, b) => a[0] - b[0])) {
			const info = species.get(sk)!;
			for (let m = 1; m <= 12; m++) {
				if (months[m] === 0) continue;
				taxonMonth.push({
					place_key: key,
					month: m,
					upstream_taxon_id: String(sk),
					canonical_name: info.canonicalName.slice(0, 200),
					raw_name: info.scientificName.slice(0, 300),
					rank: 'SPECIES',
					reports: months[m]
				});
			}
		}
		const ranked = [...acc.localities.entries()].sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]));
		ranked.slice(0, LOCALITIES_PER_PLACE).forEach(([name, l], i) => {
			localities.push({ place_key: key, rank: i + 1, locality: name, reports: l.n, ...placeLocality(l) });
		});
	}

	// Recent reports: the last RECENT_DAYS days that have data in this county.
	const candidates: { r: CompactRecord; place: string; info: SpeciesInfo }[] = [];
	for (const group of groups) {
		const majority = municipalityCounties(group);
		for (const r of group.recent) {
			const b = group.buckets.get(`${r.municipality ?? ''}\u0000${r.gid ?? ''}`);
			if (!b || bucketRegion(b, majority).region !== region) continue;
			const info = r.speciesKey === null ? undefined : species.get(r.speciesKey);
			if (!info || info.rank !== 'SPECIES') continue;
			candidates.push({ r, place: r.municipality ? keyFor(group, r.municipality) : region, info });
		}
	}
	const newest = candidates.reduce((a, c) => (c.r.date > a ? c.r.date : a), '');
	const from = newest ? addDays(newest, -(RECENT_DAYS - 1)) : '';
	const window = candidates.filter((c) => c.r.date >= from).sort((a, b) => b.r.date.localeCompare(a.r.date) || b.r.key - a.r.key);
	if (window.length > MAX_RECENT_ROWS) note('recent_truncated', `kept the newest ${MAX_RECENT_ROWS}`, window.length - MAX_RECENT_ROWS);
	const recent: RecentRow[] = window.slice(0, MAX_RECENT_ROWS).map(({ r, place, info }) => ({
		upstream_record_id: String(r.key),
		place_key: place,
		upstream_taxon_id: String(info.key),
		canonical_name: info.canonicalName.slice(0, 200),
		observed_on: r.date,
		count: r.count,
		locality: r.locality ?? r.municipality ?? regionName,
		lat: r.lat,
		lon: r.lon,
		uncertainty_m: r.uncertainty,
		generalized: r.generalized,
		record_url: sightingUrl(r.catalogNumber, r.key),
		observer: null
	}));
	// A place that only has recent rows still needs its place and total rows.
	for (const row of recent) {
		if (placeRows.some((p) => p.place_key === row.place_key)) continue;
		const acc = places.get(row.place_key)!;
		placeRows.push({ place_key: row.place_key, name: acc.name, level: 'subregion', parent_key: region, lat: null, lon: null });
		for (let m = 1; m <= 12; m++) totals.push({ place_key: row.place_key, month: m, reports: 0, unkeyed: 0 });
	}

	const diagnostics = [...diag.values()].sort((a, b) => b.count - a.count || a.code.localeCompare(b.code) || a.detail.localeCompare(b.detail));
	return {
		places: placeRows,
		totals,
		taxon_month: taxonMonth,
		localities,
		recent,
		diagnostics: diagnostics.slice(0, 500),
		stats: {
			records: sum(regionAcc.totals),
			unkeyed: sum(regionAcc.unkeyed),
			placedByMunicipality,
			unplaced,
			municipalities: placeRows.length - 1,
			species: regionAcc.species.size,
			recentFrom: from || null,
			recentTo: newest || null
		}
	};
}
