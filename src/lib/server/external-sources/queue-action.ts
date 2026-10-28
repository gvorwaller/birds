/**
 * "Load reports" from the Norway pages (td-eec7db Phase 3): any signed-in
 * non-viewer may queue a load for a region a source covers. The load is
 * requested by the signed-in user, so it shows in their job chip. One active
 * load per (source, region): asking again returns the one already queued.
 */
import { fail, type RequestEvent } from '@sveltejs/kit';
import { isRegionCode } from './contract';
import { IngestError, queueExternalLoad } from './lifecycle';

export interface ExternalQueued {
	sourceId: string;
	regionCode: string;
	created: boolean;
}

/** The form action body: fields `source_id` and `region_code`. */
export async function queueExternalLoadAction({ locals, request }: Pick<RequestEvent, 'locals' | 'request'>) {
	const user = locals.user;
	if (!user || user.role === 'viewer') {
		return fail(403, { externalError: "Viewers can't load reports.", regionCode: null as string | null });
	}
	const f = await request.formData();
	const sourceId = String(f.get('source_id') ?? '');
	const regionCode = String(f.get('region_code') ?? '');
	if (!/^[a-z0-9][a-z0-9-]{1,47}$/.test(sourceId) || !isRegionCode(regionCode)) {
		return fail(400, { externalError: 'Pick a source and a region.', regionCode: null as string | null });
	}
	try {
		const r = await queueExternalLoad({ sourceId, regionCode, requestedBy: user.id });
		const externalQueued: ExternalQueued = { sourceId, regionCode, created: r.created };
		return { externalQueued };
	} catch (err) { // stale-safe: a web form action, never under a job claim; maps refusals, rethrows the rest
		if (err instanceof IngestError) {
			return fail(err.status === 404 ? 404 : err.status === 409 ? 409 : 400, {
				externalError: err.message,
				regionCode: regionCode as string | null
			});
		}
		throw err;
	}
}
