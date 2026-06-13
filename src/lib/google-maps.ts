/**
 * Browser-side Google Maps JS API loader (adapted from gaylon.photos
 * src/lib/google-maps.js). Loads the script once, then imports libraries
 * on demand. Uses the shared PUBLIC_GOOGLE_MAPS_API_KEY.
 */
const GOOGLE_MAPS_CALLBACK = '__birdsGoogleMapsLoaded__';

interface GMapsWindow {
	google?: { maps?: { importLibrary?: (name: string) => Promise<unknown> } };
	[GOOGLE_MAPS_CALLBACK]?: () => void;
}

let scriptLoadPromise: Promise<void> | null = null;
const libraryPromises = new Map<string, Promise<unknown>>();

function buildMapsUrl(apiKey: string): string {
	const params = new URLSearchParams({
		key: apiKey,
		v: 'weekly',
		loading: 'async',
		callback: GOOGLE_MAPS_CALLBACK
	});
	return `https://maps.googleapis.com/maps/api/js?${params.toString()}`;
}

function loadScript(apiKey: string): Promise<void> {
	if (typeof window === 'undefined') {
		return Promise.reject(new Error('Google Maps can only be loaded in the browser'));
	}
	const w = window as unknown as GMapsWindow;
	if (w.google?.maps?.importLibrary) return Promise.resolve();
	if (scriptLoadPromise) return scriptLoadPromise;

	scriptLoadPromise = new Promise<void>((resolve, reject) => {
		w[GOOGLE_MAPS_CALLBACK] = () => resolve();
		const script = document.createElement('script');
		script.src = buildMapsUrl(apiKey);
		script.async = true;
		script.onerror = () => {
			scriptLoadPromise = null;
			reject(new Error('Failed to load Google Maps API'));
		};
		document.head.appendChild(script);
	});
	return scriptLoadPromise;
}

async function importLibrary<T = unknown>(name: string): Promise<T> {
	const w = window as unknown as GMapsWindow;
	if (!w.google?.maps?.importLibrary) throw new Error('Google Maps not loaded');
	if (!libraryPromises.has(name)) {
		libraryPromises.set(name, w.google.maps.importLibrary(name));
	}
	return libraryPromises.get(name) as Promise<T>;
}

/** Load the script and the requested libraries; returns the google.maps namespaces. */
export async function loadGoogleMaps(
	apiKey: string,
	libraries: string[] = ['maps', 'marker']
): Promise<Record<string, unknown>> {
	if (!apiKey) throw new Error('Google Maps API key is required');
	await loadScript(apiKey);
	const loaded: Record<string, unknown> = {};
	for (const library of libraries) {
		loaded[library] = await importLibrary(library);
	}
	return loaded;
}
