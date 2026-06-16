import type { Handle } from '@sveltejs/kit';
import { redirect } from '@sveltejs/kit';
import { SESSION_COOKIE_NAME, validateSession } from '$server/session';
import { scopeOwnerId } from '$server/access';
import { dev } from '$app/environment';

export const SESSION_COOKIE_OPTS = {
	path: '/',
	httpOnly: true,
	sameSite: 'strict' as const,
	secure: !dev,
	maxAge: 60 * 60 * 24 * 30
};

const PUBLIC_PATHS = ['/login', '/api/health'];

function isPublic(path: string): boolean {
	return PUBLIC_PATHS.some((p) => path === p);
}

export const handle: Handle = async ({ event, resolve }) => {
	const token = event.cookies.get(SESSION_COOKIE_NAME);

	if (token) {
		const user = await validateSession(token);
		if (user) {
			event.locals.user = user;
			event.locals.scopeId = scopeOwnerId(user);
		} else {
			event.cookies.delete(SESSION_COOKIE_NAME, { path: '/' });
		}
	}

	const path = event.url.pathname;

	if (!isPublic(path) && !event.locals.user) {
		if (event.request.method === 'GET') {
			const returnTo = encodeURIComponent(path);
			throw redirect(303, `/login?returnTo=${returnTo}`);
		}
		return new Response(JSON.stringify({ error: 'Unauthorized' }), {
			status: 401,
			headers: { 'Content-Type': 'application/json' }
		});
	}

	// Read-only viewers: no writes, no settings (holds eBird credentials).
	if (event.locals.user?.role === 'viewer') {
		const method = event.request.method;
		// Block every mutation except logout (posts to /login?/logout).
		if (method !== 'GET' && method !== 'HEAD' && path !== '/login') {
			return new Response('Read-only viewer — this action is not allowed.', { status: 403 });
		}
		// Hide Settings entirely (it holds eBird credentials).
		if (path.startsWith('/settings')) throw redirect(303, '/');
	}

	return resolve(event);
};
