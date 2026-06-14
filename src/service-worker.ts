/// <reference types="@sveltejs/kit" />
/// <reference lib="webworker" />

// Intentionally inert. An earlier version precached the app shell + pages and
// caused stale-content / blank-screen ("500"-looking) failures on iOS Safari
// after deploys (version skew between cached client JS and the live server).
//
// This version installs over the old one, PURGES every cache, takes control,
// and never intercepts/caches requests (always network). The app stays a fast,
// reliable, installable site — just without offline page caching.
const sw = self as unknown as ServiceWorkerGlobalScope;

sw.addEventListener('install', () => {
	sw.skipWaiting();
});

sw.addEventListener('activate', (event) => {
	event.waitUntil(
		(async () => {
			for (const key of await caches.keys()) {
				await caches.delete(key);
			}
			await sw.clients.claim();
		})()
	);
});

// Network passthrough: keep a fetch handler present (installability) but never
// call respondWith, so the browser always goes to the network. No stale serving.
sw.addEventListener('fetch', () => {});
