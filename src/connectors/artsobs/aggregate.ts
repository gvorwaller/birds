/**
 * Counting a county's records for the Norway connector (td-eec7db Phase 2
 * rev B). Pure: no I/O.
 *
 * Artskart's county filter already gives the app's own county, and every
 * record names its municipality, so there is no placement step: a record
 * counts in the county and in its municipality ("{region}:{Municipality}"),
 * or in the county only when it names none.
 *
 * Since td-769300 every record of the window and the days after it also goes
 * to a record sink (the connector's spool on disk) with every detail Artskart
 * gives, and each taxon is sent once with its Norwegian name and Red List
 * status. A municipality's location is the median of its window records'
 * coordinates: where its reports are, not its geographic centre.
 */
import {
	LOCALITIES_PER_PLACE,
	MAX_RECENT_ROWS,
	OBSERVERS_PER_PLACE,
	PIN_MAX_UNCERTAINTY_M,
	PIN_RADIUS_M,
	PIN_SHARE,
	RECENT_DAYS,
	RECENT_KEEP_DAYS,
	REGION_NAMES
} from './config';
import type { CompactRecord, Taxon } from './records';
import type {
	DiagnosticRow,
	LocalityRow,
	ObserverRow,
	PlaceRow,
	RecentRow,
	RecordRow,
	TaxonMonthRow,
	TaxonRow,
	TotalsRow
} from '$server/external-sources/contract';

/** Where each record goes besides the counts (the spool). */
export type RecordSink = (row: RecordRow) => void;

