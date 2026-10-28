/**
 * Which 2024 counties to read for an app county, and paging through them
 * (td-eec7db Phase 2, plan steps 1–2).
 */
import { MIN_STATE_RECORDS, PAGE_SIZE, REGION_TO_GADM, SEARCH_CAP } from './config';
import { GbifClient, GbifError, type SearchPage } from './gbif';
import { GroupAggregate, addDays, normalizeState, type Window } from './aggregate';
import { compactRecord, type CompactRecord } from './records';

export interface StateGroup {
	/** The spelling with the most records, e.g. "Trøndelag". */
	name: string;
	/** Every spelling GBIF uses for it (filters are exact). */
	variants: string[];
	/** The app county's GADM-placed records in this group. */
	inRegion: number;
}

/**
 * Plan step 1: the 2024 counties holding at least MIN_STATE_RECORDS of the
 * app county's GADM-placed records, with every spelling of each.
 */
export async function planGroups(gbif: GbifClient, region: string, w: Window, signal: AbortSignal): Promise<StateGroup[]> {
	const gid = REGION_TO_GADM[region];
	if (!gid) throw new GbifError(`No GADM county is mapped to ${region}`, false);
	const eventDate = `${w.start},${w.through}`;
	const [inRegion, everywhere] = await Promise.all([
		gbif.facet('stateProvince', { gadmLevel1Gid: gid, eventDate }, signal),
		gbif.facet('stateProvince', { eventDate }, signal)
	]);
	const byNorm = new Map<string, { variants: Map<string, number>; inRegion: number }>();
	const entry = (name: string) => {
		const k = normalizeState(name);
		let e = byNorm.get(k);
		if (!e) byNorm.set(k, (e = { variants: new Map(), inRegion: 0 }));
		return e;
	};
	for (const f of everywhere) entry(f.name).variants.set(f.name, f.count);
	for (const f of inRegion) {
		const e = entry(f.name);
		e.inRegion += f.count;
		if (!e.variants.has(f.name)) e.variants.set(f.name, f.count);
	}
	return [...byNorm.values()]
		.filter((e) => e.inRegion >= MIN_STATE_RECORDS)
		.map((e) => {
			const variants = [...e.variants.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
			return { name: variants[0][0], variants: variants.map((v) => v[0]).sort(), inRegion: e.inRegion };
		})
		.sort((a, b) => b.inRegion - a.inRegion || a.name.localeCompare(b.name));
}

interface Slice {
	stateProvince: string;
	from: string;
	to: string;
	count: number;
}

/** Calendar months from `start` through `through`, clipped to them. */
export function monthRanges(start: string, through: string): [string, string][] {
	const out: [string, string][] = [];
	let from = start;
	while (from <= through) {
		const d = new Date(`${from}T00:00:00Z`);
		const monthEnd = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
		out.push([from, monthEnd < through ? monthEnd : through]);
		from = addDays(monthEnd, 1);
	}
	return out;
}

function daysBetween(from: string, to: string): number {
	return Math.round((new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86_400_000) + 1;
}

/**
 * Run `run` over `items` with at most `n` in flight. The first error aborts
 * the signal every run was given, so work beside it stops too, and is the
 * error thrown once all runs have settled.
 */
export async function pool<T>(items: T[], n: number, run: (item: T, signal: AbortSignal) => Promise<void>, signal: AbortSignal): Promise<void> {
	const ctl = new AbortController();
	const onAbort = () => ctl.abort(signal.reason);
	if (signal.aborted) onAbort();
	else signal.addEventListener('abort', onAbort, { once: true });
	let next = 0;
	let failed: { err: unknown } | null = null;
	const worker = async () => {
		while (!failed && next < items.length) {
			if (ctl.signal.aborted) throw ctl.signal.reason;
			const item = items[next++];
			try {
				await run(item, ctl.signal);
			} catch (err) {
				if (!failed) {
					failed = { err };
					ctl.abort(err);
				}
				throw err;
			}
		}
	};
	try {
		await Promise.allSettled(Array.from({ length: Math.min(n, items.length) }, worker));
		if (failed) throw (failed as { err: unknown }).err;
		if (signal.aborted) throw signal.reason;
	} finally {
		signal.removeEventListener('abort', onAbort);
	}
}

export interface FetchProgress {
	pagesDone: number;
	pagesTotal: number;
}

/** Reads of one slice, and of a whole group, before the load fails as retryable. */
const SLICE_TRIES = 3;
const GROUP_TRIES = 3;

/**
 * Plan step 2: page every record of a group in the window (and up to today,
 * for recent reports). Each slice is a month, halved while it holds more
 * than `searchCap` records (finding 14).
 *
 * A slice counts only once it reads back whole: every page gives the same
 * count as its first page, and the distinct records read equal that count.
 * Until then its records wait in the slice's own buffer, so a slice that
 * changed while it was read (GBIF re-indexing) is read again from scratch,
 * split again if it grew past the cap, and nothing from the bad read is
 * counted. After SLICE_TRIES reads the load fails as retryable.
 *
 * A record can also move into a slice already read (its date changed). The
 * group is read again from scratch when a record turns up in two slices
 * other than an interval with the same event date and spelling both times
 * (moves that balance out leave every count unchanged), or when,
 * once every slice is counted, any slice's count asked for again (count
 * only) has changed. After GROUP_TRIES the load fails as retryable. This
 * catches every change that shows in counts or keys, not every possible
 * one: GBIF offers no snapshot to page through.
 */
export async function fetchGroup(
	gbif: GbifClient,
	group: StateGroup,
	w: Window,
	progress: FetchProgress,
	signal: AbortSignal,
	opts: { concurrency?: number; pageSize?: number; searchCap?: number } = {}
): Promise<GroupAggregate> {
	const concurrency = opts.concurrency ?? 2;
	const pageSize = opts.pageSize ?? PAGE_SIZE;
	const searchCap = opts.searchCap ?? SEARCH_CAP;
	const search = (s: Slice, offset: number, limit: number, sig: AbortSignal) =>
		gbif.search({ stateProvince: s.stateProvince, eventDate: `${s.from},${s.to}` }, offset, limit, sig);

	/**
	 * A slice's first page, halving it until it fits under the cap. Returns
	 * the slices that fit, each with its first page.
	 */
	const plan = async (stateProvince: string, from: string, to: string, sig: AbortSignal): Promise<{ slice: Slice; first: SearchPage }[]> => {
		const slice = { stateProvince, from, to, count: 0 };
		progress.pagesTotal++;
		const first = await search(slice, 0, pageSize, sig);
		progress.pagesDone++;
		if (first.count > searchCap) {
			const days = daysBetween(from, to);
			if (days <= 1) throw new GbifError(`More than ${searchCap} records on one day (${stateProvince} ${from})`, false);
			const mid = addDays(from, Math.floor(days / 2) - 1);
			return [...(await plan(stateProvince, from, mid, sig)), ...(await plan(stateProvince, addDays(mid, 1), to, sig))];
		}
		slice.count = first.count;
		progress.pagesTotal += Math.max(0, Math.ceil(first.count / pageSize) - 1);
		return [{ slice, first }];
	};

	/** One read of the whole group. */
	interface Round {
		agg: GroupAggregate;
		/** Records counted again from another slice with a different date: they moved. */
		moved: number;
		/** Each interval record's first sighting: the spelling read and its event date. */
		ranges: Map<number, string>;
	}

	/** Read one slice whole and count it into the round, or fail. Returns the slices counted. */
	const read = async (round: Round, slice: Slice, first: SearchPage | null, sig: AbortSignal): Promise<Slice[]> => {
		let problem = '';
		for (let attempt = 1; attempt <= SLICE_TRIES; attempt++) {
			if (!first) {
				const parts = await plan(slice.stateProvince, slice.from, slice.to, sig);
				if (parts.length > 1) {
					// It grew past the cap: read each half on its own.
					const counted: Slice[] = [];
					for (const p of parts) counted.push(...(await read(round, p.slice, p.first, sig)));
					return counted;
				}
				({ slice, first } = parts[0]);
			}
			// Records by key; a record without a key is kept by its position.
			const buffer = new Map<number | string, CompactRecord | null>();
			const take = (results: unknown[], offset: number) =>
				results.forEach((raw, i) => {
					const r = compactRecord(raw);
					if (typeof r !== 'string') return void buffer.set(r.key, r);
					const key = (raw as { key?: unknown } | null)?.key;
					buffer.set(typeof key === 'number' ? key : `offset:${offset + i}`, null);
				});
			take(first.results, 0);
			let changed = false;
			let offset = pageSize;
			for (; offset < slice.count && !changed; offset += pageSize) {
				const page = await search(slice, offset, pageSize, sig);
				progress.pagesDone++;
				if (page.count !== slice.count) changed = true;
				else take(page.results, offset);
			}
			// Pages a changed read never got to.
			progress.pagesTotal -= Math.max(0, Math.ceil((slice.count - offset) / pageSize));
			if (!changed && buffer.size === slice.count) {
				for (const r of buffer.values()) {
					if (!r) {
						round.agg.stats.skipped++;
						continue;
					}
					// An interval rightly matches two date slices of one spelling, never two spellings.
					const seenAs = r.range ? `${slice.stateProvince}\u0000${r.range}` : null;
					if (round.agg.add(r)) {
						if (seenAs) round.ranges.set(r.key, seenAs);
					} else if (!seenAs || round.ranges.get(r.key) !== seenAs) {
						round.moved++;
					}
				}
				return [slice];
			}
			problem = changed ? `its count changed from ${slice.count}` : `${buffer.size} of ${slice.count} records`;
			first = null;
		}
		throw new GbifError(`GBIF kept changing while reading ${slice.stateProvince} ${slice.from}–${slice.to} (${problem})`, true);
	};

	const ranges = group.variants.flatMap((v) => monthRanges(w.start, w.through).map(([from, to]) => ({ v, from, to })));
	let problem = '';
	for (let attempt = 1; attempt <= GROUP_TRIES; attempt++) {
		const round: Round = { agg: new GroupAggregate(group.name, group.variants, w), moved: 0, ranges: new Map() };
		// Plan every slice first (their first pages are kept), so the page
		// total is known before the long read starts; then read up to
		// `concurrency` slices at once, each page by page.
		progress.pagesTotal += ranges.length;
		const planned: { slice: Slice; first: SearchPage }[] = [];
		await pool(ranges, concurrency, async ({ v, from, to }, sig) => {
			progress.pagesTotal--;
			planned.push(...(await plan(v, from, to, sig)));
		}, signal);
		planned.sort((a, b) => a.slice.stateProvince.localeCompare(b.slice.stateProvince) || a.slice.from.localeCompare(b.slice.from));
		const counted: Slice[] = [];
		await pool(planned, concurrency, async (p, sig) => void counted.push(...(await read(round, p.slice, p.first, sig))), signal);
		if (round.moved > 0) {
			// Moves can balance out, leaving every slice's count unchanged.
			problem = `${round.moved} records were found in two date slices with different dates`;
			continue;
		}

		// Every slice again, count only: has a record moved into or out of one already read?
		progress.pagesTotal += counted.length;
		const moved: Slice[] = [];
		await pool(counted, concurrency, async (s, sig) => {
			const now = await search(s, 0, 0, sig);
			progress.pagesDone++;
			if (now.count !== s.count) moved.push({ ...s, count: now.count });
		}, signal);
		if (moved.length === 0) return round.agg.sealed();
		const m = moved[0];
		problem = `${moved.length} slices changed after they were read, e.g. ${m.stateProvince} ${m.from}–${m.to}`;
	}
	throw new GbifError(`GBIF kept changing while reading ${group.name} (${problem})`, true);
}
