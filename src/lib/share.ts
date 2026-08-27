/**
 * Web Share / standalone-PWA helpers (td-8b959f follow-up; pattern ported
 * from the ~/trips app's shipped fix).
 *
 * In the installed PWA (display: standalone) a plain navigation to a
 * download or inline text export replaces the app shell with a chrome-less
 * view that iOS gives the user no way to leave — no address bar, no Back,
 * and the SPA document is gone. Share text therefore stays in-app (modal +
 * share sheet) and the export endpoints are untouched.
 */
import { browser } from '$app/environment';

/** Installed-to-home-screen iOS, where a non-HTML navigation has no chrome. */
export function isIosStandalone(): boolean {
	if (!browser) return false;
	const nav = navigator as Navigator & { standalone?: boolean };
	const isiOS =
		/iPad|iPhone|iPod/.test(navigator.userAgent) ||
		(navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
	return (
		isiOS && (nav.standalone === true || window.matchMedia('(display-mode: standalone)').matches)
	);
}

/** Any iOS device — where downloads are awkward even in Safari, and the
 * share sheet (Save to Files / AirDrop / Messages) is the native path. */
export function isIosDevice(): boolean {
	if (!browser) return false;
	return (
		/iPad|iPhone|iPod/.test(navigator.userAgent) ||
		(navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
	);
}

/** Whether the system share sheet can take a FILE here. */
export function canShareFile(file: File): boolean {
	if (!browser) return false;
	const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
	return (
		typeof nav.share === 'function' &&
		typeof nav.canShare === 'function' &&
		nav.canShare({ files: [file] })
	);
}

/** Offer a file to the system share sheet. Same outcome contract as shareText. */
export async function shareFile(
	file: File,
	title?: string
): Promise<'shared' | 'cancelled' | 'unavailable' | 'failed'> {
	if (!canShareFile(file)) return 'unavailable';
	try {
		await navigator.share({ files: [file], title });
		return 'shared';
	} catch (err) {
		if (err instanceof DOMException && err.name === 'AbortError') return 'cancelled';
		return 'failed';
	}
}

/** Whether the system share sheet can take plain text here. */
export function canShareText(): boolean {
	if (!browser) return false;
	return typeof (navigator as Navigator & { share?: unknown }).share === 'function';
}

/**
 * Offer plain text to the system share sheet. 'cancelled' (the user closed
 * the sheet) is not an error; 'unavailable' means fall back to copy.
 */
export async function shareText(
	text: string,
	title?: string
): Promise<'shared' | 'cancelled' | 'unavailable' | 'failed'> {
	if (!canShareText()) return 'unavailable';
	try {
		await navigator.share({ text, title });
		return 'shared';
	} catch (err) {
		if (err instanceof DOMException && err.name === 'AbortError') return 'cancelled';
		return 'failed';
	}
}
