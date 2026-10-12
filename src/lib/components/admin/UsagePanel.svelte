<script lang="ts">
	/**
	 * Admin → Users tab (td-c8e6a3): how each account uses the app. One card
	 * per account — last active, days active in the last 30, whether it came
	 * back after its first day, and which sections it used. Server-rendered
	 * from the page load; refresh the page for current numbers.
	 */
	import type { UsageReport } from '$server/user-activity';
	import { USAGE_FEATURE_LABEL, type UsageFeature } from '$lib/usage-features';
	import AdminBadge from './AdminBadge.svelte';

	let { report }: { report: UsageReport } = $props();

	const fmtDate = (iso: string) =>
		new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
	/** A UTC day ("2026-10-12") as Today / Yesterday / "Oct 9, 2026". */
	function fmtDay(day: string): string {
		const today = new Date().toISOString().slice(0, 10);
		const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
		if (day === today) return 'Today';
		if (day === yesterday) return 'Yesterday';
		return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', {
			month: 'short',
			day: 'numeric',
			year: 'numeric',
			timeZone: 'UTC'
		});
	}
	const ROLE_LABEL: Record<string, string> = { admin: 'Admin', user: 'User', viewer: 'Viewer' };

	function sections(f: Partial<Record<UsageFeature, number>>): string {
		const used = (Object.entries(f) as [UsageFeature, number][]).sort(
			(a, b) => b[1] - a[1] || USAGE_FEATURE_LABEL[a[0]].localeCompare(USAGE_FEATURE_LABEL[b[0]])
		);
		return used.length
			? used.map(([k, n]) => `${USAGE_FEATURE_LABEL[k] ?? k} ${n} ${n === 1 ? 'day' : 'days'}`).join(' · ')
			: 'None in the last 30 days';
	}
</script>

<section class="card" aria-labelledby="usage-heading">
	<h2 id="usage-heading">Users</h2>
	<p class="muted">
		A day counts when the account opens any page (days are UTC). Sections show how many of the last 30
		days each was used; nothing about what was searched or viewed is kept.
		{#if report.trackingSince}
			Recorded since {fmtDay(report.trackingSince)}; before that only each account's last login is known.
		{:else}
			Nothing recorded yet; until then only each account's last login is known.
		{/if}
	</p>
	<ul class="accounts">
		{#each report.accounts as a (a.id)}
			<li id={`usage-account-${a.id}`}>
				<div class="who">
					<strong>{a.displayName}</strong>
					<span class="muted">{a.username}</span>
					<AdminBadge label={ROLE_LABEL[a.role] ?? a.role} />
					{#if a.viewsName}<span class="muted">views {a.viewsName}'s data</span>{/if}
				</div>
				<dl>
					<div>
						<dt>Last active</dt>
						<dd>
							{#if a.lastActiveDay}
								{fmtDay(a.lastActiveDay)}
							{:else if a.lastLoginAt}
								Last login {fmtDate(a.lastLoginAt)}
							{:else}
								Never signed in
							{/if}
						</dd>
					</div>
					<div>
						<dt>Days active (30 d)</dt>
						<dd>{a.activeDays30}</dd>
					</div>
					<div>
						<dt>Came back</dt>
						<dd>
							{#if a.returned}
								<AdminBadge tone="ok" label="Yes" />
							{:else if a.lastActiveDay || a.lastLoginAt}
								<AdminBadge tone="warn" label="Not yet" />
							{:else}
								—
							{/if}
						</dd>
					</div>
					<div>
						<dt>Joined</dt>
						<dd>{fmtDate(a.createdAt)}</dd>
					</div>
					<div class="wide">
						<dt>Sections (30 d)</dt>
						<dd>{sections(a.features30)}</dd>
					</div>
				</dl>
			</li>
		{/each}
	</ul>
</section>

<style>
	.accounts {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.accounts li {
		padding: 12px 0;
		border-bottom: 1px solid var(--border);
	}
	.accounts li:last-child {
		border-bottom: none;
	}
	.who {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 4px 10px;
		margin-bottom: 6px;
	}
	dl {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
		gap: 6px 16px;
		margin: 0;
	}
	dl .wide {
		grid-column: 1 / -1;
	}
	dt {
		font-size: 0.8rem;
		font-weight: 600;
		color: var(--muted);
	}
	dd {
		margin: 0;
		overflow-wrap: anywhere;
	}
</style>
