// Ingest contract v1: extend the lease and report progress (td-eec7db Phase 1).
import type { RequestHandler } from './$types';
import { parseFenced, parseProgress } from '$server/external-sources/contract';
import { handleIngest, loadIdParam } from '$server/external-sources/http';
import { heartbeatLoad } from '$server/external-sources/lifecycle';

export const POST: RequestHandler = ({ request, params }) =>
	handleIngest('heartbeat', request, async (ctx) => {
		const loadId = (ctx.log.loadId = loadIdParam(params.id));
		const { fence, body } = parseFenced(ctx.body, ['progress']);
		return heartbeatLoad(ctx.connector, loadId, fence, parseProgress(body.progress));
	});
