<script lang="ts">
  import { onDestroy } from "svelte";
  import type {
    StudyCountry,
    StudySpecies,
    StudyStatus,
  } from "$lib/species-study";
  import StudySpeciesList from "./StudySpeciesList.svelte";
  let {
    country,
    status,
    q,
    sort,
    accountId,
    returnTo,
    initiallyOpen = false,
    focusCode = "",
  }: {
    country: StudyCountry;
    status: StudyStatus;
    q: string;
    sort: string;
    accountId: number;
    returnTo: string;
    initiallyOpen?: boolean;
    focusCode?: string;
  } = $props();
  let open = $state(false);
  let result = $state<
    (Omit<StudyCountry, "code" | "name"> & { rows: StudySpecies[] }) | null
  >(null);
  let message = $state("");
  let busy = $state(false);
  let controller: AbortController | undefined;
  let alive = true;
  const coverage = $derived(result ?? country);
  onDestroy(() => {
    alive = false;
    controller?.abort();
  });
  async function load() {
    if (busy || !country.sourceCount) return;
    busy = true;
    message = "";
    controller = new AbortController();
    const timeout = setTimeout(() => controller?.abort(), 20000);
    try {
      const params = new URLSearchParams({
        country: country.code,
        status,
        q,
        sort,
        accountId: String(accountId),
      });
      const response = await fetch("/api/species-study?" + params, {
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("Country unavailable");
      const saved = await response.json();
      if (alive) result = saved;
    } catch {
      if (alive) message = "Could not load this country. Please retry.";
    } finally {
      clearTimeout(timeout);
      if (alive) busy = false;
    }
  }
</script>

<details
  id={"study-country-" + country.code}
  open={initiallyOpen || open}
  ontoggle={(event) => {
    open = event.currentTarget.open;
    if (!open) initiallyOpen = false;
    if (open && !result && !message) void load();
  }}
>
  <summary
    >{country.name}
    <span
      >{coverage.sourceCount === 0
        ? "No data loaded"
        : result
          ? `${result.rows.length} species`
          : "Open to load species"}</span
    ></summary
  >
  {#if open}
    {#if coverage.sourceCount === 0}
      <p class="muted">
        No historical data is loaded for this country. This does not mean birds
        are absent.
      </p>
    {:else}
      <p class="muted">
        Reported in loaded data · {coverage.beginYear}–{coverage.endYear} · any month.
        {#if !coverage.wholeArea}Coverage comes from {coverage.sourceCount} loaded
          areas and hotspots, not the entire country.{/if}
      </p>
      {#if busy}<p role="status">Loading species…</p>{/if}
      {#if message}<p role="alert">{message}</p>
        <button type="button" onclick={load}>Retry</button>{/if}
      {#if result}
        {#if result.rows.length}
          <StudySpeciesList
            rows={result.rows}
            returnTo={returnTo +
              "&country=" +
              country.code +
              "#study-country-" +
              country.code}
            {focusCode}
          />
        {:else}<p>
            No {status === "viewed" ? "viewed" : "not-yet-viewed"} species{q
              ? " matching your search"
              : ""} are reported in this country's loaded data.
          </p>{/if}
      {/if}
    {/if}
  {/if}
</details>

<style>
  details {
    border-top: 1px solid var(--border);
    scroll-margin-top: 72px;
  }
  summary {
    padding: 12px 0;
    min-height: 48px;
    cursor: pointer;
    font-weight: 700;
    overflow-wrap: anywhere;
  }
  summary span {
    font-weight: 400;
    color: var(--muted);
    font-size: 0.85rem;
    margin-left: 8px;
  }
  .muted {
    color: var(--muted);
    font-size: 0.85rem;
    margin-bottom: 12px;
  }
  button {
    min-height: 48px;
    padding: 10px 14px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--card);
    color: var(--text);
    font-size: 1rem;
  }
</style>
