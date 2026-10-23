// Ingest contract v1: claim the next queued load (td-eec7db Phase 1).
import type { RequestHandler } from './$types';
import { parseClaim } from '$server/external-sources/contract';
import { handleIngest } from '$server/external-sources/http';
import { claimLoad } from '$server/external-sources/lifecycle';

export const POST: RequestHandler = ({ request }) =>
	handleIngest('claim', request, async (ctx) => {
		const { idempotency_key } = parseClaim(ctx.body);
		const load = await claimLoad(ctx.connector, idempotency_key);
		if (!load) return null;
		ctx.log.loadId = load.id;
		return { load };
	});
