/**
 * Reading one Swedish county from SOS (td-99eebf), one request at a time.
 *
 * The window is read in calendar-month slices, each with the one selection
 * every call of the load uses (sos.ts sliceFilter). Completeness (plan
 * [C1-2]):
 *   - SOS's Count for the month, every page's cursor total and the distinct
 *     sighting ids read must all agree (CODEX1 code review R3: a non-empty
 *     Count with an empty cursor is a failed read, never an empty month); the
 *     cursor must end (no repeated cursor, no more pages than the total
 *     allows). Ids are de-duplicated BEFORE any record is excluded, and a
 *     repeated id whose content changed (modified time, blurring,
 *     sensitivity) means the month changed under the read. A month that fails
 *     is read again from scratch, SLICE_READS times in all, then the load
 *     fails and the previous publication stays;
 *   - a month over SOS's 2M cursor cap is split into smaller date ranges
 *     before paging (CODEX1 R11); only a single day over the cap is refused;
 *   - a sighting met in two months (its start date changed mid-read) sends the
 *     whole county round again, COUNTY_READS times in all, with the record
 *     spool emptied, so nothing is counted twice;
 *   - a record outside the month asked for, or with no readable date, is a
 *     broken answer: the load fails as retryable.
 * As with Norway, two changes these checks can't see are left to the next
 * load: a report deleted and another added in the same month while it is
 * paged, and a report re-dated from a month not yet read into one already
 * read.
 *
 * Memory (plan [C1-4]): a month's records are compacted as each page arrives
 * and buffered on disk, not in the heap, until the month reads back whole;
 * only its ids stay in memory. Stockholm's May is ~97k reports.
 */
