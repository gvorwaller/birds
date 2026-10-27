/**
 * Reading one county from Artskart (td-eec7db Phase 2 rev B), one request at
 * a time.
 *
 * The window is read in calendar-month slices. Artskart offers no snapshot
 * to page through, so:
 *   - a slice counts only once it reads back whole: every page gives the
 *     same TotalCount and the distinct record ids equal it (pages repeat a
 *     few rows, so rows are de-duplicated by id). A slice that changed while
 *     read is read again from scratch, SLICE_READS times in all;
 *   - a record id met in two slices (its date changed mid-read) sends the
 *     whole county round again, COUNTY_READS times in all, so nothing is
 *     counted twice.
 * A record whose date can't be read, or falls outside the month asked for,
 * is a broken answer: the load fails (as retryable) rather than publishing
 * a month that silently lost reports (CODEX1 rev B finding 1; none in the
 * 723,133-record Nordland pull of 2026-10-26).
 * Either limit reached fails the load as retryable. One change these checks
 * can't see: a report deleted and another added in the same month while
 * that month is paged leave its count unchanged, so the load may count the
 * deleted one and miss the new one; and a report re-dated from a month not
 * yet read into one already read is in neither slice, so it is missed
 * (CODEX1 rev B finding 4). The next load corrects both. Slices are NOT counted
 * again after the read: Artskart is live (Nordland gains ~160 reports a
 * day), so a report added after its month was read simply belongs to the
 * next load, as a report added after the load would.
 */
import { ArtskartError, type ArtskartClient, type SliceQuery } from './artskart';
import { COUNTY_READS, PAGE_SIZE, SLICE_READS } from './config';
import { CountyAggregate, addDays, type Window } from './aggregate';
import { compactRecord, recordId, type CompactRecord } from './records';

export interface FetchProgress {
	pagesDone: number;
	pagesTotal: number;
}

/** Calendar months from `start` through `through`, the last one clipped. */
export function monthRanges(start: string, through: string): [string, string][] {
	const out: [string, string][] = [];
	let y = Number(start.slice(0, 4));
	let m = Number(start.slice(5, 7));
	for (;;) {
		const first = `${y}-${String(m).padStart(2, '0')}-01`;
		if (first > through) break;
		const last = addDays(m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`, -1);
		out.push([first < start ? start : first, last > through ? through : last]);
		if (++m > 12) {
			m = 1;
			y++;
		}
	}
	return out;
}

export interface FetchOptions {
	pageSize?: number;
}

interface Slice {
	records: CompactRecord[];
	total: number;
}

/** One slice, read whole; up to SLICE_READS reads. */
export async function readSlice(
	client: ArtskartClient,
	q: SliceQuery,
	progress: FetchProgress,
	signal: AbortSignal,
	opts: FetchOptions = {}
): Promise<Slice> {
	const pageSize = opts.pageSize ?? PAGE_SIZE;
	let why = '';
	for (let read = 1; read <= SLICE_READS; read++) {
		const first = await client.page(q, 0, pageSize, signal);
		const pages = Math.max(1, first.totalPages);
		progress.pagesTotal += pages;
		// Compacted as each page arrives: a raw record carries ~60 fields, and a
		// busy month holds tens of thousands (live Nordland run 2026-10-27:
		// 431 MB peak RSS when raw records were kept for the whole month).
		const byId = new Map<string, CompactRecord | 'undated'>();
		let changed = false;
		for (let p = 0; p < pages; p++) {
			const page = p === 0 ? first : await client.page(q, p, pageSize, signal);
			progress.pagesDone++;
			if (page.total !== first.total) {
				changed = true;
				why = `its count changed from ${first.total} to ${page.total}`;
				progress.pagesTotal -= pages - p - 1;
				break;
			}
			for (const raw of page.observations) {
				const id = recordId(raw);
				if (!id) throw new ArtskartError(`Artskart county ${q.county} ${q.from}–${q.to}: a record has no usable id`, true);
				if (!byId.has(id)) byId.set(id, compactRecord(raw));
			}
		}
		if (!changed && byId.size !== first.total) {
			changed = true;
			why = `${byId.size} distinct records came back for a count of ${first.total}`;
		}
		if (changed) continue;
		const records: CompactRecord[] = [];
		for (const [id, r] of byId) {
			if (r === 'undated' || r.date < q.from || r.date > q.to) {
				throw new ArtskartError(
					`Artskart county ${q.county} ${q.from}–${q.to}: record ${id} has ${r === 'undated' ? 'no readable date' : `the date ${r.date}`}; not publishing a month that would lose it`,
					true
				);
			}
			records.push(r);
		}
		return { records, total: first.total };
	}
	throw new ArtskartError(`Artskart county ${q.county} ${q.from}–${q.to} never read back whole (${why}); try again later`, true);
}

/** The whole county; up to COUNTY_READS reads when records move between slices. */
export async function readCounty(
	client: ArtskartClient,
	regionCode: string,
	county: number,
	window: Window,
	progress: FetchProgress,
	signal: AbortSignal,
	opts: FetchOptions = {}
): Promise<CountyAggregate> {
	const ranges = monthRanges(window.start, window.through);
	let why = '';
	for (let read = 1; read <= COUNTY_READS; read++) {
		const agg = new CountyAggregate(regionCode, window);
		const seen = new Set<string>();
		let moved = false;
		for (const [from, to] of ranges) {
			const slice = await readSlice(client, { county, from, to }, progress, signal, opts);
			for (const r of slice.records) {
				if (seen.has(r.id)) {
					moved = true;
					why = `record ${r.id} turned up in two months`;
					break;
				}
				seen.add(r.id);
				agg.add(r);
			}
			if (moved) break;
		}
		if (!moved) return agg;
	}
	throw new ArtskartError(`Artskart county ${county} kept changing while read (${why}); try again later`, true);
}
