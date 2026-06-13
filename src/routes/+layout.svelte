<script lang="ts">
	import '../app.css';
	import { page } from '$app/stores';
	import type { LayoutData } from './$types';

	let { data, children }: { data: LayoutData; children: import('svelte').Snippet } = $props();

	let menuOpen = $state(false);

	const items = [
		{ href: '/', label: 'Home', ico: '🏠' },
		{ href: '/targets', label: 'Targets', ico: '🔭' },
		{ href: '/trips', label: 'Trips', ico: '🗺️' },
		{ href: '/photos', label: 'Photos', ico: '📷' },
		{ href: '/settings', label: 'Settings', ico: '⚙️' }
	];

	function isActive(href: string, path: string): boolean {
		return href === '/' ? path === '/' : path.startsWith(href);
	}

	// Close the drawer whenever the route changes.
	$effect(() => {
		$page.url.pathname;
		menuOpen = false;
	});
</script>

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
		<a class="brand" href="/"><span>🪶</span> birds</a>
		<div class="links">
			{#each items.slice(0, 4) as item (item.href)}
				<a href={item.href} class:active={isActive(item.href, $page.url.pathname)}>{item.label}</a>
			{/each}
		</div>
		<div class="spacer"></div>
		<a class="settings" href="/settings" class:active={$page.url.pathname.startsWith('/settings')}
			>⚙ Settings</a
		>
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
				{#each items as item (item.href)}
					<a
						href={item.href}
						class:active={isActive(item.href, $page.url.pathname)}
						onclick={() => (menuOpen = false)}
					>
						<span class="ico">{item.ico}</span>{item.label}
					</a>
				{/each}
			</nav>
			<div class="drawer-foot">
				<div class="who">Signed in as {data.user.display_name}</div>
				<form method="POST" action="/login?/logout">
					<button type="submit" class="signout">Sign out</button>
				</form>
			</div>
		</div>
	{/if}
{/if}

<main class:with-nav={!!data.user}>
	{@render children()}
</main>

{#if data.user}
	<nav class="bottom-nav">
		{#each items.slice(0, 4) as item (item.href)}
			<a href={item.href} class:active={isActive(item.href, $page.url.pathname)}>
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
	}
	.drawer-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		height: var(--nav-h);
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
		backdrop-filter: blur(12px);
		-webkit-backdrop-filter: blur(12px);
		border-top: 1px solid var(--border);
		display: flex;
		padding-bottom: env(safe-area-inset-bottom);
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
