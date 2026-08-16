<script lang="ts">
	import { browser } from '$app/environment';
	import { afterNavigate, goto } from '$app/navigation';
	import { page } from '$app/state';
	import { hasIdentityParam, restoreDecision } from '$lib/forecast-restore';

	/**
	 * The two forecast modes presented as one workspace (UX doc #2): tabs named
	 * by the question they answer. Each page passes its own current query
	 * string; we remember it per mode (localStorage) so switching tabs restores
	 * the other mode's last species/place selection, and the month always
	 * carries across.
	 *
	 * Storage is read only in $effect so SSR and the first client render share
	 * a month-only href (no hydration mismatch). Private-mode setItem throws.
	 */
	let {
		mode,
		params,
		month
	}: {
		mode: 'area' | 'species';
		/** Current page's query string (no leading "?"). */
		params: string;
		month: number;
	} = $props();

	const ROUTES = { area: '/forecast', species: '/forecast/species' } as const;
	// Keys are scoped by the LOGIN identity (not the viewed data owner): on a
	// shared browser profile, one account's remembered search must neither
	// leak into nor be overwritten by another's (CODEX1 2026-08-15 #3).
	const KEY = (m: 'area' | 'species') =>
		`forecast-params-${m}-u${page.data.user?.id ?? 'anon'}`;

	let remembered = $state('');
	const other = $derived<'area' | 'species'>(mode === 'area' ? 'species' : 'area');

	$effect(() => {
		if (!browser) return;
		try {
			const sp = new URLSearchParams(params);
			const hasIdentity = !!(
				sp.get('place') ||
				sp.get('lat') ||
				sp.get('species') ||
				sp.get('q') ||
				sp.get('region') ||
				sp.get('dist')
			);
			if (hasIdentity) localStorage.setItem(KEY(mode), params);
			remembered = localStorage.getItem(KEY(other)) ?? '';
		} catch {
			// Safari private mode / blocked storage
		}
	});

	// Restore the last real search on BARE arrivals (nav link, back from
	// /forecast/data, fresh tab): reverting to the saved-home default every
	// time was maddening mid-research (GBV 2026-08-15). An explicit cleared
	// search is different — its keys are PRESENT (empty), so it wins.
	//
	// Triggered from afterNavigate, NOT a mount-time $effect (td-671082): it
	// runs once per COMPLETED navigation (including the post-hydration
	// 'enter'), so every bare arrival gets a fresh decision and the restore
	// can never race an in-flight navigation of its own making — its goto
	// fires a new afterNavigate whose decision sees identity and no-ops (the
	// loop guard). Failure modes, both covered:
	// - goto REJECTED (superseded by a user navigation): that navigation
	//   fires its own afterNavigate → fresh decision. No manual retry state.
	// - goto RESOLVED but LOST (the reproduced invalidateAll race resolves
	//   the promise while the URL stays bare, and fires NO afterNavigate):
	//   verify the URL actually gained identity; if not, retry ONCE.
	// The jobsPoll navigating-gate removes the known cause of that race; the
	// verify-retry is the belt for unknown ones.
	let retriedFor: string | null = null;
	function attemptRestore(target: string, isRetry: boolean): void {
		goto(`${ROUTES[mode]}?${target}`, { replaceState: true })
			.then(() => {
				if (hasIdentityParam(location.search)) return;
				if (isRetry || retriedFor === target) return;
				retriedFor = target;
				setTimeout(() => attemptRestore(target, true), 100);
			})
			.catch(() => {
				// Superseded — the winning navigation's afterNavigate re-decides.
			});
	}
	afterNavigate(() => {
		try {
			// Decide from the CURRENT url, never a stale prop snapshot.
			const search = page.url.search.replace(/^\?/, '');
			const d = restoreDecision(search, localStorage.getItem(KEY(mode)));
			if (!d.restore) return;
			// Same-tick goto inside afterNavigate is flaky (GROK) — defer.
			queueMicrotask(() => attemptRestore(d.target, false));
		} catch {
			// storage unavailable — bare default stands
		}
	});

	const otherHref = $derived.by(() => {
		const sp = new URLSearchParams(remembered);
		sp.set('month', String(month));
		return `${ROUTES[other]}?${sp.toString()}`;
	});

	const selfHref = $derived.by(() => {
		const sp = new URLSearchParams(params);
		sp.set('month', String(month));
		return `${ROUTES[mode]}?${sp.toString()}`;
	});
</script>

<nav class="tabs" aria-label="Forecast mode">
	<a href={mode === 'area' ? selfHref : otherHref} class:active={mode === 'area'} aria-current={mode === 'area' ? 'page' : undefined}>
		What can I see?
	</a>
	<a
		href={mode === 'species' ? selfHref : otherHref}
		class:active={mode === 'species'}
		aria-current={mode === 'species' ? 'page' : undefined}
	>
		Where can I find this bird?
	</a>
</nav>

<style>
	.tabs {
		display: flex;
		gap: 6px;
		margin-bottom: 16px;
		border-bottom: 2px solid var(--border);
	}
	a {
		flex: 1;
		text-align: center;
		padding: 12px 8px;
		min-height: 48px;
		display: flex;
		align-items: center;
		justify-content: center;
		text-decoration: none;
		color: var(--muted);
		font-weight: 600;
		font-size: 0.92rem;
		border-bottom: 3px solid transparent;
		margin-bottom: -2px;
	}
	a:hover {
		color: var(--text);
	}
	a.active {
		color: var(--accent);
		border-bottom-color: var(--accent);
	}
</style>
