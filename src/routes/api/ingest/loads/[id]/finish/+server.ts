// Ingest contract v1: verify the manifest and publish the load (td-eec7db Phase 1).
import type { RequestHandler } from './$types';
import { parseFenced } from '$server/external-sources/contract';
import { handleIngest, loadIdParam } from '$server/external-sources/http';
import { finishLoad } from '$server/external-sources/lifecycle';

export const POST: RequestHandler = ({ request, params }) =>
	handleIngest('finish', request, async (ctx) => {
		const loadId = (ctx.log.loadId = loadIdParam(params.id));
		const { fence, body } = parseFenced(ctx.body, ['manifest']);
		return finishLoad(ctx.connector, loadId, fence, body.manifest);
	});
