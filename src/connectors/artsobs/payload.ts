/**
 * Turning a region's rows into contract v1 chunks and a manifest
 * (td-eec7db Phase 2 rev B). Rows are checked with the app's own contract
 * validator before anything is sent, so a bad row fails here, not after
 * minutes of paging and half a load of chunks.
 */
import { createHash } from 'node:crypto';
import {
	CHUNK_KINDS,
	MAX_ROWS_PER_CHUNK,
	canonicalJson,
	rowsDigest,
	validateChunkRows,
	type ChunkKind,
	type Manifest,
	type ManifestChunk
} from '$server/external-sources/contract';
import { CHUNK_TARGET_BYTES } from './config';
import type { RegionPayload } from './aggregate';

export interface Chunk extends ManifestChunk {
	rowData: unknown[];
}

/** Split rows into chunks under the byte target and the row cap; ids are `<kind>-<n>`. */
export function chunkRows(kind: ChunkKind, rows: unknown[], targetBytes = CHUNK_TARGET_BYTES): Chunk[] {
	const out: Chunk[] = [];
	let current: unknown[] = [];
	let bytes = 0;
	const flush = () => {
		if (current.length === 0) return;
		out.push({ chunk_id: `${kind}-${out.length + 1}`, kind, rows: current.length, sha256: rowsDigest(current), rowData: current });
		current = [];
		bytes = 0;
	};
	for (const row of rows) {
		const size = Buffer.byteLength(JSON.stringify(row)) + 1;
		if (current.length > 0 && (bytes + size > targetBytes || current.length >= MAX_ROWS_PER_CHUNK)) flush();
		current.push(row);
		bytes += size;
	}
	flush();
	return out;
}

export function buildChunks(region: string, payload: RegionPayload): Chunk[] {
	const chunks: Chunk[] = [];
	for (const kind of CHUNK_KINDS) {
		const rows = payload[kind] as unknown[];
		for (const c of chunkRows(kind, rows)) {
			// The source stores observers (migration 0096); the app checks its own flag again.
			validateChunkRows(kind, c.rowData, c.sha256, { region, storeObservers: true });
			chunks.push(c);
		}
	}
	return chunks;
}

export function filterFingerprint(filters: Record<string, unknown>): string {
	return createHash('sha256').update(canonicalJson(filters)).digest('hex');
}

export function buildManifest(
	payload: RegionPayload,
	chunks: Chunk[],
	m: Pick<Manifest, 'window_start' | 'window_end' | 'retrieved_at' | 'source_snapshot' | 'filter_fingerprint'>
): Manifest {
	const counts: Partial<Record<ChunkKind, number>> = {};
	for (const kind of CHUNK_KINDS) counts[kind] = (payload[kind] as unknown[]).length;
	return {
		...m,
		chunks: chunks.map(({ chunk_id, kind, rows, sha256 }) => ({ chunk_id, kind, rows, sha256 })),
		counts,
		places: payload.places.map((p) => p.place_key),
		months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
	};
}
