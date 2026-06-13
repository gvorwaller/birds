import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { findUserByUsername, recordLogin, verifyPassword } from '$server/auth';
import { createSession, destroySession, SESSION_COOKIE_NAME } from '$server/session';
import { SESSION_COOKIE_OPTS } from '../../hooks.server';

const DUMMY_HASH =
	'$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function safeReturnTo(value: string | null): string | null {
	if (!value) return null;
	if (!value.startsWith('/')) return null;
	if (value.startsWith('//')) return null;
	if (value === '/login') return null;
	return value;
}

export const load: PageServerLoad = ({ locals, url }) => {
	if (locals.user) {
		const returnTo = safeReturnTo(url.searchParams.get('returnTo'));
		throw redirect(303, returnTo ?? '/');
	}
	return {};
};

export const actions: Actions = {
	login: async ({ cookies, request, url }) => {
		const form = await request.formData();
		const username = (form.get('username') ?? '').toString().trim().toLowerCase();
		const password = (form.get('password') ?? '').toString();

		if (!username || !password) {
			return fail(400, { username, error: 'Enter a username and password.' });
		}

		const user = await findUserByUsername(username);
		if (!user) {
			await verifyPassword(DUMMY_HASH, password);
			return fail(401, { username, error: 'Username or password is incorrect.' });
		}

		const ok = await verifyPassword(user.password_hash, password);
		if (!ok) {
			return fail(401, { username, error: 'Username or password is incorrect.' });
		}

		await recordLogin(user.id);
		const sessionId = await createSession(user.id);
		cookies.set(SESSION_COOKIE_NAME, sessionId, SESSION_COOKIE_OPTS);

		const returnTo = safeReturnTo(url.searchParams.get('returnTo'));
		throw redirect(303, returnTo ?? '/');
	},

	logout: async ({ cookies }) => {
		const token = cookies.get(SESSION_COOKIE_NAME);
		if (token) {
			await destroySession(token);
			cookies.delete(SESSION_COOKIE_NAME, { path: '/' });
		}
		throw redirect(303, '/login');
	}
};
