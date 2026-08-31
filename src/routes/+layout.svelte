<script lang="ts">
	import '../app.css';
	import { afterNavigate } from '$app/navigation';
	import { page } from '$app/stores';
	import NavProgress from '$components/NavProgress.svelte';
	import { jobsPoll } from '$lib/job-poll.svelte';
	import { isFieldGuideActive } from '$lib/field-guide-nav';
	import type { LayoutData } from './$types';

	let { data, children }: { data: LayoutData; children: import('svelte').Snippet } = $props();

	let menuOpen = $state(false);
	let isViewer = $derived(data.user?.role === 'viewer');

	// Background-load tracking (td-ca32f0): one app-level poller, started once
	// per session, resumes across reloads/bfcache restores. When jobs are
	// active anywhere in the app a slim chip links to the /forecast/data hub.
	$effect(() => {
		if (data.user) jobsPoll.start();
	});
	// Drains an owed page refresh (job finished while navigating/off-forecast
	// and the poller has since gone quiet) on forecast arrival — td-671082.
	afterNavigate(() => {
		if (data.user) jobsPoll.onNavigated();
	});
	const activeJob = $derived(jobsPoll.active[0] ?? null);
	const jobChipText = $derived.by(() => {
		if (!activeJob) return '';
		const extra = jobsPoll.active.length > 1 ? ` (+${jobsPoll.active.length - 1} more)` : '';
		const p = activeJob.progress;
		if (activeJob.status === 'running' && (p.unitsTotal ?? 0) > 0) {
			// Tier-1 (td-97b22e): the API always shipped startedAt; "running
			// 4 min" tells you whether to wait or walk away.
			const mins = activeJob.startedAt
				? Math.floor((Date.now() - new Date(activeJob.startedAt).getTime()) / 60_000)
				: 0;
			const dur = mins >= 1 ? ` · running ${mins} min` : '';
			return `Loading ${p.unitsDone ?? 0} of ${p.unitsTotal} — ${activeJob.displayName}${dur}${extra}`;
		}
		if (p.phase === 'waiting_retry') return `Load retrying soon — ${activeJob.displayName}${extra}`;
		return `Load queued — ${activeJob.displayName}${extra}`;
	});

	// Explicit collections, not a slice of one array: primary tabs render in the
	// top nav, the bottom nav and the drawer, while owner-only items appear in
	// the drawer alone. Slicing a combined list silently promoted whatever sat
	// at index 3 when an item was removed.
	const primaryItems = [
		{ href: '/', label: 'Home', ico: '🏠' },
		{ href: '/species', label: 'Field guide', ico: '📖' },
		{ href: '/forecast', label: 'Forecast', ico: '📅' },
		{ href: '/photos', label: 'Photos', ico: '📷' }
	];
	// Drawer-only destinations remain visible to every role.
	const drawerOnlyItems = [
		// The load/progress hub used to be reachable only from a link inside
		// the Forecast page's body copy — hard to find (GBV 2026-08-24). It's
		// also a Forecast subtab now.
		{ href: '/forecast/data', label: 'Hotspots & data', ico: '📊' },
		{ href: '/trips', label: 'Trips', ico: '🗺️' },
		{ href: '/nearest', label: 'Nearest lifers', ico: '🧭' },
		{ href: '/life', label: 'Life list', ico: '🗺️' }
	];
	const ownerMenuItems = [
		{ href: '/alerts', label: 'Alerts', ico: '🔔' },
		{ href: '/settings', label: 'Settings', ico: '⚙️' }
	];
	const adminMenuItems = [{ href: '/admin', label: 'Admin', ico: '🔧' }];

	let drawerItems = $derived(
		isViewer
			? [...primaryItems, ...drawerOnlyItems]
			: data.user?.role === 'admin'
				? [...primaryItems, ...drawerOnlyItems, ...ownerMenuItems, ...adminMenuItems]
				: [...primaryItems, ...drawerOnlyItems, ...ownerMenuItems]
	);

	/**
	 * Home opts out of hover preloading (td-d561a8 §7).
	 *
	 * `app.html` sets `preload-data="hover"` for the whole app, and a preload of
	 * a STREAMED route starts its deferred server work immediately — a discarded
	 * preload does not abort it. So once Home streams its per-species fan-out, a
	 * hover that never becomes a click would still spend 27 eBird calls. "tap"
	 * (mousedown/touchstart) keeps the head start on real presses; a cancelled
	 * press still costs one load, which the cachedFetch single-flight coalesces
	 * with the real one.
	 *
	 * Applied via this helper rather than inline so every nav that renders
	 * `primaryItems` gets it from one place — see nav-preload.test.ts, which
	 * fails if a new Home link appears without it.
	 */
	function preloadFor(href: string): 'tap' | undefined {
		return href === '/' ? 'tap' : undefined;
	}

	function isActive(href: string, path: string): boolean {
		if (href === '/') return path === '/';
		if (href === '/species') return isFieldGuideActive(path);
		// The hub is its own drawer entry, so Forecast shouldn't also light up
		// there — but it still owns /forecast/species.
		if (href === '/forecast') return path.startsWith('/forecast') && !path.startsWith('/forecast/data');
		return path.startsWith(href);
	}

	// Close the drawer whenever the route changes.
	$effect(() => {
		$page.url.pathname;
		menuOpen = false;
	});
