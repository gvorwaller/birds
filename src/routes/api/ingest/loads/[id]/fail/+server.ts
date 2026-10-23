// Ingest contract v1: give up a load, or hand it back for a retry (td-eec7db Phase 1).
import type { RequestHandler } from './$types';
import { ContractError, parseFenced } from '$server/external-sources/contract';
import { handleIngest, loadIdParam } from '$server/external-sources/http';
import { failLoad } from '$server/external-sources/lifecycle';

export const POST: RequestHandler = ({ request, params }) =>
	handleIngest('fail', request, async (ctx) => {
		const loadId = (ctx.log.loadId = loadIdParam(params.id));
		const { fence, body } = parseFenced(ctx.body, ['reason', 'retryable']);
		if (typeof body.reason !== 'string' || body.reason.length > 2000) {
			throw new ContractError('body.reason: expected text of up to 2000 characters');
		}
		if (typeof body.retryable !== 'boolean') throw new ContractError('body.retryable: expected true or false');
		return failLoad(ctx.connector, loadId, fence, body.reason, body.retryable);
	});
