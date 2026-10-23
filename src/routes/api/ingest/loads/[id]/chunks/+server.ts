// Ingest contract v1: store one chunk of rows in staging (td-eec7db Phase 1).
import type { RequestHandler } from './$types';
import { parseChunkEnvelope, parseFenced } from '$server/external-sources/contract';
import { handleIngest, loadIdParam } from '$server/external-sources/http';
import { putChunk } from '$server/external-sources/lifecycle';

export const POST: RequestHandler = ({ request, params }) =>
	handleIngest('chunks', request, async (ctx) => {
		const loadId = (ctx.log.loadId = loadIdParam(params.id));
		const { fence, body } = parseFenced(ctx.body, ['chunk_id', 'kind', 'sha256', 'rows']);
		return putChunk(ctx.connector, loadId, fence, parseChunkEnvelope(body), ctx.bodyBytes);
	});
