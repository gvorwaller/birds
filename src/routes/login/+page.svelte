<script lang="ts">
	import { enhance } from '$app/forms';
	import type { ActionData } from './$types';

	let { form }: { form: ActionData } = $props();
	let submitting = $state(false);
</script>

<svelte:head>
	<title>Sign in — birds</title>
</svelte:head>

<div class="login">
	<div class="card">
		<h1>🪶 birds</h1>
		<p class="subtitle">Sign in to continue.</p>

		<form
			method="POST"
			action="?/login"
			use:enhance={() => {
				submitting = true;
				return async ({ update }) => {
					await update();
					submitting = false;
				};
			}}
			novalidate
		>
			<label>
				<span>Username</span>
				<input
					type="text"
					name="username"
					autocomplete="username"
					autocapitalize="none"
					autocorrect="off"
					spellcheck="false"
					required
					value={form?.username ?? ''}
				/>
			</label>

			<label>
				<span>Password</span>
				<input type="password" name="password" autocomplete="current-password" required />
			</label>

			{#if form?.error}
				<p class="error" role="alert">{form.error}</p>
			{/if}

			<button type="submit" disabled={submitting}>
				{submitting ? 'Signing in…' : 'Sign in'}
			</button>
		</form>
	</div>
</div>

<style>
	.login {
		max-width: 400px;
		margin: 0 auto;
		min-height: 100vh;
		display: grid;
		place-items: center;
		padding: 1.5rem 1rem;
	}
	.card {
		width: 100%;
		background: var(--card);
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 2rem 1.5rem;
	}
	h1 {
		font-size: 1.5rem;
		margin: 0 0 0.25rem;
	}
	.subtitle {
		color: var(--muted);
		font-size: 0.9rem;
		margin: 0 0 1.5rem;
	}
	form {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}
	label {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}
	label span {
		font-size: 0.8rem;
		font-weight: 600;
		color: var(--muted);
	}
	input {
		min-height: 48px;
		padding: 0.5rem 0.75rem;
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: 8px;
		color: var(--text);
	}
	input:focus {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
		background: var(--card);
	}
	.error {
		color: var(--danger);
		font-size: 0.85rem;
		margin: -0.25rem 0 0;
	}
	button {
		margin-top: 0.5rem;
		min-height: 48px;
		background: var(--accent);
		color: #fff;
		border: none;
		border-radius: 8px;
		font-size: 0.95rem;
		font-weight: 600;
	}
	button:disabled {
		opacity: 0.5;
		cursor: default;
	}
	button:hover:not(:disabled) {
		background: #07472f;
	}
</style>
