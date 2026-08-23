/**
 * Page-level playback coordination for field-guide sample audio (plan:
 * docs/2026-08-23-field-guide-sample-media-CLAUDE.md §10a). Starting one
 * <audio> element pauses any other that's already playing, so the photo +
 * up-to-two-sounds Identification card never has two recordings overlapping.
 * Module-scoped Svelte 5 rune state — one source of truth per page load
 * (a full navigation resets it along with everything else), same pattern
 * as $lib/job-poll.svelte.ts.
 */
let activeElement = $state<HTMLAudioElement | null>(null);

/** Call from an <audio> element's `onplay` handler before it starts playing. */
export function registerPlay(el: HTMLAudioElement): void {
	if (activeElement && activeElement !== el) activeElement.pause();
	activeElement = el;
}

/** Call from an <audio> element's `onpause`/`onended` handler. */
export function registerPause(el: HTMLAudioElement): void {
	if (activeElement === el) activeElement = null;
}
