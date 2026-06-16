import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { createTrip, listTrips } from '$server/trips';

export const load: PageServerLoad = async ({ locals }) => {
	return { trips: await listTrips(locals.scopeId!), canEdit: locals.user!.role !== 'viewer' };
};

export const actions: Actions = {
	create: async ({ locals, request }) => {
		const form = await request.formData();
		const name = (form.get('name') ?? '').toString().trim();
		const start = (form.get('start_date') ?? '').toString().trim() || null;
		const end = (form.get('end_date') ?? '').toString().trim() || null;
		if (!name) return fail(400, { error: 'Give the trip a name.' });
		if (start && end && end < start) {
			return fail(400, { error: 'End date is before the start date.' });
		}
		const id = await createTrip(locals.user!.id, name, start, end);
		throw redirect(303, `/trips/${id}`);
	}
};