export function addDays(iso: string, days: number): string {
	const d = new Date(`${iso}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
}

export interface Window {
	start: string;
	end: string;
	/** The last day fetched (today): recent reports may run past the window. */
	through: string;
}

interface LocalityAcc {
	n: number;
	lat: number[];
	lon: number[];
	unc: number[];
}

interface ObserverAcc {
	days: Set<string>;
	species: Set<string>;
	localities: Set<string>;
	reports: number;
}

interface PlaceAcc {
	name: string;
	totals: number[];
	unkeyed: number[];
	/** Taxon id → reports per month. */
	taxa: Map<string, number[]>;
	localities: Map<string, LocalityAcc>;
	observers: Map<string, ObserverAcc>;
	/** Artskart's MunicipalityId, the first one seen. */
	upstreamId: string | null;
	/** Window records' coordinates, for the place's location. */
	lat: number[];
	lon: number[];
}

const months13 = () => new Array<number>(13).fill(0);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

function newPlace(name: string): PlaceAcc {
	return {
		name,
		totals: months13(),
		unkeyed: months13(),
		taxa: new Map(),
		localities: new Map(),
		observers: new Map(),
		upstreamId: null,
		lat: [],
		lon: []
	};
}

export interface RegionPayload {
	places: PlaceRow[];
	totals: TotalsRow[];
	taxon_month: TaxonMonthRow[];
	localities: LocalityRow[];
	recent: RecentRow[];
	diagnostics: DiagnosticRow[];
	observers: ObserverRow[];
	taxa: TaxonRow[];
	stats: {
		records: number;
		unkeyed: number;
		noMunicipality: number;
		municipalities: number;
		taxa: number;
		observers: number;
		recentFrom: string | null;
		recentTo: string | null;
		/** Records sent to the sink (the window and the days after it). */
		recordRows: number;
	};
}

export class CountyAggregate {
	private readonly region: PlaceAcc;
	private readonly places = new Map<string, PlaceAcc>();
	/** Taxon id → the name it first arrived under. */
	private readonly taxa = new Map<string, Taxon>();
	private readonly notes = new Map<string, DiagnosticRow>();
	/** Every taxon a record carries, keyed by id and name. */
	private readonly taxonRows = new Map<string, TaxonRow>();
	private recordRows = 0;
	/** Recent candidates: records within RECENT_KEEP_DAYS of the newest date seen. */
	private recent: { r: CompactRecord; place: string }[] = [];
	private newest = '';
	private pruneAt = 4 * MAX_RECENT_ROWS;
	readonly stats = { records: 0, noMunicipality: 0, outsideDates: 0 };

	constructor(
		readonly regionCode: string,
		readonly window: Window,
		private readonly sink: RecordSink | null = null
	) {
		const name = REGION_NAMES[regionCode];
		if (!name) throw new Error(`No Norwegian county ${regionCode}`);
		this.region = newPlace(name);
	}

	note(code: string, detail: string, count: number): void {
		if (count <= 0) return;
		const k = `${code}\u0000${detail}`;
		const d = this.notes.get(k);
		if (d) d.count += count;
		else this.notes.set(k, { code, detail: detail.slice(0, 300), count });
	}

	private placeKey(municipality: string | null): string {
		return municipality ? `${this.regionCode}:${municipality}` : this.regionCode;
	}

	add(r: CompactRecord): void {
		if (r.date < this.window.start || r.date > this.window.through) {
			this.stats.outsideDates++;
			return;
		}
		// One taxon id, one name across the load (the app refuses two).
		let taxon = r.taxon;
		if (taxon) {
			const known = this.taxa.get(taxon.id);
			if (!known) this.taxa.set(taxon.id, taxon);
			else if (known.canonical !== taxon.canonical) {
				this.note('taxon_renamed', `Artskart taxon ${taxon.id}: ${known.raw} / ${taxon.raw}`, 1);
				taxon = known;
			}
		}
		const place = this.placeKey(r.municipality);
		let muni: PlaceAcc | null = null;
		if (r.municipality) {
			muni = this.places.get(place) ?? null;
			if (!muni) this.places.set(place, (muni = newPlace(r.municipality)));
			if (!muni.upstreamId && r.municipalityId) muni.upstreamId = r.municipalityId;
		}
		if (taxon) this.keepRecent(recentFields(r, taxon), place);
		this.sendRecord(r, taxon, place);
		if (r.date > this.window.end) return;

		this.stats.records++;
		const targets = [this.region];
		if (muni) {
			targets.push(muni);
			if (r.lat !== null && r.lon !== null) {
				muni.lat.push(r.lat);
				muni.lon.push(r.lon);
			}
		} else this.stats.noMunicipality++;

		for (const t of targets) {
			t.totals[r.month]++;
			if (taxon) {
				let m = t.taxa.get(taxon.id);
				if (!m) t.taxa.set(taxon.id, (m = months13()));
				m[r.month]++;
			} else t.unkeyed[r.month]++;
			for (const name of r.observers) {
				let o = t.observers.get(name);
				if (!o) t.observers.set(name, (o = { days: new Set(), species: new Set(), localities: new Set(), reports: 0 }));
				o.reports++;
				o.days.add(r.date);
				if (taxon) o.species.add(taxon.binomial);
				if (r.locality) o.localities.add(r.locality);
			}
		}
		if (!taxon) this.note('non_species_taxon', r.otherName ?? '(no name)', 1);
		if (r.uncertainty === null) this.note('no_uncertainty', 'records without a coordinate precision', 1);
		if (r.observers.length === 0) this.note('no_observer', 'records naming no observer', 1);
		if (r.municipality && r.locality) {
			const p = this.places.get(place)!;
			let l = p.localities.get(r.locality);
			if (!l) p.localities.set(r.locality, (l = { n: 0, lat: [], lon: [], unc: [] }));
			l.n++;
			if (r.lat !== null && r.lon !== null) {
				l.lat.push(r.lat);
				l.lon.push(r.lon);
			}
			if (r.uncertainty !== null) l.unc.push(r.uncertainty);
		}
	}

	/** The record, every detail, to the sink; its taxon once to the taxa rows. */
	private sendRecord(r: CompactRecord, taxon: Taxon | null, place: string): void {
		if (!this.sink) return;
		const id = taxon?.id ?? r.taxonId;
		if (!id) {
			this.note('record_without_taxon', 'records with no usable taxon id, not kept', 1);
			return;
		}
		const name = taxon ? taxon.canonical : (r.otherName ?? '(no name)');
		const key = `${id}\u0000${name}`;
		const known = this.taxonRows.get(key);
		if (!known) {
			this.taxonRows.set(key, {
				upstream_taxon_id: id,
				canonical_name: name,
				raw_name: taxon ? taxon.raw : name,
				rank: taxon ? taxon.rank : 'OTHER',
				local_name: r.localName,
				red_list: r.redList,
				red_list_url: r.redListUrl
			});
		} else {
			known.local_name ??= r.localName;
			known.red_list ??= r.redList;
			known.red_list_url ??= r.redListUrl;
		}
		this.recordRows++;
		this.sink({
			upstream_record_id: r.id,
			place_key: place,
			upstream_taxon_id: id,
			canonical_name: name,
			observed_on: r.date,
			count: r.count,
			locality: r.locality,
			lat: r.lat,
			lon: r.lon,
			uncertainty_m: r.uncertainty,
			observers: r.observers.slice(0, 50),
			behaviour: r.behaviour,
			activity: r.activity,
			validation: r.validation,
			notes: r.notes,
			sex: r.sex,
			photos: r.photos,
			dataset: r.dataset,
			record_url: r.url,
			upstream_modified_at: r.modifiedAt
		});
	}

	private keepRecent(r: CompactRecord, place: string): void {
		if (r.date > this.newest) this.newest = r.date;
		const cutoff = addDays(this.newest, -RECENT_KEEP_DAYS);
		if (r.date < cutoff) return;
		this.recent.push({ r, place });
		// Prune only after the list doubles, so a long run of candidates that
		// all stay within the cutoff doesn't re-filter on every record.
		if (this.recent.length > this.pruneAt) {
			this.recent = this.recent.filter((x) => x.r.date >= cutoff);
			this.pruneAt = Math.max(4 * MAX_RECENT_ROWS, 2 * this.recent.length);
		}
	}

	payload(): RegionPayload {
		const region = this.regionCode;
		const all: [string, PlaceAcc][] = [[region, this.region], ...[...this.places.entries()].sort((a, b) => a[0].localeCompare(b[0]))];

		// Recent reports: the last RECENT_DAYS days that have data in this county.
		const from = this.newest ? addDays(this.newest, -(RECENT_DAYS - 1)) : '';
		const window = this.recent
			.filter((c) => c.r.date >= from)
			.sort((a, b) => b.r.date.localeCompare(a.r.date) || a.r.id.localeCompare(b.r.id));
		if (window.length > MAX_RECENT_ROWS) this.note('recent_truncated', `kept the newest ${MAX_RECENT_ROWS}`, window.length - MAX_RECENT_ROWS);
		const recent: RecentRow[] = [];
		for (const { r, place } of window.slice(0, MAX_RECENT_ROWS)) {
			if (!r.url) {
				this.note('recent_without_link', 'recent reports with no sighting number', 1);
				continue;
			}
			recent.push({
				upstream_record_id: r.id,
				place_key: place,
				upstream_taxon_id: r.taxon!.id,
				canonical_name: r.taxon!.canonical,
				observed_on: r.date,
				count: r.count,
				locality: r.locality ?? r.municipality ?? REGION_NAMES[region],
				lat: r.lat,
				lon: r.lon,
				uncertainty_m: r.uncertainty,
				generalized: false,
				record_url: r.url,
				observer: partyText(r.observers)
			});
		}
		// A place that only has recent rows still needs its place and total rows.
		for (const row of recent) {
			if (row.place_key === region || this.places.has(row.place_key)) continue;
			const name = row.place_key.slice(region.length + 1);
			const acc = newPlace(name);
			this.places.set(row.place_key, acc);
			all.push([row.place_key, acc]);
		}

		const places: PlaceRow[] = [];
		const totals: TotalsRow[] = [];
		const taxonMonth: TaxonMonthRow[] = [];
		const localities: LocalityRow[] = [];
		const observers: ObserverRow[] = [];
		for (const [key, acc] of all) {
			const at = acc.lat.length > 0 ? { lat: round3(median(acc.lat)), lon: round3(median(acc.lon)) } : { lat: null, lon: null };
			places.push(
				key === region
					? { place_key: key, name: acc.name, level: 'region', parent_key: null, lat: null, lon: null, upstream_place_id: null }
					: { place_key: key, name: acc.name, level: 'subregion', parent_key: region, ...at, upstream_place_id: acc.upstreamId }
			);
			for (let m = 1; m <= 12; m++) totals.push({ place_key: key, month: m, reports: acc.totals[m], unkeyed: acc.unkeyed[m] });
			for (const [id, months] of [...acc.taxa.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
				const t = this.taxa.get(id)!;
				for (let m = 1; m <= 12; m++) {
					if (months[m] === 0) continue;
					taxonMonth.push({
						place_key: key,
						month: m,
						upstream_taxon_id: id,
						canonical_name: t.canonical,
						raw_name: t.raw,
						rank: t.rank,
						reports: months[m]
					});
				}
			}
			const ranked = [...acc.localities.entries()].sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]));
			ranked.slice(0, LOCALITIES_PER_PLACE).forEach(([name, l], i) => {
				localities.push({ place_key: key, rank: i + 1, locality: name, reports: l.n, ...placeLocality(l) });
			});
			rankObservers(acc.observers)
				.slice(0, OBSERVERS_PER_PLACE)
				.forEach(([name, o], i) => {
					observers.push({
						place_key: key,
						rank: i + 1,
						observer: name,
						days: o.days.size,
						species: o.species.size,
						localities: o.localities.size,
						reports: o.reports
					});
				});
		}
		this.note('outside_window_dates', 'records dated outside the window and today', this.stats.outsideDates);
		this.note('no_municipality', 'records counted at county level only', this.stats.noMunicipality);

		const diagnostics = [...this.notes.values()].sort((a, b) => b.count - a.count || a.code.localeCompare(b.code) || a.detail.localeCompare(b.detail));
		return {
			places,
			totals,
			taxon_month: taxonMonth,
			localities,
			recent,
			diagnostics: diagnostics.slice(0, 500),
			observers,
			taxa: [...this.taxonRows.values()].sort(
				(a, b) => a.upstream_taxon_id.localeCompare(b.upstream_taxon_id) || a.canonical_name.localeCompare(b.canonical_name)
			),
			stats: {
				records: sum(this.region.totals),
				unkeyed: sum(this.region.unkeyed),
				noMunicipality: this.stats.noMunicipality,
				municipalities: places.length - 1,
				taxa: this.region.taxa.size,
				observers: this.region.observers.size,
				recentFrom: from || null,
				recentTo: this.newest || null,
				recordRows: this.recordRows
			}
		};
	}
}

/**
 * A recent candidate keeps only what "Latest reports" shows: up to 80,000
 * candidates are held before a prune, and a full record carries notes,
 * photos and the rest (a live Nordland read peaked at 216 MB heap with full
 * records as candidates, against 122 MB before td-769300).
 */
function recentFields(r: CompactRecord, taxon: Taxon): CompactRecord {
	return {
		...r,
		taxon,
		localName: null,
		redList: null,
		redListUrl: null,
		behaviour: [],
		activity: null,
		validation: null,
		notes: null,
		sex: null,
		photos: null,
		dataset: null,
		modifiedAt: null,
		otherName: null
	};
}

/** Days out first, then species, then localities, then reports, then name. */
function rankObservers(m: Map<string, ObserverAcc>): [string, ObserverAcc][] {
	return [...m.entries()].sort(
		(a, b) =>
			b[1].days.size - a[1].days.size ||
			b[1].species.size - a[1].species.size ||
			b[1].localities.size - a[1].localities.size ||
			b[1].reports - a[1].reports ||
			a[0].localeCompare(b[0])
	);
}

/** "A, B, C" within 200 characters; names that don't fit become "+N". */
export function partyText(names: string[]): string | null {
	if (names.length === 0) return null;
	const kept: string[] = [];
	for (let i = 0; i < names.length; i++) {
		const rest = names.length - i - 1;
		const next = [...kept, names[i]].join(', ') + (rest > 0 ? ` +${rest}` : '');
		if (next.length > 200) break;
		kept.push(names[i]);
	}
	if (kept.length === 0) return names[0].slice(0, 200);
	const more = names.length - kept.length;
	return kept.join(', ') + (more > 0 ? ` +${more}` : '');
}

/** About 100 m: a municipality's location is a point to measure distance from, nothing finer. */
function round3(x: number): number {
	return Math.round(x * 1e3) / 1e3;
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
