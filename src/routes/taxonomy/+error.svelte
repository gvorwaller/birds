<script lang="ts">
  import { page } from '$app/state';
  import FieldGuideTabs from '$components/FieldGuideTabs.svelte';
</script>
<svelte:head><title>Taxonomy unavailable — birds</title></svelte:head>
<div class="page"><h1>Field guide</h1><FieldGuideTabs active="taxonomy" /><section role="alert"><h2>Could not load taxonomy</h2><p>{page.error?.message ?? 'Please try again.'}</p><button onclick={() => window.location.reload()}>Retry</button> <a href="/species">Browse species</a></section></div>
<style>
.page{max-width:960px;margin:auto;padding:16px}section{background:var(--card);border:1px solid var(--border);padding:16px;border-radius:8px}h1,h2,p{margin-bottom:16px}button,a{min-height:48px;display:inline-flex;align-items:center;padding:8px 16px;font-size:1rem}button{background:var(--accent);color:var(--on-accent);border:0;border-radius:6px}
</style>
