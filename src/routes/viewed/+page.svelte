<script lang="ts">
  import FieldGuideTabs from "$components/FieldGuideTabs.svelte";
  import { enhance } from "$app/forms";
  import { invalidate } from "$app/navigation";
  import { studyHref } from "$lib/species-study";
  import StudySpeciesList from "$components/StudySpeciesList.svelte";
  import StudyFamilyGroups from "$components/StudyFamilyGroups.svelte";
  import StudyCountryGroup from "$components/StudyCountryGroup.svelte";
  import type { PageData, ActionData } from "./$types";
  let { data, form }: { data: PageData; form: ActionData } = $props();
  let dialog: HTMLDialogElement;
  const returnTo = $derived(
    studyHref({
      q: data.q,
      sort: data.sort,
      group: data.group,
      status: data.status,
    }),
  );
  function statusChanged(event: Event) {
    const select = event.currentTarget as HTMLSelectElement;
    if (select.value === "unviewed") {
      const form = select.form!;
      (form.elements.namedItem("sort") as HTMLSelectElement).value = "name";
      (form.elements.namedItem("group") as HTMLSelectElement).value = "family";
    }
    select.form?.requestSubmit();
  }
</script>

<svelte:head><title>Viewed species — birds</title></svelte:head>
<div class="page">
  <header class="page-head">
    <a href="/species">← Field guide</a>
    <h1>📖 Field guide</h1>
    <p class="sub">
      Organize your study by what you have viewed, bird family, or country.
      Viewing a page is separate from seeing a bird in the field.
    </p>
  </header>
  <FieldGuideTabs active="viewed" />
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
      <label class="sort"
        >Study list<select
          name="status"
          value={data.status}
          onchange={statusChanged}
        >
          <option value="viewed">Viewed species</option><option value="unviewed"
            >Not yet viewed</option
          >
        </select></label
      >
      <label class="sort"
        >Group by<select name="group" value={data.group}>
          <option value="none">No grouping</option><option value="family"
            >Bird family</option
          ><option value="country">Country</option>
        </select></label
      >
      <label
        >Search species in this list<input
          type="search"
          name="q"
          value={data.q}
          placeholder="Name, species or banding code"
        /></label
      >
      <label class="sort"
        >Sort<select name="sort" value={data.sort}
          >{#if data.status === "viewed"}<option value="recent"
              >Most recently viewed</option
            >{/if}<option value="name">Alphabetical</option><option value="taxonomic" disabled={!data.taxonomyAvailable}>Taxonomic order</option></select
        ></label
      >
      <button type="submit">Apply</button>
    </form>
  </section>
  <section class="card">
    {#if !data.taxonomyAvailable}<p role="status">Taxonomic ordering awaits a taxonomy refresh.</p>{/if}
    <h2>
      {data.total}
      {data.status === "viewed"
        ? "viewed species"
        : "species not yet viewed"}{data.q ? " matching your search" : ""}
    </h2>
    {#if data.status === "unviewed"}
      <p class="study-hint muted">
        Current species with no recorded page visit in this account. Visits
        before tracking began, while paused, or since cleared are not recorded
        here. This is independent of your life list.
      </p>
    {/if}
    {#if !data.total}
      <p>
        {data.q
          ? "No species match this search in your study list."
          : data.status === "viewed"
            ? "No species recorded yet. Open a species page in Field Guide to start exploring."
            : "Every current species has a recorded view in this account."}
      </p>
      <a
        class="empty-link"
        href={data.q ? studyHref({ ...data, q: "" }) : "/species"}
        >{data.q ? "Clear search" : "Explore Field guide"}</a
      >
    {:else}
      {#key returnTo + ":" + data.accountId}
        {#if data.group === "family"}
          <p class="study-hint muted">
            Open a bird family to browse its species. Families follow taxonomic order when selected; otherwise they are alphabetical. The selected sort also applies within each family.
          </p>
          <StudyFamilyGroups
            rows={data.rows}
            taxonomic={data.sort === "taxonomic"}
            {returnTo}
            openFamily={data.openFamily}
            focusCode={data.focusCode}
          />
        {:else if data.group === "country"}
          <p class="study-hint muted">
            Only countries with species in your selected study list and search
            are shown. Counts are distinct species reported in our loaded data,
            in any month. Open a country to browse them; a species can appear in
            several countries. Missing coverage does not establish absence; this
            is not a complete range map. Species without mapped reports remain
            available in No grouping and Bird family.
          </p>
          {#await data.countryGroups}
            <p role="status">
              Finding matching countries and counting species…
            </p>
          {:then groups}
            {#if groups.unavailable}
              <p role="alert">Could not load matching countries.</p>
              <button
                type="button"
                onclick={() => invalidate("app:species-views")}
                >Retry country counts</button
              >
            {:else if !groups.countries.length}
              <p>
                No countries have mapped reports for species in this study list{data.q
                  ? " matching your search"
                  : ""}. You can still browse them with No grouping or Bird
                family.
              </p>
            {:else}
              {#each groups.countries as country (country.code)}
                <StudyCountryGroup
                  {country}
                  {returnTo}
                  status={data.status}
                  sort={data.sort}
                  q={data.q}
                  accountId={data.accountId}
                  initiallyOpen={data.openCountry === country.code}
                  focusCode={data.focusCode}
                />
              {/each}
            {/if}
          {/await}
        {:else}
          <StudySpeciesList
            rows={data.rows}
            {returnTo}
            focusCode={data.focusCode}
          />
        {/if}
      {/key}
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
  .filters {
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
  .empty-link {
    min-height: 48px;
    display: inline-flex;
    align-items: center;
  }
  .study-hint {
    margin-bottom: 12px;
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
