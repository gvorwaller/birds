<script lang="ts">
  import {
    chunkIds,
    comparisonComplete,
    comparisonQueryKey,
    progressForRows,
    sortedComparisonRows,
    type ComparisonFilters,
    type HotspotComparisonRow,
    type HotspotReference,
  } from "$lib/hotspot-comparison";
  import { onDestroy } from "svelte";
  import { beforeNavigate } from "$app/navigation";
  import MapLink from "$components/MapLink.svelte";
  import { formatDistance, type DistanceUnit } from "$lib/geo";
  import { withReturnTo } from "$lib/navigation-context";
  import { navigationAction } from "$lib/navigation-context.svelte";

  let {
    filters,
    distanceUnit = "mi",
    canApply = false,
    onApply = () => {},
    accountId = null,
    sourceHref = "/",
    sourceLabel = "Home",
  }: {
    filters: ComparisonFilters;
    distanceUnit?: DistanceUnit;
    canApply?: boolean;
    onApply?: (rows: HotspotComparisonRow[]) => void;
    accountId?: number | null;
    sourceHref?: string;
    sourceLabel?: string;
  } = $props();

  let refs = $state<HotspotReference[]>([]);
  let rows = $state<HotspotComparisonRow[]>([]);
  let identity = $state<string | null>(null);
  let referenceStale = $state(false);
  let status = $state<
    | "idle"
    | "loading"
    | "running"
    | "paused"
    | "complete"
    | "partial"
    | "unavailable"
  >("idle");
  let message = $state("");
  let showAll = $state(false);
  let controller = $state<AbortController | null>(null);
  let generation = 0;
  let runSerial = 0;
  let activeKey = "";

  const key = $derived(comparisonQueryKey(filters));
  const progress = $derived(progressForRows(rows));
  const complete = $derived(comparisonComplete(rows, referenceStale));
  const ranked = $derived(sortedComparisonRows(rows));
  const shown = $derived(showAll ? ranked : ranked.slice(0, 5));

  $effect(() => {
    if (key !== activeKey) {
      activeKey = key;
      generation++;
      controller?.abort();
      controller = null;
      refs = [];
      rows = [];
      identity = null;
      referenceStale = false;
      status = "idle";
      message = "";
      showAll = false;
    }
  });

  onDestroy(() => controller?.abort());
  beforeNavigate(() => {
    generation++;
    runSerial++;
    controller?.abort();
    controller = null;
  });

  function queryUrl(ids?: string[]): string {
    const p = new URLSearchParams({
      lat: String(filters.lat),
      lng: String(filters.lng),
      radiusKm: String(filters.radiusKm),
      daysBack: String(filters.daysBack),
      seenStatus: filters.seenStatus,
      rareOnly: filters.rareOnly ? "1" : "0",
      anchorLabel: filters.anchorLabel,
    });
    if (ids?.length) {
      p.set("ids", ids.join(","));
      if (identity) p.set("identity", identity);
    }
    return `/api/hotspot-comparison?${p}`;
  }

  async function get(url: string, expected: number): Promise<any | null> {
    const local = controller;
    if (!local || expected !== generation) return null;
    const res = await fetch(url, { signal: local.signal });
    const body = await res.json().catch(() => null);
    if (!body) throw new Error("Hotspot comparison is unavailable.");
    if (!res.ok && res.status !== 409)
      throw new Error(body.message ?? "Hotspot comparison is unavailable.");
    return body;
  }

  function mergeBatch(batch: HotspotComparisonRow[]) {
    const byId = new Map(rows.map((row) => [row.locId, row]));
    for (const row of batch) byId.set(row.locId, row);
    rows = refs.map(
      (ref) =>
        byId.get(ref.locId) ?? {
          ...ref,
          state: "unqueried",
          count: null,
          species: [],
          latestObsDt: null,
          fetchedAt: null,
          stale: false,
          error: null,
          token: null,
        },
    );
  }

  async function start() {
    generation++;
    const expected = generation;
    controller?.abort();
    controller = new AbortController();
    status = "loading";
    message = "Loading verified hotspot references…";
    try {
      const init = await get(queryUrl(), expected);
      if (!init || expected !== generation || (status as string) === "paused")
        return;
      if (init.status === "unavailable") {
        status = "unavailable";
        message = init.message ?? "Hotspot comparison is unavailable.";
        return;
      }
      refs = init.references ?? [];
      identity = init.identity ?? null;
      referenceStale = !!init.referenceStale;
      rows =
        init.rows ??
        refs.map((ref: HotspotReference) => ({
          ...ref,
          state: "unqueried",
          count: null,
          species: [],
          latestObsDt: null,
          fetchedAt: null,
          stale: false,
          error: null,
          token: null,
        }));
      showAll = false;
      if (refs.length === 0) {
        status = "complete";
        message = "No verified hotspots were found in this radius.";
        return;
      }
      if (init.stopScheduling) {
        status = "partial";
        message =
          "Further hotspot checks stopped because the reference refresh hit an eBird authorization or rate limit response.";
        return;
      }
      status = "running";
      message = referenceStale
        ? "Reference coverage is cached/stale; checking hotspots…"
        : "Checking every verified hotspot…";
      await runRemaining(expected, ++runSerial);
    } catch (err) {
      if (
        expected !== generation ||
        (status as string) === "paused" ||
        !controller ||
        controller.signal.aborted
      )
        return;
      status = "unavailable";
      message =
        err instanceof Error
          ? err.message
          : "Hotspot comparison is unavailable.";
    }
  }

  async function runRemaining(expected = generation, run = runSerial) {
    if (!identity || expected !== generation) return;
    const local = controller;
    if (!local) return;
    const pending = rows
      .filter(
        (row) =>
          row.state === "unqueried" ||
          row.state === "failed" ||
          row.state === "stale",
      )
      .map((row) => row.locId);
    for (const batch of chunkIds(pending, 4)) {
      if (
        expected !== generation ||
        run !== runSerial ||
        local.signal.aborted ||
        status === "paused"
      )
        return;
      try {
        const body = await get(queryUrl(batch), expected);
        if (
          !body ||
          expected !== generation ||
          run !== runSerial ||
          (status as string) === "paused"
        )
          return;
        if (body.status === "restart-required") {
          status = "unavailable";
          message =
            body.message ??
            "The comparison scope changed. Restart the comparison.";
          return;
        }
        if (body.status === "unavailable") {
          status = "partial";
          message = body.message ?? "Hotspot comparison is unavailable.";
          return;
        }
        referenceStale = !!body.referenceStale;
        mergeBatch(body.rows ?? []);
        if (body.stopScheduling) {
          status = "partial";
          message =
            "Further hotspot checks stopped after an eBird authorization or rate limit response.";
          return;
        }
      } catch (err) {
        if (expected !== generation || local.signal.aborted) return;
        status = "partial";
        message =
          err instanceof Error
            ? err.message
            : "Some hotspots could not be checked.";
        return;
      }
    }
    if (expected === generation && run === runSerial && status !== "paused") {
      status = complete ? "complete" : "partial";
      if (status === "partial")
        message =
          "Some hotspot results are stale or unavailable; retry them to complete coverage.";
      if (status === "complete") message = "All verified hotspots checked.";
    }
  }

  function pause() {
    runSerial++;
    generation++;
    controller?.abort();
    controller = null;
    status = "paused";
    message = "Paused; current hotspot results are kept.";
  }
  async function continueRun() {
    if (!identity) {
      await start();
      return;
    }
    controller = new AbortController();
    status = "running";
    message = "Continuing remaining hotspot checks…";
    await runRemaining(generation, ++runSerial);
  }
  async function retry() {
    if (referenceStale) {
      await start();
      return;
    }
    controller = new AbortController();
    status = "running";
    message = "Retrying incomplete hotspot checks…";
    await runRemaining(generation, ++runSerial);
  }

  function apply() {
    if (complete && rows.some((row) => row.count != null))
      onApply(sortedComparisonRows(rows));
  }
