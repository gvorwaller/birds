<script lang="ts">
  import FieldGuideTabs from "$components/FieldGuideTabs.svelte";
  import SpecialInterestToggle from "$components/SpecialInterestToggle.svelte";
  import { viewedDate } from "$lib/species-views";
  import type { PageData } from "./$types";
  let { data }: { data: PageData } = $props();
  let countHeading: HTMLHeadingElement;
  const returnTo = $derived(
    "/special-interest?" + new URLSearchParams({ q: data.q, sort: data.sort }),
  );
</script>

<svelte:head><title>Special interest — birds</title></svelte:head>
<div class="page">
  <header class="page-head">
    <h1>★ Special interest</h1>
    <p>
      Birds you want to find, photograph, revisit, or learn about. This
      collection is personal to your account.
    </p>
  </header>
  <FieldGuideTabs active="interest" />
  <section class="card">
    <form action="/special-interest" method="GET">
      <label
        >Search saved species<input
          type="search"
          name="q"
          value={data.q}
          placeholder="Name, species code, or banding code"
        /></label
      >
      <label class="sort-field"
        >Sort<select name="sort" value={data.sort}
          ><option value="name">Alphabetical</option><option value="recent"
            >Recently saved</option
          ></select
        ></label
      >
      <button type="submit">Apply</button>
    </form>
    <a class="browse" href="/species?interest=1"
      >Filter these birds in Field Guide →</a
    >
    <p class="muted">
      Save both Seen and Need birds. Selections stay here until you remove them.
    </p>
  </section>
  <section class="card">
    <h2 bind:this={countHeading} tabindex="-1" aria-live="polite">
      {data.rows.length} saved species{data.q ? " matching your search" : ""}
    </h2>
    {#if !data.rows.length}
      <p>
        {data.q
          ? "No saved species match this search."
          : "No birds saved yet. Open a species and select ☆ Special interest to keep it here."}
      </p>
      <a class="browse" href={data.q ? "/special-interest" : "/species"}
        >{data.q ? "Show all saved species" : "Browse species"}</a
      >
    {/if}
    {#each data.rows as row (`${data.accountId}:${row.code}`)}
      <article>
        <div class="bird">
          {#if row.current}
            <a
              class="species-link"
              href={`/species/${encodeURIComponent(row.code)}?returnTo=${encodeURIComponent(returnTo)}`}
              >{row.name}</a
            >
            <p class="muted"><em>{row.scientificName}</em></p>
          {:else}
            <strong>{row.name ?? row.code}</strong>
            <p>
              Unavailable in the current taxonomy. Your saved selection is
              retained.
            </p>
          {/if}
          <p class="muted">Saved {viewedDate(row.markedAt)}</p>
        </div>
        <SpecialInterestToggle
          code={row.code}
          accountId={data.accountId}
          name={row.name ?? row.code}
          initialSaved={true}
          removableOnly
          onRemoved={() => countHeading?.focus()}
        />
      </article>
    {/each}
  </section>
  <p class="muted">
    Species names and classification: <a
      href="https://ebird.org"
      target="_blank"
      rel="noopener">Data from eBird.org</a
    >.
  </p>
</div>

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
  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px;
    margin-bottom: 12px;
  }
  form {
    display: grid;
    align-items: end;
    gap: 12px;
  }
  label {
    display: grid;
    gap: 6px;
    min-width: 0;
  }
  input,
  select,
  button {
    min-height: 48px;
    min-width: 48px;
    font: inherit;
    padding: 8px 12px;
    color: var(--text);
    background: var(--card);
    border: 1px solid var(--muted);
    border-radius: 8px;
  }
  input {
    width: 100%;
    box-sizing: border-box;
  }
  select {
    appearance: none;
    padding-right: 36px;
  }
  .sort-field {
    position: relative;
  }
  .sort-field::after {
    content: "▾";
    position: absolute;
    right: 12px;
    bottom: 12px;
    pointer-events: none;
  }
  button {
    cursor: pointer;
  }
  .browse,
  .species-link {
    display: inline-flex;
    align-items: center;
    min-height: 48px;
  }
  .species-link {
    font-weight: 700;
  }
  article {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
    border-top: 1px solid var(--border);
    padding: 12px 0;
  }
  .bird {
    flex: 1;
    min-width: 200px;
    overflow-wrap: anywhere;
  }
  p {
    margin: 6px 0;
  }
  .muted {
    color: var(--muted);
    font-size: 0.89rem;
  }
  @media (min-width: 640px) {
    form {
      grid-template-columns: minmax(0, 1fr) 180px auto;
    }
  }
</style>
