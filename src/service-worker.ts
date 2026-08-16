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

// Need alerts arrive as Web Push (payloads built by src/lib/server/push.ts):
// {title, body, url?, tag?}. iOS requires showNotification for every push.
sw.addEventListener('push', (event) => {
	let data: { title?: string; body?: string; url?: string; tag?: string } = {};
	try {
		data = event.data?.json() ?? {};
	} catch {
		// Non-JSON payload — show something honest rather than dropping it.
		data = { title: 'birds', body: event.data?.text() ?? '' };
	}
	event.waitUntil(
		sw.registration.showNotification(data.title ?? 'birds', {
			body: data.body ?? '',
			tag: data.tag,
			icon: '/icon-192.png',
			badge: '/icon-192.png',
			data: { url: data.url }
		})
	);
});

sw.addEventListener('notificationclick', (event) => {
	event.notification.close();
	const url: string = event.notification.data?.url ?? '/';
	event.waitUntil(
		(async () => {
			const all = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
			for (const client of all) {
				if ('focus' in client) {
					await client.focus();
					if ('navigate' in client) await client.navigate(url);
					return;
				}
			}
			await sw.clients.openWindow(url);
		})()
	);
});