</script>

<section class="card comparison" aria-labelledby="compare-title">
  <div class="head">
    <div>
      <h2 id="compare-title">Compare hotspots</h2>
      <p class="muted">
        Compare recent public reports from every verified hotspot in this area.
        A zero means no matching reports were returned. Birds may still be
        present without a report.
      </p>
    </div>
    {#if status === "idle" || status === "unavailable"}
      <button type="button" class="primary" onclick={start}
        >Compare hotspots</button
      >
    {:else if status === "loading" || status === "running"}
      <button type="button" onclick={pause}>Pause</button>
    {:else if status === "paused"}
      <button type="button" onclick={continueRun}>Continue</button>
    {:else if status === "partial"}
      <button type="button" onclick={retry}>Retry incomplete</button>
    {/if}
  </div>
  <p class="muted scope">
    {filters.seenStatus === "needs" ? "My needs" : "All species"} · last {filters.daysBack}
    days · within {formatDistance(filters.radiusKm, distanceUnit)} · includes unconfirmed
    reports{filters.rareOnly ? " · notable reports" : ""}
  </p>
  {#if status !== "idle"}
    <p class="status" aria-live="polite">
      {message}{#if message.includes("Settings")}
        <a href="/settings">Open Settings</a>{/if}
    </p>
    <p class="progress" aria-live="polite">
      {progress.checked} of {progress.total} checked · {progress.fresh} fresh · {progress.stale}
      stale · {progress.failed} failed · {progress.unqueried} unqueried
    </p>
    {#if ranked.length > 0}
      <div class="rows">
        {#each shown as row, i (row.locId)}
          <div
            class="row"
            class:dim={row.state === "failed" || row.state === "unqueried"}
          >
            <span class="rank">{i + 1}</span>
            <div class="grow">
              <strong>
                {#if row.locId}
                  {@const originId = `hotspot-compare-${encodeURIComponent(row.locId)}`}
                  <a
                    id={originId}
                    class="path-focus-target"
                    href={withReturnTo(`/hotspots/${encodeURIComponent(row.locId)}`, sourceHref, undefined, sourceLabel)}
                    onclick={navigationAction(accountId, { label: row.locName, originId })}
                    >{row.locName}</a
                  >
                {:else}{row.locName}{/if}</strong
              >
              <div class="meta">
                {#if row.count != null}{row.count}
                  {filters.seenStatus === "needs"
                    ? row.count === 1
                      ? "need"
                      : "needs"
                    : "species"}{:else}{row.state}{/if} · {formatDistance(
                  row.distanceKm,
                  distanceUnit,
                )}
              </div>
              {#if row.species.length}<details class="species">
                  <summary>{row.species.length} matching species</summary>
                  <div class="species-list">
                    {#each row.species as species (species.code)}
                      {@const spOriginId = `hotspot-compare-species-${encodeURIComponent(row.locId)}-${encodeURIComponent(species.code)}`}
                      <div>
                        <a
                          id={spOriginId}
                          class="path-focus-target"
                          href={withReturnTo(`/species/${encodeURIComponent(species.code)}`, sourceHref, undefined, sourceLabel)}
                          onclick={navigationAction(accountId, { label: species.comName, originId: spOriginId })}
                          >{species.comName}</a
                        >{#if species.obsValid === false}
                          <span class="unconfirmed">Unconfirmed</span>{/if}
                      </div>
                    {/each}
                  </div>
                </details>{/if}{#if row.error}<div class="meta err">
                  {row.error}
                </div>{/if}<MapLink
                lat={row.lat}
                lng={row.lng}
                name={row.locName}
                googlePlaceId={row.googlePlaceId}
              />
            </div>
            {#if row.state === "fresh"}<span class="badge">fresh</span
              >{:else if row.state === "stale"}<span class="badge stale"
                >stale</span
              >{:else}<span class="badge">{row.state}</span>{/if}
          </div>
        {/each}
      </div>
      {#if ranked.length > 5}<button
          type="button"
          class="more"
          onclick={() => (showAll = !showAll)}
          >{showAll ? "Show fewer" : `Show all ${ranked.length}`}</button
        >{/if}
    {/if}
    {#if canApply && complete && rows.some((row) => row.count != null)}
      <button type="button" class="apply" onclick={apply}
        >Use compared ranking</button
      >
      <p class="muted">
        This changes the planner only after you press Apply; your name, notes,
        and manual locations stay available.
      </p>
    {/if}
  {/if}
</section>

<style>
  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px;
    margin-bottom: 12px;
  }
  .head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
  }
  h2 {
    font-size: 1.05rem;
    margin: 0 0 4px;
  }
  .muted {
    color: var(--muted);
    font-size: 0.84rem;
  }
  .scope,
  .progress {
    margin: 8px 0;
    font-weight: 600;
  }
  .status {
    margin: 10px 0 4px;
  }
  button {
    min-height: 48px;
    padding: 8px 14px;
    border: 1px solid var(--border);
    border-radius: 7px;
    background: var(--card);
    color: var(--text);
    font-weight: 700;
    cursor: pointer;
  }
  button.primary,
  .apply {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--on-accent);
  }
  .row {
    display: flex;
    align-items: center;
    gap: 10px;
    border-top: 1px solid var(--border);
    padding: 10px 0;
    min-height: 48px;
  }
  .rank {
    width: 24px;
    text-align: center;
    font-weight: 700;
  }
  .grow {
    flex: 1;
    min-width: 0;
  }
  .meta {
    color: var(--muted);
    font-size: 0.82rem;
  }
  .species {
    color: var(--text);
    font-size: 0.82rem;
    margin-top: 2px;
  }
  .species summary {
    min-height: 48px;
    padding: 12px 0;
    cursor: pointer;
    color: var(--link);
  }
  .grow > strong > a,
  .species-list a {
    display: inline-flex;
    align-items: center;
    min-height: 48px;
  }
  .species-list {
    margin-top: 4px;
  }
  .unconfirmed {
    color: var(--need-text);
    font-size: 0.75rem;
    font-weight: 600;
  }
  .err {
    color: var(--danger, #9a3412);
  }
  .dim {
    color: var(--text);
  }
  .badge {
    font-size: 0.75rem;
    color: var(--muted);
  }
  .stale {
    color: var(--need-text);
  }
  .more {
    margin-top: 8px;
  }
  .apply {
    margin-top: 12px;
  }
  @media (max-width: 639px) {
    .head {
      flex-direction: column;
    }
    .head > button {
      width: 100%;
    }
  }
</style>
