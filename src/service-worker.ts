/// <reference types="@sveltejs/kit" />
/// <reference lib="webworker" />
import { build, files, version } from '$service-worker';

const sw = self as unknown as ServiceWorkerGlobalScope;

const CACHE = `birds-cache-${version}`;
// Precache the built app + static files (the offline shell).
const PRECACHE = [...build, ...files];
const PRECACHE_SET = new Set(PRECACHE);

sw.addEventListener('install', (event) => {
	event.waitUntil(
		caches
			.open(CACHE)
			.then((cache) => cache.addAll(PRECACHE))
			.then(() => sw.skipWaiting())
	);
});

sw.addEventListener('activate', (event) => {
	event.waitUntil(
		(async () => {
			for (const key of await caches.keys()) {
				if (key !== CACHE) await caches.delete(key);
			}
			await sw.clients.claim();
		})()
	);
});

sw.addEventListener('fetch', (event) => {
	const req = event.request;
	if (req.method !== 'GET') return;

	const url = new URL(req.url);
	// Only handle same-origin requests — leave eBird/CDN/Google Maps alone.
	if (url.origin !== sw.location.origin) return;

	// Built/static assets: cache-first (immutable, versioned).
	if (PRECACHE_SET.has(url.pathname)) {
		event.respondWith(caches.match(req).then((cached) => cached ?? fetch(req)));
		return;
	}

	// Pages + API: network-first so online stays fresh; fall back to cache offline.
	event.respondWith(
		(async () => {
			const cache = await caches.open(CACHE);
			try {
				const res = await fetch(req);
				// Cache successful page navigations + GET API responses for offline use.
				if (res.ok && (req.mode === 'navigate' || url.pathname.startsWith('/api/'))) {
					cache.put(req, res.clone());
				}
				return res;
			} catch {
				const cached = await cache.match(req);
				if (cached) return cached;
				if (req.mode === 'navigate') {
					const home = await cache.match('/');
					if (home) return home;
				}
				return new Response('Offline and not cached.', {
					status: 503,
					headers: { 'Content-Type': 'text/plain' }
				});
			}
		})()
	);
});
