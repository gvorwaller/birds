/**
 * Every report of a county, kept on disk while the county is read (td-769300).
 *
 * Records are not held in memory: Rogaland, the largest county, has 2.9×
 * Nordland's reports, and the connector already peaked at 487 MB reading it
 * (config.ts). A county is read again from scratch when a record moves
 * between months, so `reset()` empties the file for each read. Once the read
 * is whole, `chunks()` streams the file back as contract chunks.
 */
import { closeSync, mkdtempSync, openSync, rmSync, writeSync, createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { MAX_ROWS_PER_CHUNK, rowsDigest, type RecordRow } from '$server/external-sources/contract';
import type { Chunk } from './payload';

/** Lines are written in blocks of about this size. */
const FLUSH_BYTES = 1024 * 1024;

export class RecordSpool {
	private readonly dir: string;
	private readonly file: string;
	private fd: number | null = null;
	private pending: string[] = [];
	private pendingBytes = 0;
	rows = 0;
	bytes = 0;

	constructor(parent = tmpdir()) {
		this.dir = mkdtempSync(join(parent, 'birds-records-'));
		this.file = join(this.dir, 'records.jsonl');
		this.reset();
	}

	/** Start again with an empty file (a new read of the county). */
	reset(): void {
		if (this.fd !== null) closeSync(this.fd);
		this.fd = openSync(this.file, 'w', 0o600);
		this.pending = [];
		this.pendingBytes = 0;
		this.rows = 0;
		this.bytes = 0;
	}

	write(row: RecordRow): void {
		if (this.fd === null) throw new Error('The record spool is closed');
		const line = `${JSON.stringify(row)}\n`;
		this.pending.push(line);
		this.pendingBytes += Buffer.byteLength(line);
		this.rows++;
		if (this.pendingBytes >= FLUSH_BYTES) this.flush();
	}

	private flush(): void {
		if (this.fd === null || this.pending.length === 0) return;
		writeSync(this.fd, this.pending.join(''));
		this.bytes += this.pendingBytes;
		this.pending = [];
		this.pendingBytes = 0;
	}

	/**
	 * The spooled records as chunks `records-<n>`, under the byte target and
	 * the row cap, in the order they were written. Nothing is written after.
	 */
	async *chunks(targetBytes: number): AsyncGenerator<Chunk> {
		this.flush();
		if (this.fd !== null) closeSync(this.fd);
		this.fd = null;
		const input = createReadStream(this.file, { encoding: 'utf8' });
		const lines = createInterface({ input, crlfDelay: Infinity });
		let current: unknown[] = [];
		let size = 0;
		let n = 0;
		const make = (): Chunk => {
			const rows = current;
			current = [];
			size = 0;
			return { chunk_id: `records-${++n}`, kind: 'records', rows: rows.length, sha256: rowsDigest(rows), rowData: rows };
		};
		try {
			for await (const line of lines) {
				if (line === '') continue;
				const bytes = Buffer.byteLength(line) + 1;
				if (current.length > 0 && (size + bytes > targetBytes || current.length >= MAX_ROWS_PER_CHUNK)) yield make();
				current.push(JSON.parse(line));
				size += bytes;
			}
			if (current.length > 0) yield make();
		} finally {
			// A send that fails mid-file leaves this generator early. Node 22 and
			// 24 already release the file when readline's loop is left (probe on
			// real files, 2026-10-28); this does it explicitly rather than rely on
			// that (CODEX1 td-769300 F1).
			lines.close();
			input.destroy();
		}
	}

	/** Remove the file and its folder; safe to call more than once. */
	close(): void {
		if (this.fd !== null) closeSync(this.fd);
		this.fd = null;
		rmSync(this.dir, { recursive: true, force: true });
	}
}
