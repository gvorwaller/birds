/**
 * Chunks and manifests are shared by every connector (td-99eebf). Norway's
 * source stores observers (migration 0096).
 */
import { buildChunks as buildSharedChunks, type Chunk } from '../shared/payload';
import type { RegionPayload } from '../shared/aggregate';

export { PAYLOAD_KINDS, buildManifest, chunkRows, filterFingerprint, type Chunk } from '../shared/payload';

export function buildChunks(region: string, payload: RegionPayload): Chunk[] {
	return buildSharedChunks(region, payload, true);
}