</script>

<NavProgress />

{#if data.user}
	<nav class="top-nav">
		<button
			class="hamburger"
			aria-label="Open menu"
			aria-expanded={menuOpen}
			onclick={() => (menuOpen = true)}
		>
			<span></span><span></span><span></span>
		</button>
		<a class="brand" href="/" data-sveltekit-preload-data="tap"><span>🪶</span> birds</a>
		<div class="links">
			{#each primaryItems as item (item.href)}
				<a
					href={item.href}
					data-sveltekit-preload-data={preloadFor(item.href)}
					class:active={isActive(item.href, $page.url.pathname)}>{item.label}</a
				>
			{/each}
		</div>
		<div class="spacer"></div>
		{#if isViewer}
			<span class="ro-tag">👀 Read-only</span>
		{:else}
			<a class="settings" href="/settings" class:active={$page.url.pathname.startsWith('/settings')}
				>⚙ Settings</a
			>
		{/if}
	</nav>

	<!-- Hamburger drawer (all sizes) -->
	{#if menuOpen}
		<button class="scrim" aria-label="Close menu" onclick={() => (menuOpen = false)}></button>
		<div class="drawer" role="dialog" aria-modal="true" aria-label="Navigation">
			<div class="drawer-head">
				<span class="brand"><span>🪶</span> birds</span>
				<button class="close" aria-label="Close menu" onclick={() => (menuOpen = false)}>✕</button>
			</div>
			<nav class="drawer-links">
				{#each drawerItems as item (item.href)}
					<a
						href={item.href}
						data-sveltekit-preload-data={preloadFor(item.href)}
						class:active={isActive(item.href, $page.url.pathname)}
						onclick={() => (menuOpen = false)}
					>
						<span class="ico">{item.ico}</span>{item.label}
					</a>
				{/each}
				<!-- Reference-only Help link — drawer only (all roles), not a primary tab. -->
				<a
					href="/help"
					class:active={isActive('/help', $page.url.pathname)}
					onclick={() => (menuOpen = false)}
				>
					<span class="ico">❓</span>Help
				</a>
				<!-- Reference-only About link — drawer only (all roles), below Help -->
				<a
					href="/about"
					class:active={isActive('/about', $page.url.pathname)}
					onclick={() => (menuOpen = false)}
				>
					<span class="ico">ℹ️</span>About
				</a>
			</nav>
			<div class="drawer-foot">
				<div class="who">Signed in as {data.user.display_name}{isViewer ? ' · read-only' : ''}</div>
				<form method="POST" action="/login?/logout">
					<button type="submit" class="signout">Sign out</button>
				</form>
			</div>
		</div>
	{/if}
{/if}

<main class:with-nav={!!data.user}>
	{#if isViewer}
		<div class="ro-banner">👀 Read-only family view — exploring Gaylon's birds.</div>
	{/if}
	{#if data.user && activeJob && !$page.url.pathname.startsWith('/forecast')}
		<a class="job-chip" href="/forecast/data">⏳ {jobChipText}</a>
	{/if}
	{@render children()}
</main>

{#if data.user}
	<nav class="bottom-nav">
		{#each primaryItems as item (item.href)}
			<a
				href={item.href}
				data-sveltekit-preload-data={preloadFor(item.href)}
				class:active={isActive(item.href, $page.url.pathname)}
			>
				<span class="ico">{item.ico}</span>{item.label}
			</a>
		{/each}
		<button class="more-btn" aria-label="More" onclick={() => (menuOpen = true)}>
			<span class="ico">☰</span>More
		</button>
	</nav>
{/if}

<style>
	.top-nav {
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		z-index: 1000;
		height: var(--nav-h);
		background: rgba(255, 255, 255, 0.92);
		backdrop-filter: blur(12px);
		-webkit-backdrop-filter: blur(12px);
		border-bottom: 1px solid var(--border);
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 0 12px;
	}
	.hamburger {
		display: inline-flex;
		flex-direction: column;
		justify-content: center;
		gap: 4px;
		width: 44px;
		height: 44px;
		padding: 10px;
		background: none;
		border: none;
		border-radius: 8px;
	}
	.hamburger span {
		display: block;
		height: 2px;
		width: 100%;
		background: var(--text);
		border-radius: 2px;
	}
	.hamburger:hover {
		background: var(--bg);
	}
	.brand {
		font-weight: 700;
		color: var(--text);
		text-decoration: none;
		margin-right: 8px;
		font-size: 1rem;
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.links {
		display: none;
	}
	.links a,
	.settings {
		padding: 10px 16px;
		min-height: 44px;
		display: inline-flex;
		align-items: center;
		text-decoration: none;
		color: var(--muted);
		font-size: 0.83rem;
		font-weight: 600;
		letter-spacing: 0.03em;
		text-transform: uppercase;
		border-radius: 6px;
	}
	.links a:hover,
	.settings:hover {
		color: var(--text);
		background: var(--bg);
	}
	.links a.active,
	.settings.active {
		color: var(--accent);
		background: var(--accent-soft);
	}
	.spacer {
		flex: 1;
	}
	.settings {
		display: none;
	}
	.ro-tag {
		font-size: 0.72rem;
		font-weight: 700;
		letter-spacing: 0.03em;
		text-transform: uppercase;
		color: var(--accent);
		background: var(--accent-soft);
		padding: 6px 12px;
		border-radius: 6px;
	}
	.ro-banner {
		background: var(--accent-soft);
		color: var(--accent);
		text-align: center;
		font-size: 0.83rem;
		font-weight: 600;
		padding: 6px 12px;
	}
	.job-chip {
		display: flex;
		align-items: center;
		justify-content: center;
		min-height: 48px;
		padding: 8px 16px;
		background: var(--accent-soft);
		color: var(--accent);
		font-size: 0.85rem;
		font-weight: 600;
		text-decoration: none;
	}
	.job-chip:hover {
		text-decoration: underline;
	}

	/* Drawer */
	.scrim {
		position: fixed;
		inset: 0;
		z-index: 1100;
		background: rgba(33, 37, 41, 0.5);
		border: none;
	}
	.drawer {
		position: fixed;
		top: 0;
		left: 0;
		bottom: 0;
		z-index: 1101;
		width: 80%;
		max-width: 300px;
		background: var(--card);
		border-right: 1px solid var(--border);
		display: flex;
		flex-direction: column;
		padding-bottom: env(safe-area-inset-bottom);
		box-shadow: 2px 0 16px rgba(0, 0, 0, 0.15);
		/* Phone landscape is only ~390px tall, which is shorter than the nav
		   links plus the account footer — without this the Sign out button sits
		   below the viewport with no way to reach it. */
		overflow-y: auto;
		overscroll-behavior: contain;
	}
	.drawer-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		height: var(--nav-h);
		flex-shrink: 0;
		padding: 0 12px 0 16px;
		border-bottom: 1px solid var(--border);
	}
	.close {
		width: 44px;
		height: 44px;
		background: none;
		border: none;
		font-size: 1.2rem;
		color: var(--muted);
		border-radius: 8px;
	}
	.close:hover {
		background: var(--bg);
	}
	.drawer-links {
		display: flex;
		flex-direction: column;
		padding: 8px;
		gap: 2px;
	}
	.drawer-links a {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 14px 12px;
		min-height: 48px;
		border-radius: 8px;
		text-decoration: none;
		color: var(--text);
		font-weight: 600;
	}
	.drawer-links a .ico {
		font-size: 1.2rem;
	}
	.drawer-links a:hover {
		background: var(--bg);
	}
	.drawer-links a.active {
		background: var(--accent-soft);
		color: var(--accent);
	}
	.drawer-foot {
		margin-top: auto;
		padding: 16px;
		border-top: 1px solid var(--border);
	}
	.who {
		color: var(--muted);
		font-size: 0.83rem;
		margin-bottom: 10px;
	}
	.signout {
		width: 100%;
		min-height: 48px;
		border-radius: 8px;
		border: 1px solid #d9a5ab;
		background: var(--card);
		color: var(--danger);
		font-weight: 600;
	}
	.signout:hover {
		background: #fdf0f1;
	}

	main.with-nav {
		padding-top: var(--nav-h);
		padding-bottom: calc(var(--bottomnav-h) + env(safe-area-inset-bottom) + 16px);
	}

	/* Bottom nav (phone): primary 4 + More (opens drawer) */
	.bottom-nav {
		position: fixed;
		bottom: 0;
		left: 0;
		right: 0;
		z-index: 1000;
		background: rgba(255, 255, 255, 0.96);
		border-top: 1px solid var(--border);
		display: flex;
		padding-bottom: env(safe-area-inset-bottom);
		/* iOS Safari intermittently detached the fixed bar during URL-bar
		   collapse when a backdrop-filter layer was attached to it. The
		   96%-opaque background already supplies the intended legibility, so
		   remove that compositor trigger entirely and pin this small bar to a
		   stable layer. */
		-webkit-transform: translate3d(0, 0, 0);
		transform: translate3d(0, 0, 0);
	}
	.bottom-nav a,
	.more-btn {
		flex: 1;
		min-height: var(--bottomnav-h);
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 2px;
		text-decoration: none;
		color: var(--muted);
		font-size: 0.72rem;
		font-weight: 600;
		background: none;
		border: none;
	}
	.bottom-nav a .ico,
	.more-btn .ico {
		font-size: 1.3rem;
		line-height: 1;
	}
	.bottom-nav a.active {
		color: var(--accent);
	}

	@media (min-width: 640px) {
		.bottom-nav {
			display: none;
		}
		.links {
			display: flex;
			gap: 4px;
		}
		.settings {
			display: inline-flex;
		}
		main.with-nav {
			padding-bottom: 24px;
		}
	}
</style>