import { closeSync, createReadStream, mkdtempSync, openSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { CountyAggregate, type Window } from '../shared/aggregate';
import { monthRanges } from '../shared/months';
import type { CompactRecord } from '../shared/records';
import type { RecordSpool } from '../shared/spool';
import { COUNTY_READS, LOCALE, PAGE_SIZE, RECENT_KEEP_DAYS_SE, REGION_NAMES, SLICE_READS, SOS_CURSOR_MAX } from './config';
import { createHash } from 'node:crypto';
import { compactRecord, recordIdentity } from './records';
import { SosError, type SliceQuery, type SosClient } from './sos';

export interface FetchProgress {
	pagesDone: number;
	pagesTotal: number;
}

export interface FetchOptions {
	pageSize?: number;
	/** Where month buffers go (default: the OS temp folder). */
	bufferDir?: string;
}

/** What one month's read found, for the load's evidence. */
export interface SliceEvidence {
	from: string;
	to: string;
	/** SOS Count before the read. */
	count: number;
	/** The cursor's total, which the distinct ids matched. */
	total: number;
	pages: number;
	reads: number;
	/** Rows met again within the month (same id). */
	repeats: number;
	/** Records left out after de-duplication (not present). */
	absent: number;
}

/** A month's compact records on disk; ids in memory. */
class MonthBuffer {
	private readonly dir: string;
	private readonly file: string;
	private fd: number | null;
	private pending: string[] = [];
	private pendingBytes = 0;
	/** Sighting id → what would show it changed (modified, blurring, sensitivity). */
	readonly ids = new Map<string, string>();
	absent = 0;

	constructor(parent: string) {
		this.dir = mkdtempSync(join(parent, 'birds-se-month-'));
		this.file = join(this.dir, 'month.jsonl');
		this.fd = openSync(this.file, 'w', 0o600);
	}

	add(r: CompactRecord): void {
		const line = `${JSON.stringify(r)}\n`;
		this.pending.push(line);
		this.pendingBytes += line.length;
		if (this.pendingBytes >= 1 << 20) this.flush();
	}

	private flush(): void {
		if (this.fd === null || this.pending.length === 0) return;
		writeSync(this.fd, this.pending.join(''));
		this.pending = [];
		this.pendingBytes = 0;
	}

	async *records(): AsyncGenerator<CompactRecord> {
		this.flush();
		if (this.fd !== null) closeSync(this.fd);
		this.fd = null;
		const input = createReadStream(this.file, { encoding: 'utf8' });
		const lines = createInterface({ input, crlfDelay: Infinity });
		try {
			for await (const line of lines) if (line !== '') yield JSON.parse(line) as CompactRecord;
		} finally {
			lines.close();
			input.destroy();
		}
	}

	close(): void {
		if (this.fd !== null) closeSync(this.fd);
		this.fd = null;
		rmSync(this.dir, { recursive: true, force: true });
	}
}

/** A slice over SOS's cursor cap: split it, or refuse if it is a single day. */
export class OversizeSlice extends SosError {
	constructor(
		message: string,
		readonly count: number
	) {
		super(message, false);
		this.name = 'OversizeSlice';
	}
}

/** Two halves of a multi-day range, or null for a single day. */
export function splitRange(from: string, to: string): [[string, string], [string, string]] | null {
	if (from >= to) return null;
	const a = Date.parse(`${from}T00:00:00Z`);
	const b = Date.parse(`${to}T00:00:00Z`);
	const mid = new Date(a + Math.floor((b - a) / 86_400_000 / 2) * 86_400_000).toISOString().slice(0, 10);
	const next = new Date(Date.parse(`${mid}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
	return [
		[from, mid],
		[next, to]
	];
}

/**
 * What a repeat of the same sighting must match: everything that would be
 * published from it (CODEX1 rounds 2, 4 and 5). The digest is of the compact
 * record AFTER the privacy and presence decisions, so a repeat that changes
 * its date, its blurring or sensitivity, its presence, or any field that
 * would be published differs, with or without a new modification time.
 */
export function signatureOf(c: CompactRecord | 'absent' | 'undated'): string {
	return createHash('sha1').update(JSON.stringify(c)).digest('base64');
}

/** The signature of a raw SOS record. */
export function signature(raw: unknown): string {
	return signatureOf(compactRecord(raw));
}

/** One month, read whole; up to SLICE_READS reads. The caller closes the buffer. */
export async function readSlice(
	client: SosClient,
	q: SliceQuery,
	progress: FetchProgress,
	signal: AbortSignal,
	opts: FetchOptions = {}
): Promise<{ buffer: MonthBuffer; evidence: SliceEvidence }> {
	const take = opts.pageSize ?? PAGE_SIZE;
	const where = `Artportalen county ${q.county} ${q.from}–${q.to}`;
	let why = '';
	for (let read = 1; read <= SLICE_READS; read++) {
		const count = await client.count(q, signal);
		if (count > SOS_CURSOR_MAX) throw new OversizeSlice(`${where}: ${count} reports is over SOS's ${SOS_CURSOR_MAX} cursor limit`, count);
		const buffer = new MonthBuffer(opts.bufferDir ?? tmpdir());
		let ok = false;
		try {
			const first = await client.page(q, null, take, signal);
			if (first.total > SOS_CURSOR_MAX) throw new OversizeSlice(`${where}: ${first.total} reports is over SOS's ${SOS_CURSOR_MAX} cursor limit`, first.total);
			const maxPages = Math.ceil(first.total / take) + 2;
			progress.pagesTotal += Math.max(1, Math.ceil(first.total / take));
			const cursors = new Set<string>();
			let page = first;
			let pages = 0;
			let repeats = 0;
			let changed = false;
			for (;;) {
				pages++;
				progress.pagesDone++;
				if (page.total !== first.total) {
					changed = true;
					why = `its total changed from ${first.total} to ${page.total}`;
					break;
				}
				for (const raw of page.records) {
					const id = recordIdentity(raw);
					if (id === 'conflict') {
						// A record contradicting itself: read the month again (bounded), never guess.
						changed = true;
						why = "a record's occurrence id and catalog number disagree";
						break;
					}
					if (!id) throw new SosError(`${where}: a record has no usable sighting number`, true);
					// Every row is compacted and date-checked BEFORE the repeat check
					// (CODEX1 round 5): a repeat must never skip validation, and the
					// order of two contradictory rows must never decide the month.
					const c = compactRecord(raw);
					if (c !== 'absent' && (c === 'undated' || c.date < q.from || c.date > q.to)) {
						throw new SosError(
							`${where}: sighting ${id} has ${c === 'undated' ? 'no readable date' : `the date ${c.date}`}; not publishing a month that would lose it`,
							true
						);
					}
					const sig = signatureOf(c);
					const before = buffer.ids.get(id);
					if (before !== undefined) {
						repeats++;
						if (before !== sig) {
							changed = true;
							why = `sighting ${id} came back changed within one read`;
							break;
						}
						continue;
					}
					buffer.ids.set(id, sig);
					if (c === 'absent') {
						buffer.absent++;
						continue;
					}
					buffer.add(c);
				}
				if (changed) break;
				if (!page.next) break;
				if (cursors.has(page.next)) throw new SosError(`${where}: the cursor repeated itself`, true);
				if (pages >= maxPages) throw new SosError(`${where}: the cursor ran past ${maxPages} pages for ${first.total} reports`, true);
				cursors.add(page.next);
				page = await client.page(q, page.next, take, signal);
			}
			if (!changed && buffer.ids.size !== first.total) {
				changed = true;
				why = `${buffer.ids.size} distinct reports came back for a total of ${first.total}`;
			}
			if (!changed && count !== first.total) {
				changed = true;
				why = `SOS counted ${count} reports but the cursor listed ${first.total}`;
			}
			if (changed) continue;
			ok = true;
			return { buffer, evidence: { from: q.from, to: q.to, count, total: first.total, pages, reads: read, repeats, absent: buffer.absent } };
		} finally {
			if (!ok) buffer.close();
		}
	}
	throw new SosError(`${where} never read back whole (${why}); try again later`, true);
}

/** The whole county; up to COUNTY_READS reads when reports move between months. */
export async function readCounty(
	client: SosClient,
	regionCode: string,
	county: number,
	window: Window,
	progress: FetchProgress,
	signal: AbortSignal,
	opts: FetchOptions = {},
	spool: RecordSpool | null = null
): Promise<{ agg: CountyAggregate; evidence: SliceEvidence[] }> {
	const ranges = monthRanges(window.start, window.through);
	const name = REGION_NAMES[regionCode];
	if (!name) throw new SosError(`${regionCode} is not a Swedish county this connector reads`, false);
	let why = '';
	for (let read = 1; read <= COUNTY_READS; read++) {
		// A fresh read starts the records again too.
		spool?.reset();
		const agg = new CountyAggregate(regionCode, name, window, spool ? (row) => spool.write(row) : null, {
			sourceLabel: 'Artportalen',
			locale: LOCALE,
			recentKeepDays: RECENT_KEEP_DAYS_SE,
			strictRecent: true
		});
		const evidence: SliceEvidence[] = [];
		// Sighting numbers are integers well under 2^53: a number set is a
		// fraction of the memory of a string set at ~500k reports.
		const seen = new Set<number>();
		let moved = false;
		const queue = [...ranges];
		while (queue.length > 0) {
			const [from, to] = queue.shift()!;
			let slice: Awaited<ReturnType<typeof readSlice>>;
			try {
				slice = await readSlice(client, { county, from, to }, progress, signal, opts);
			} catch (err) {
				const halves = err instanceof OversizeSlice ? splitRange(from, to) : null;
				if (!halves) {
					if (err instanceof OversizeSlice) {
						throw new SosError(`Artportalen county ${county} has ${err.count} reports on ${from} alone, over SOS's cursor limit; this county can't be read`, false);
					}
					throw err;
				}
				queue.unshift(...halves);
				continue;
			}
			const { buffer, evidence: ev } = slice;
			try {
				evidence.push(ev);
				// Every id the month listed, absent ones too, against every month
				// before it, BEFORE any of its records is counted (CODEX1 round 3):
				// a sighting precise in April and listed again (even as absent or
				// protected) in May means it changed mid-read.
				for (const id of buffer.ids.keys()) {
					const n = Number(id);
					if (seen.has(n)) {
						moved = true;
						why = `sighting ${id} turned up in two months`;
						break;
					}
					seen.add(n);
				}
				if (!moved) for await (const r of buffer.records()) agg.add(r);
			} finally {
				buffer.close();
			}
			if (moved) break;
		}
		if (!moved) return { agg, evidence };
	}
	throw new SosError(`Artportalen county ${county} kept changing while read (${why}); try again later`, true);
}
