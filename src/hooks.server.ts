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

const PUBLIC_PATHS = ['/login', '/api/health', '/api/internal/trip-places'];
// Token-authenticated public pages: the URL token IS the credential (trip
// share links, td-8b959f follow-up). Prefix-matched; bare '/share' stays
// private (nothing lives there).
const PUBLIC_PREFIXES = ['/share/'];

/** Exported for unit tests — the public surface is worth pinning. */
export function isPublicPath(path: string): boolean {
	return (
		PUBLIC_PATHS.some((p) => path === p) || PUBLIC_PREFIXES.some((p) => path.startsWith(p))
	);
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

	if (!isPublicPath(path) && !event.locals.user) {
		// /api/* consumers are programmatic (the jobs poller) — an expired
		// session must be a machine-readable 401, never the login-page 303
		// whose HTML would masquerade as a network failure (GROK #1).
		if (path.startsWith('/api/')) {
			return new Response(JSON.stringify({ error: 'Unauthorized' }), {
				status: 401,
				headers: { 'Content-Type': 'application/json' }
			});
		}
		if (event.request.method === 'GET') {
			// Path *and* query: a logged-out deep link like
			// /targets?place=…&dist=…&back=… must survive Login with its full
			// context, otherwise the /targets compatibility redirect that runs
			// afterwards has nothing left to preserve.
			const returnTo = encodeURIComponent(`${path}${event.url.search}`);
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
		// td-0753d0: viewers may POST load_enrichment (first-time species data,
		// communal reference data — does not touch the owner's sightings).
		// Check the FIRST action param only — ?/refresh_enrichment&/load_enrichment
		// must NOT pass (SvelteKit dispatches the first slash-prefixed key).
		const firstAction = event.url.searchParams.keys().next().value;
		const isLoadEnrichment =
			method === 'POST' &&
			path.startsWith('/species/') &&
			firstAction === '/load_enrichment';
		// Block every mutation except logout and first-time species load.
		if (method !== 'GET' && method !== 'HEAD' && path !== '/login' && !isLoadEnrichment) {
			return new Response('Read-only viewer — this action is not allowed.', { status: 403 });
		}
		// Hide Settings entirely (it holds eBird credentials).
		if (path.startsWith('/settings')) throw redirect(303, '/');
	}

	const response = await resolve(event);
	// SSR responses previously carried NO Cache-Control, which let browsers
	// (Safari especially) reuse them heuristically from disk cache — stale
	// pages after data changed, and authenticated content on shared disks.
	// Every dynamic response is per-user and must never be cached; the hashed
	// /_app/immutable assets are served outside this hook and keep their
	// long-lived caching. Routes that explicitly set a policy win.
	if (!response.headers.has('cache-control')) {
		response.headers.set('cache-control', 'private, no-store');
	}
	return response;
};
