<script lang="ts">
  import { enhance } from "$app/forms";
  import { viewedDate } from "$lib/species-views";
  import ViewedBadge from "$components/ViewedBadge.svelte";
  import type { PageData, ActionData } from "./$types";
  let { data, form }: { data: PageData; form: ActionData } = $props();
  let dialog: HTMLDialogElement;
  const returnTo = $derived(
    encodeURIComponent(
      "/viewed?" + new URLSearchParams({ q: data.q, sort: data.sort }),
    ),
  );
</script>

<svelte:head><title>Viewed species — birds</title></svelte:head>
<div class="page">
  <header class="page-head">
    <a href="/species">← Field guide</a>
    <h1>Viewed species</h1>
    <p class="sub">
      Species pages you have opened in this account. Viewing a page is separate
      from seeing a bird in the field.
    </p>
  </header>
  <section class="card">
    <div class="controls">
      <p>Recording is <strong>{data.enabled ? "on" : "paused"}</strong>.</p>
      <form method="POST" action="?/tracking" use:enhance>
        <input type="hidden" name="accountId" value={data.accountId} />
        <input type="hidden" name="enabled" value={String(!data.enabled)} />
        <button type="submit"
          >{data.enabled ? "Pause recording" : "Resume recording"}</button
        >
      </form>
      <button type="button" onclick={() => dialog.showModal()}
        >Clear history…</button
      >
    </div>
    <p class="muted">
      History starts with visits recorded after this feature was added. Pausing
      keeps your existing history.
    </p>
    {#if form?.error}<p role="alert">{form.error}</p>{/if}
    {#if form?.message}<p role="status">{form.message}</p>{/if}
    <form method="GET" action="/viewed" class="filters">
      <label
        >Search viewed species<input
          type="search"
          name="q"
          value={data.q}
          placeholder="Name or species code"
        /></label
      >
      <label class="sort"
        >Sort<select name="sort" value={data.sort}
          ><option value="recent">Most recently viewed</option><option
            value="name">Alphabetical</option
          ></select
        ></label
      >
      <button type="submit">Apply</button>
    </form>
  </section>
  <section class="card">
    <h2>
      {data.rows.length} viewed species{data.q ? " matching your search" : ""}
    </h2>
    {#if !data.rows.length}
      <p>
        {data.q
          ? "No viewed species match this search."
          : "No species recorded yet. Open a species page in Field Guide to start exploring."}
      </p>
      <a href={data.q ? "/viewed" : "/species"}
        >{data.q ? "Clear search" : "Explore Field guide"}</a
      >
    {:else}
      <ul class="viewed-list">
        {#each data.rows as row (row.code)}
          <li>
            <div class="name">
              {#if row.current}<a
                  href={`/species/${row.code}?returnTo=${returnTo}`}
                  >{row.name}</a
                >
              {:else}<strong>{row.name ?? row.code}</strong><span class="muted"
                  >Not in the current species taxonomy</span
                >{/if}
              <ViewedBadge view={row} />
            </div>
            {#if row.scientificName}<em>{row.scientificName}</em>{/if}
            <p class="dates">
              First viewed {viewedDate(row.firstViewedAt)}<br />Last viewed {viewedDate(
                row.lastViewedAt,
              )}
            </p>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
  <p class="muted">
    Species names: <a href="https://ebird.org" target="_blank" rel="noopener"
      >Data from eBird.org</a
    >.
  </p>
</div>
<dialog bind:this={dialog} aria-labelledby="clear-title">
  <h2 id="clear-title">Clear your viewing history?</h2>
  <p>
    This removes the viewed species and dates for your account. Your life list
    is unchanged. {data.enabled
      ? "Future visits will start a new history unless you pause recording."
      : "Recording will stay paused."}
  </p>
  <form
    method="POST"
    action="?/clear"
    use:enhance={() =>
      async ({ result, update }) => {
        await update();
        if (result.type === "success") dialog.close();
      }}
  >
    <input type="hidden" name="accountId" value={data.accountId} />
    <input type="hidden" name="confirm" value="clear" />
    <div class="controls">
      <button type="button" onclick={() => dialog.close()}>Cancel</button
      ><button type="submit">Clear my history</button>
    </div>
  </form>
</dialog>

<style>
  .page {
    max-width: 860px;
    margin: 0 auto;
    padding: 16px;
  }
  .page-head {
    margin: 4px 0 16px;
  }
  h1 {
    font-size: 1.4rem;
  }
  h2 {
    font-size: 1.1rem;
    margin-bottom: 12px;
  }
  .sub,
  .muted {
    color: var(--muted);
    font-size: 0.89rem;
  }
  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px;
    margin-bottom: 12px;
  }
  button {
    padding: 10px 14px;
    border: 1px solid var(--accent);
    border-radius: 8px;
    background: var(--accent);
    color: var(--on-accent);
    font-weight: 600;
    font-size: 1rem;
    cursor: pointer;
  }
  button[type="button"] {
    background: var(--card);
    color: var(--text);
    border-color: var(--border);
  }
  .controls,
  .filters,
  .name {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
  }
  .filters {
    align-items: end;
    margin-top: 16px;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 6px;
    flex: 1 1 220px;
    min-width: 0;
  }
  input,
  select {
    width: 100%;
    min-height: 48px;
    font-size: 1rem;
    padding: 8px 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg);
    color: var(--text);
    appearance: none;
  }
  .sort {
    position: relative;
  }
  select {
    padding-right: 32px;
  }
  .sort::after {
    content: "";
    position: absolute;
    right: 16px;
    bottom: 21px;
    width: 8px;
    height: 8px;
    border-right: 2px solid var(--muted);
    border-bottom: 2px solid var(--muted);
    transform: rotate(45deg);
    pointer-events: none;
  }
  button,
  .page-head > a,
  .name a {
    min-height: 48px;
    display: inline-flex;
    align-items: center;
  }
  .viewed-list {
    list-style: none;
    padding: 0;
    margin: 0;
  }
  li {
    padding: 12px 0;
    border-top: 1px solid var(--border);
    overflow-wrap: anywhere;
  }
  .dates {
    color: var(--muted);
    font-size: 0.85rem;
    margin-top: 6px;
  }
  .name a {
    font-weight: 700;
  }
  dialog {
    background: var(--card);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 12px;
    width: min(480px, calc(100% - 32px));
    padding: 24px;
  }
  dialog::backdrop {
    background: rgb(0 0 0 / 65%);
  }
</style>
