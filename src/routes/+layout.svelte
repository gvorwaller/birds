<script lang="ts">
	import '../app.css';
	import { page } from '$app/stores';
	import type { LayoutData } from './$types';

	let { data, children }: { data: LayoutData; children: import('svelte').Snippet } = $props();

	const items = [
		{ href: '/', label: 'Home', ico: '🏠' },
		{ href: '/targets', label: 'Targets', ico: '🔭' },
		{ href: '/trips', label: 'Trips', ico: '🗺️' },
		{ href: '/photos', label: 'Photos', ico: '📷' }
	];

	function isActive(href: string, path: string): boolean {
		return href === '/' ? path === '/' : path.startsWith(href);
	}
</script>

{#if data.user}
	<nav class="top-nav">
		<a class="brand" href="/"><span>🪶</span> birds</a>
		<div class="links">
			{#each items as item (item.href)}
				<a href={item.href} class:active={isActive(item.href, $page.url.pathname)}>{item.label}</a>
			{/each}
		</div>
		<div class="spacer"></div>
		<a class="settings" href="/settings" class:active={$page.url.pathname.startsWith('/settings')}
			>⚙ Settings</a
		>
	</nav>
{/if}

<main class:with-nav={!!data.user}>
	{@render children()}
</main>

{#if data.user}
	<nav class="bottom-nav">
		{#each items as item (item.href)}
			<a href={item.href} class:active={isActive(item.href, $page.url.pathname)}>
				<span class="ico">{item.ico}</span>{item.label}
			</a>
		{/each}
	</nav>
{/if}

<style>
	/* Top nav: brand always; links appear ≥640px (phone uses bottom nav). */
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
		padding: 0 16px;
	}
	.brand {
		font-weight: 700;
		color: var(--text);
		text-decoration: none;
		margin-right: 12px;
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

	main.with-nav {
		padding-top: var(--nav-h);
		padding-bottom: calc(var(--bottomnav-h) + env(safe-area-inset-bottom) + 16px);
	}

	/* Bottom nav (phone): giftlist pattern — fixed, safe-area, ≥48px targets. */
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
	.bottom-nav a {
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
	}
	.bottom-nav a .ico {
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
		main.with-nav {
			padding-bottom: 24px;
		}
	}
</style>
