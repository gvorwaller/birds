<script lang="ts">
  import { enhance } from "$app/forms";
  import { browser } from "$app/environment";
  import { goto, invalidateAll } from "$app/navigation";
  import { mapsPlaceUrl } from "$lib/geo";
  import { jobsPoll } from "$lib/job-poll.svelte";
  import { fmtNextScan } from "$lib/next-scan";
  import ForecastTabs from "$lib/components/ForecastTabs.svelte";
  import ProgressBar from "$components/ProgressBar.svelte";
  import type { ActionData, PageData } from "./$types";

  let { data, form }: { data: PageData; form: ActionData } = $props();

  // Country picker (td-f1d6da): switching countries reloads the loader with
  // the new ?country= so the region select + stored-data labels update —
  // no client-side eBird calls, no new endpoint.
  const selectedCountryName = $derived(
    data.countries.find((c) => c.code === data.selectedCountry)?.name ??
      data.selectedCountry,
  );
  // US pinned first with its own <optgroup> so a ~250-country list doesn't
  // read as unsorted (GROK UX review #2).
  // Typing narrows both optgroups so reaching Norway doesn't mean scrolling
  // ~250 entries (GBV 2026-08-24). The current selection always survives the
  // filter — a <select> whose value has no matching option renders blank.
  let countryFilter = $state("");
  const countryMatches = $derived((c: { code: string; name: string }) => {
    const q = countryFilter.trim().toLowerCase();
    return (
      q === "" ||
      c.code === data.selectedCountry ||
      c.name.toLowerCase().includes(q) ||
      c.code.toLowerCase().startsWith(q)
    );
  });
  const usCountry = $derived(
    data.countries.find((c) => c.code === "US" && countryMatches(c)) ?? null,
  );
  const otherCountries = $derived(
    data.countries.filter((c) => c.code !== "US" && countryMatches(c)),
  );
  function onCountryChange(e: Event & { currentTarget: HTMLSelectElement }) {
    void goto(`?country=${e.currentTarget.value}`, {
      keepFocus: true,
      noScroll: true,
    });
  }
  // Nothing left to offer: every subnational1 region is loaded, and so is the
  // countrywide export where one is offered (never for US).
  const nothingLeftToLoad = $derived(
    data.states.length === 0 &&
      (data.selectedCountry === "US" || data.wholeCountryLoaded),
  );
  // US state groups + one entry per non-US CountrySection — the "Loaded
  // data (N regions)" count (td-f1d6da: countries now count as one region
  // each, their subnational1 children nested inside rather than counted as
  // their own top-level siblings).
  const totalGroupCount = $derived(
    data.stateGroups.length + data.countrySections.length,
  );

  // Every StateGroup reaching this template — top-level (US) or nested
  // inside a CountrySection (everywhere else) — is level "subnational1"; a
  // level:"country" entry never leaves the loader, it's consumed into the
  // CountrySection's own header fields instead (td-f1d6da UX restructure).

  /** "county"/"counties" for US states; "region"/"regions" everywhere else
   * (non-US subnational1 regions). */
  function countyNoun(g: PageData["stateGroups"][number]): "county" | "region" {
    return g.countryCode === "US" ? "county" : "region";
  }
  function countyWord(g: PageData["stateGroups"][number]): string {
    const noun = countyNoun(g);
    const singular = g.countiesLoaded === 1 && g.countyTotal == null;
    if (singular) return noun;
    return noun === "county" ? "counties" : "regions";
  }
  function groupStatusLabel(g: PageData["stateGroups"][number]): string | null {
    if (!g.state) return null;
    const noun = g.countryCode === "US" ? "statewide" : "regionwide";
    return g.state.current ? noun : `${noun} (outdated)`;
  }
  /** The "N of M counties/regions" status fragment — null suppresses it
   * entirely rather than showing a meaningless "0 of 0" (GBV 2026-08-24:
   * Norway's fylker have no subnational2, so every "Oppland"/"Oslo"/... group
   * had a "0 of 0 regions" fragment cluttering the page). Shown without the
   * "of M" half when the total is unknown (no API key / list fetch failed)
   * but something is known to be loaded locally. */
  function regionCountText(g: PageData["stateGroups"][number]): string | null {
    if (g.countyTotal === 0) return null;
    if (g.countyTotal == null && g.countiesLoaded === 0) return null;
    const noun = countyWord(g);
    return g.countyTotal != null
      ? `${g.countiesLoaded} of ${g.countyTotal} ${noun}`
      : `${g.countiesLoaded} ${noun}`;
  }
  /** Full "statewide · 5 of 16 counties · 2 hotspots" status line for a
   * region group's <summary>, same composition for a US state and a nested
   * non-US region. */
  function groupStatusText(g: PageData["stateGroups"][number]): string {
    const parts: string[] = [];
    const status = groupStatusLabel(g);
    if (status) parts.push(status);
    const regionPart = regionCountText(g);
    if (regionPart) parts.push(regionPart);
    parts.push(`${g.hotspotCount} hotspot${g.hotspotCount === 1 ? "" : "s"}`);
    return parts.join(" · ");
  }
  /** Same status-line composition for a country section's own header (GBV:
   * "Countries need to be treated like states") — "countrywide"/"not
   * loaded" in place of "statewide"/"regionwide", "regions" always (a
   * country's children are never "counties"). */
  function sectionStatusText(s: PageData["countrySections"][number]): string {
    const parts: string[] = [];
    parts.push(
      s.countrywide
        ? s.countrywide.current
          ? "countrywide"
          : "countrywide (outdated)"
        : "not loaded",
    );
    if (s.regionTotal != null && s.regionTotal > 0) {
      parts.push(
        `${s.regionsLoaded} of ${s.regionTotal} region${s.regionTotal === 1 ? "" : "s"}`,
      );
    } else if (s.regionTotal == null && s.regionsLoaded > 0) {
      parts.push(`${s.regionsLoaded} region${s.regionsLoaded === 1 ? "" : "s"}`);
    }
    parts.push(`${s.hotspotCount} hotspot${s.hotspotCount === 1 ? "" : "s"}`);
    return parts.join(" · ");
  }

  let refreshing = $state<string | null>(null);
  let reloading = $state(false);
  async function reloadData() {
    reloading = true;
    try {
      await invalidateAll();
    } finally {
      reloading = false;
    }
  }

  // This page is the load/progress hub — force a fresh poll on arrival so
  // the jobs list is current even if the poller had gone idle.
  $effect(() => {
    jobsPoll.track(0);
  });

  // Any action that returns {queued} gets tracked so the new job appears in
  // the active list within one poll tick. Duplicate tracks are harmless.
  $effect(() => {
    const q = form && "queued" in form ? form.queued : null;
    if (q) jobsPoll.track(q.jobId);
  });

  // Cancel is destructive AND communal (any non-viewer can cancel anyone's
  // load) → modal confirmation per cs.md (GROK Phase-1 review #3).
  let cancelTarget = $state<{ id: number; name: string; by: string | null } | null>(null);
  function confirmCancel() {
    if (!cancelTarget) return;
    void jobsPoll.cancel(cancelTarget.id);
    cancelTarget = null;
  }

  // Which state sections are expanded — remembered across sessions (GBV).
  const OPEN_KEY = "forecast-data-open-states";
  function readOpen(): string[] {
    if (!browser) return [];
    try {
      const v = JSON.parse(localStorage.getItem(OPEN_KEY) ?? "[]");
      return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
    } catch {
      return [];
    }
  }
  let openStates = $state<string[]>([]);
  $effect(() => {
    openStates = readOpen();
  });
  function toggleState(code: string, open: boolean) {
    const next = openStates.filter((c) => c !== code);
    if (open) next.push(code);
    openStates = next;
    if (open) void loadHotspotCounts(code);
    if (browser) {
      try {
        localStorage.setItem(OPEN_KEY, JSON.stringify(next));
      } catch {
        // private mode
      }
    }
  }

  // Hotspot tallies per county ("229 of 312 loaded · 83 to load"), fetched
  // only for groups you actually open — one cached eBird request per region
  // covers all of its counties, but 20 groups shouldn't fan out on page load.
  type HotspotCounts = { total: number; loaded: number; pending: number };
  let hotspotCounts = $state<Record<string, HotspotCounts>>({});
  const countsFetched = new Set<string>();
  async function loadHotspotCounts(regionCode: string) {
    if (!browser || countsFetched.has(regionCode)) return;
    countsFetched.add(regionCode);
    try {
      const res = await fetch(
        `/api/hotspot-counts?region=${encodeURIComponent(regionCode)}`,
      );
      if (!res.ok) return; // decoration only — a failure just shows no counts
      const body = (await res.json()) as { counts: Record<string, HotspotCounts> };
      hotspotCounts = { ...hotspotCounts, ...body.counts };
    } catch {
      countsFetched.delete(regionCode); // transient — allow a retry on reopen
    }
  }
  // Groups restored open from localStorage need their counts too.
  $effect(() => {
    for (const code of openStates) void loadHotspotCounts(code);
  });

  /** The running/queued sweep for one county, if any (jobTarget = area code). */
  function sweepJob(areaCode: string) {
    return jobsPoll.active.find((j) => j.target === areaCode && j.type === "load_hotspots");
  }

  // Hotspot rows collapse under their county row (GBV: dozens of hotspots
  // per county get unwieldy). Collapsed by default; remembered like states.
  const OPEN_COUNTIES_KEY = "forecast-data-open-counties";
  let openCounties = $state<string[]>([]);
  $effect(() => {
    if (!browser) return;
    try {
      const v = JSON.parse(localStorage.getItem(OPEN_COUNTIES_KEY) ?? "[]");
      openCounties = Array.isArray(v)
        ? v.filter((x) => typeof x === "string")
        : [];
    } catch {
      openCounties = [];
    }
  });
  function toggleCounty(code: string) {
    const open = !openCounties.includes(code);
    const next = openCounties.filter((c) => c !== code);
    if (open) next.push(code);
    openCounties = next;
    if (browser) {
      try {
        localStorage.setItem(OPEN_COUNTIES_KEY, JSON.stringify(next));
      } catch {
        // private mode
      }
    }
  }

  function fmtDate(iso: string): string {
    return new Date(iso).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }

  function fmtFrequency(value: number): string {
    return `${(value * 100).toLocaleString(undefined, { maximumFractionDigits: 4 })}%`;
  }

  function fmtTime(iso: string): string {
    return new Date(iso).toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  }

  function fmtDuration(ms: number | null): string {
    if (ms == null) return "";
    if (ms < 1000) return "<1 s";
    const s = Math.round(ms / 1000);
    if (s < 90) return `${s} s`;
    return `${Math.round(s / 60)} min`;
  }

  function jobDuration(j: (typeof jobsPoll.jobs)[number]): number | null {
    if (!j.finishedAt) return null;
    return new Date(j.finishedAt).getTime() - new Date(j.enqueuedAt).getTime();
  }

  // ---- Hub search (Phase 3): one box finds any stored state, county,
  // hotspot, or failed load by name and shows its status — hotspot hits
  // link straight to their /hotspots/[locId] workspace page.
  interface HubHit {
    kind: "state" | "county" | "hotspot" | "failed";
    code: string;
    name: string;
    context: string;
    row: PageData["stateGroups"][number]["stateHotspots"][number] | null;
    error?: string | null;
  }
  let hubSearch = $state("");
  const hubQuery = $derived(hubSearch.trim().toLowerCase());
  // A StateGroup's own hits (state/region row, counties, hotspots) — shared
  // between the top-level US loop and each CountrySection's nested groups
  // (td-f1d6da UX restructure).
  function pushGroupHits(out: HubHit[], g: PageData["stateGroups"][number]) {
    if (g.state) {
      out.push({
        kind: "state",
        code: g.stateCode,
        name: g.stateName,
        context: g.countryCode === "US" ? "statewide" : "regionwide",
        row: g.state,
      });
    }
    for (const b of g.countyBlocks) {
      if (b.county) {
        out.push({
          kind: "county",
          code: b.countyCode,
          name: b.countyName,
          context: g.stateName,
          row: b.county,
        });
      }
      for (const h of b.hotspots) {
        out.push({
          kind: "hotspot",
          code: h.locCode,
          name: h.locName,
          context: `${b.countyName}, ${g.stateName}`,
          row: h,
        });
      }
    }
    for (const h of g.stateHotspots) {
      out.push({
        kind: "hotspot",
        code: h.locCode,
        name: h.locName,
        context: g.stateName,
        row: h,
      });
    }
  }
  const hubIndex = $derived.by((): HubHit[] => {
    const out: HubHit[] = [];
    for (const g of data.stateGroups) pushGroupHits(out, g);
    for (const s of data.countrySections) {
      if (s.countrywide) {
        out.push({
          kind: "state",
          code: s.countryCode,
          name: s.countryName,
          context: "countrywide",
          row: s.countrywide,
        });
      }
      for (const h of s.countryHotspots) {
        out.push({
          kind: "hotspot",
          code: h.locCode,
          name: h.locName,
          context: s.countryName,
          row: h,
        });
      }
      for (const g of s.groups) pushGroupHits(out, g);
    }
    for (const h of data.orphanHotspots) {
      out.push({ kind: "hotspot", code: h.locCode, name: h.locName, context: "", row: h });
    }
    for (const f of data.failed) {
      out.push({
        kind: "failed",
        code: f.locCode,
        name: f.locName ?? f.locCode,
        context: f.regionName ?? "",
        row: null,
        error: f.error,
      });
    }
    return out;
  });
  const hubHits = $derived(
    hubQuery
      ? hubIndex.filter(
          (h) =>
            h.name.toLowerCase().includes(hubQuery) ||
            h.context.toLowerCase().includes(hubQuery) ||
            h.code.toLowerCase() === hubQuery,
        )
      : [],
  );

  // ---- Per-unit activity (Phase 3): the events feed the admin page already
  // uses, surfaced for everyone on this communal hub. Fetch on expand; while
  // a RUNNING job's activity stays open, refresh every 10 s.
  interface EventsFeed {
    events: { at: string; action: string; details: unknown }[];
    /** ALL events the job has ever written — the fetch is the newest 200,
     * so total > events.length means older activity was trimmed. */
    total: number;
  }
  let openEvents = $state<Record<number, EventsFeed | "loading" | "error">>({});
  async function loadEvents(jobId: number) {
    openEvents = { ...openEvents, [jobId]: openEvents[jobId] ?? "loading" };
    try {
      const res = await fetch(`/api/jobs/${jobId}/events`);
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as EventsFeed;
      openEvents = { ...openEvents, [jobId]: body };
    } catch {
      openEvents = { ...openEvents, [jobId]: "error" };
    }
  }
  // Per-unit activity is only offered for the communal frequency-load
  // family — other job types' events may reference individual users and
  // the API 403s them for non-admins (CODEX1 P1 on e3ac335).
  const ACTIVITY_TYPES = new Set([
    "load_hotspots",
    "load_region",
    "analyze_counties",
    "refresh_loc",
    "retry_loc",
  ]);
  let activityOpen = $state<number[]>([]);
  function toggleActivity(jobId: number, open: boolean) {
    activityOpen = activityOpen.filter((id) => id !== jobId);
    if (open) {
      activityOpen = [...activityOpen, jobId];
      void loadEvents(jobId);
    }
  }
  // Depend on activityOpen ONLY: reading jobsPoll here would re-run this
  // effect on every 2.5s poll write, tearing the interval down before its
  // 10s ever fired — the live feed silently became one-shot (GROK P2 on
  // e3ac335). The running check moves INSIDE the callback, where reads
  // create no reactive dependencies.
  $effect(() => {
    if (activityOpen.length === 0) return;
    const ids = [...activityOpen];
    const t = setInterval(() => {
      for (const id of ids) {
        if (jobsPoll.active.some((j) => j.id === id && j.status === "running")) {
          void loadEvents(id);
        }
      }
    }, 10_000);
    return () => clearInterval(t);
  });
  const UNIT_EVENTS = new Set(["unit_ok", "unit_failed", "unit_skipped"]);
  function unitEvents(ev: { at: string; action: string; details: unknown }[]) {
    return ev.filter((e) => UNIT_EVENTS.has(e.action));
  }
  function unitName(details: unknown): string {
    const d = details as { name?: unknown; code?: unknown } | null;
    return typeof d?.name === "string"
      ? d.name
      : typeof d?.code === "string"
        ? d.code
        : "?";
  }
  function unitError(details: unknown): string | null {
    const d = details as { error?: unknown } | null;
    return typeof d?.error === "string" ? d.error : null;
  }
</script>

{#snippet activity(jobId: number)}
  <!-- Phase 3: the per-unit narration admins always had, for everyone —
       which hotspot loaded, which failed and why, as it happens. -->
  <details
    class="activity"
    ontoggle={(e) => toggleActivity(jobId, e.currentTarget.open)}
  >
    <summary>Activity</summary>
    {#if openEvents[jobId] === "loading" || openEvents[jobId] == null}
      <p class="jobdetail">Loading…</p>
    {:else if openEvents[jobId] === "error"}
      <p class="jobdetail err">Could not load the activity feed.</p>
    {:else}
      {@const feed = openEvents[jobId]}
      {@const units = unitEvents(feed.events)}
      {#if units.length === 0}
        <p class="jobdetail">No per-location activity yet.</p>
      {:else}
        <ul class="unitlog">
          {#each units.slice(-40) as e, i (i)}
            <li data-act={e.action}>
              <span class="uwhen">{fmtTime(e.at)}</span>
              <span class="umark" aria-hidden="true">
                {e.action === "unit_ok" ? "✓" : e.action === "unit_failed" ? "✗" : "–"}
              </span>
              <span class="uname">
                {unitName(e.details)}
                {#if e.action === "unit_failed"}<span class="err">
                    failed{#if unitError(e.details)} — {unitError(e.details)}{/if}</span
                  >{:else if e.action === "unit_skipped"}<span class="muted2">
                    skipped{#if unitError(e.details)} — {unitError(e.details)}{/if}</span
                  >{/if}
              </span>
            </li>
          {/each}
        </ul>
        {#if units.length > 40 || feed.total > feed.events.length}
          <p class="jobdetail">
            Showing the latest {Math.min(units.length, 40)} location
            updates{feed.total > feed.events.length
              ? ` — this load has ${feed.total.toLocaleString()} log entries in all`
              : ` of ${units.length}`}.
          </p>
        {/if}
      {/if}
    {/if}
  </details>
{/snippet}

{#snippet loadHotspotsButton(areaCode: string, areaName: string)}
  <!-- Sweep every eBird hotspot in one county/region (td-372d2a). The action
       skips whatever is already current, so this stays useful on re-visits. -->
  {#if !data.isViewer}
    {@const counts = hotspotCounts[areaCode]}
    {@const job = sweepJob(areaCode)}
    <form
      method="POST"
      action="?/loadCountyHotspots"
      class="hsload"
      use:enhance={() => {
        refreshing = `hotspots-${areaCode}`;
        return async ({ update }) => {
          refreshing = null;
          await update();
        };
      }}
    >
      <input type="hidden" name="county" value={areaCode} />
      <button
        type="submit"
        class="secondary"
        disabled={refreshing !== null || !!job || counts?.pending === 0}
        title="Queue every eBird hotspot in {areaName} that isn't loaded yet"
      >
        {refreshing === `hotspots-${areaCode}` ? "Queueing…" : "Load hotspots"}
      </button>
      {#if job}
        <!-- Live sweep progress right where it was launched, so you don't
             have to scroll up to the Background loads card. -->
        {@const done = job.progress.unitsDone ?? 0}
        {@const total = job.progress.unitsTotal ?? 0}
        {@const failed = job.progress.unitsFailed ?? 0}
        <span class="hsprogress">
          {job.status === "running" && total > 0
            ? `Loading ${Math.min(done + 1, total)} of ${total}…`
            : total > 0
              ? `Queued · ${total} hotspots`
              : "Queued…"}
          {#if failed > 0}
            <span class="hsfail">· {failed} failed</span>
          {/if}
        </span>
      {:else if counts}
        <span class="hscounts">
          {counts.loaded} of {counts.total} loaded{counts.pending > 0
            ? ` · ${counts.pending} to load`
            : " · all current"}
        </span>
      {/if}
    </form>
  {/if}
{/snippet}

{#snippet metaCells(r: PageData["stateGroups"][number]["stateHotspots"][number])}
  <td>
    {r.beginYear}–{r.endYear}
    {#if !r.current}
      <span class="outdated">outdated</span>
    {/if}
  </td>
  <td>
    {r.nSpecies.toLocaleString()}{#if r.nUnmatched > 0}
      <span class="unm" title="spuhs, slashes, and hybrids excluded from forecasts">
        · {r.nUnmatched} non-species</span
      >{/if}
  </td>
  <td>{fmtDate(r.fetchedAt)}</td>
  {#if !data.isViewer}
    <td>
      <form
        method="POST"
        action="?/refresh"
        use:enhance={() => {
          refreshing = r.locCode;
          return async ({ update }) => {
            refreshing = null;
            await update();
          };
        }}
      >
        <input type="hidden" name="loc" value={r.locCode} />
        <button
          type="submit"
          class="secondary"
          disabled={refreshing !== null}
        >
          {refreshing === r.locCode ? "Queueing…" : "Refresh"}
        </button>
      </form>
    </td>
  {/if}
{/snippet}

{#snippet dataRowCells(
  r: PageData["stateGroups"][number]["stateHotspots"][number],
  indent: boolean,
)}
  <tr class:indent>
    <td>
      {#if indent}<span class="twig" aria-hidden="true">↳</span>{/if}
      {#if r.locKind === "hotspot"}
        <!-- Phase 3: stored hotspots open their workspace page. -->
        <a
          class="hublink"
          href={`/hotspots/${r.locCode}?returnTo=${encodeURIComponent("/forecast/data")}`}
          ><strong>{r.locName}</strong></a
        >
      {:else}
        <strong>{r.locName}</strong>
      {/if}
      <span class="code">{r.locCode}</span>
    </td>
    {@render metaCells(r)}
  </tr>
{/snippet}

{#snippet dataTable(label: string, rows: PageData["stateGroups"][number]["stateHotspots"])}
  <div class="tablewrap">
    <table>
      <thead>
        <tr>
          <th>{label}</th>
          <th>Years</th>
          <th>Species</th>
          <th>Loaded</th>
          {#if !data.isViewer}<th></th>{/if}
        </tr>
      </thead>
      <tbody>
        {#each rows as r (r.locCode)}
          {@render dataRowCells(r, false)}
        {/each}
      </tbody>
    </table>
  </div>
{/snippet}

{#snippet regionGroup(g: PageData["stateGroups"][number], nested: boolean)}
  <!-- Shared by a top-level US state group and a non-US region nested
       inside its CountrySection (td-f1d6da UX restructure) — identical
       body, only the indentation ("nested") differs. -->
  <details
    class="stategroup"
    class:nested
    open={openStates.includes(g.stateCode)}
    ontoggle={(e) => toggleState(g.stateCode, e.currentTarget.open)}
  >
    <summary>
      <strong>{g.stateName}</strong>
      <span class="groupmeta">{groupStatusText(g)}</span>
    </summary>
    {#if !data.isViewer && (g.countyRemaining ?? 0) > 0}
      {@const missing = g.countyRemaining ?? 0}
      {@const noun = countyNoun(g)}
      {#if data.hasLogin}
        <form
          method="POST"
          action="?/analyzeCounties"
          class="groupaction"
          use:enhance={() => {
            refreshing = `counties-${g.stateCode}`;
            return async ({ update }) => {
              refreshing = null;
              await update();
            };
          }}
        >
          <input type="hidden" name="region" value={g.stateCode} />
          <button type="submit" disabled={refreshing !== null}>
            {refreshing === `counties-${g.stateCode}`
              ? "Queueing…"
              : `Analyze ${missing} remaining ${missing === 1 ? noun : noun === "county" ? "counties" : "regions"}`}
          </button>
        </form>
      {:else}
        <p class="notice">
          Analyzing {noun === "county" ? "counties" : "regions"} uses your
          eBird sign-in — add it in
          <a href="/settings">Settings</a>.
        </p>
      {/if}
    {/if}
    {#if g.countyTotal === 0}
      <!-- No child regions to drill into (e.g. Norwegian fylker have no
           subnational2), so the region itself is the sweep unit. -->
      <div class="groupaction">
        {@render loadHotspotsButton(g.stateCode, g.stateName)}
      </div>
    {/if}
    {#if g.state}
      {@render dataTable(g.countryCode === "US" ? "Statewide" : "Regionwide", [g.state])}
    {/if}
    {#if g.countyBlocks.length > 0}
      <div class="tablewrap">
        <table>
          <thead>
            <tr>
              <th>{countyNoun(g) === "county" ? "County" : "Region"} · hotspots</th>
              <th>Years</th>
              <th>Species</th>
              <th>Loaded</th>
              {#if !data.isViewer}<th></th>{/if}
            </tr>
          </thead>
          <tbody>
            {#each g.countyBlocks as b (b.countyCode)}
              {@const open = openCounties.includes(b.countyCode)}
              <tr>
                <td>
                  {#if b.hotspots.length > 0}
                    <button
                      type="button"
                      class="ctoggle"
                      aria-expanded={open}
                      onclick={() => toggleCounty(b.countyCode)}
                    >
                      <span class="chev" aria-hidden="true"
                        >{open ? "▾" : "▸"}</span
                      >
                      <strong>{b.countyName}</strong>
                      <span class="hscount"
                        >{b.hotspots.length} hotspot{b.hotspots.length === 1
                          ? ""
                          : "s"}</span
                      >
                    </button>
                  {:else}
                    <strong>{b.countyName}</strong>
                  {/if}
                  {#if b.seat}
                    <span class="seat">· {b.seat}</span>
                  {/if}
                  <a
                    class="seatmap"
                    href={mapsPlaceUrl({ name: b.mapQuery })}
                    target="_blank"
                    rel="noopener"
                    title="Show {b.countyName} on Google Maps">📍 Map</a
                  >
                  <span class="code">{b.countyCode}</span>
                  {@render loadHotspotsButton(b.countyCode, b.countyName)}
                </td>
                {#if b.county}
                  {@render metaCells(b.county)}
                {:else}
                  <!-- Hotspots loaded before their county was analyzed -->
                  <td colspan={data.isViewer ? 3 : 4} class="muted"
                    >{countyNoun(g)} not analyzed yet</td
                  >
                {/if}
              </tr>
              {#if open}
                {#each b.hotspots as h (h.locCode)}
                  {@render dataRowCells(h, true)}
                {/each}
              {/if}
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
    {#if g.stateHotspots.length > 0}
      <p class="notice">
        Hotspots below have no recorded {countyNoun(g)} — refreshing them
        (or the next area load) files them correctly.
      </p>
      {@render dataTable("Hotspot", g.stateHotspots)}
    {/if}
  </details>
{/snippet}

{#snippet countrySection(s: PageData["countrySections"][number])}
  <!-- One top-level group per non-US country, behaving like a state group
       (its own "Countrywide" row + "Analyze remaining regions" action)
       with the country's subnational1 regions nested inside rather than
       flat top-level siblings (GBV 2026-08-24: "Countries need to be
       treated like states; regions in the countries nested under the
       country."). -->
  <details
    class="stategroup"
    open={openStates.includes(s.countryCode)}
    ontoggle={(e) => toggleState(s.countryCode, e.currentTarget.open)}
  >
    <summary>
      <strong>{s.countryName}</strong>
      <span class="groupmeta">{sectionStatusText(s)}</span>
    </summary>
    {#if !data.isViewer && (s.regionRemaining ?? 0) > 0}
      {@const missing = s.regionRemaining ?? 0}
      {#if data.hasLogin}
        <form
          method="POST"
          action="?/analyzeCounties"
          class="groupaction"
          use:enhance={() => {
            refreshing = `counties-${s.countryCode}`;
            return async ({ update }) => {
              refreshing = null;
              await update();
            };
          }}
        >
          <input type="hidden" name="region" value={s.countryCode} />
          <button type="submit" disabled={refreshing !== null}>
            {refreshing === `counties-${s.countryCode}`
              ? "Queueing…"
              : `Analyze ${missing} remaining region${missing === 1 ? "" : "s"}`}
          </button>
        </form>
      {:else}
        <p class="notice">
          Analyzing regions uses your eBird sign-in — add it in
          <a href="/settings">Settings</a>.
        </p>
      {/if}
    {/if}
    {#if s.countrywide}
      {@render dataTable("Countrywide", [s.countrywide])}
    {/if}
    {#if s.countryHotspots.length > 0}
      <p class="notice">
        Hotspots below have no recorded region — refreshing them (or the
        next area load) files them correctly.
      </p>
      {@render dataTable("Hotspot", s.countryHotspots)}
    {/if}
    {#each s.groups as g (g.stateCode)}
      {@render regionGroup(g, true)}
    {/each}
  </details>
{/snippet}

<svelte:head>
  <title>Hotspots &amp; data · Birds</title>
</svelte:head>

<div class="page">
  <h1>Hotspots &amp; data</h1>
  <ForecastTabs mode="data" />
  <p class="intro">
    Every hotspot, county, and region this app has loaded — how current the
    data is, what's running, and what failed. Data refreshes matter only once
    a year, when a new complete year of checklists becomes available.
  </p>

  <section class="card">
    <h2>Find a hotspot or region</h2>
    <input
      class="hubsearch"
      type="search"
      placeholder="Type a hotspot, county, or region name"
      aria-label="Search stored hotspots and regions"
      bind:value={hubSearch}
    />
    {#if hubQuery}
      {#if hubHits.length === 0}
        <p class="notice">
          Nothing stored matches “{hubSearch.trim()}”. To bring a new area in,
          load hotspots from <a href="/forecast">Forecast</a> or a region
          below.
        </p>
      {:else}
        <ul class="hits">
          {#each hubHits as h (h.kind + h.code)}
            <li>
              <span class="hitmain">
                {#if h.kind === "hotspot"}
                  <a
                    class="hublink"
                    href={`/hotspots/${h.code}?returnTo=${encodeURIComponent("/forecast/data")}`}
                    ><strong>{h.name}</strong></a
                  >
                {:else}
                  <strong>{h.name}</strong>
                {/if}
                {#if h.context}<span class="hitctx">· {h.context}</span>{/if}
                <span class="code">{h.code}</span>
              </span>
              <span class="hitmeta">
                {#if h.kind === "failed"}
                  <span class="err">failed — {h.error ?? "unknown error"}</span>
                {:else if h.row}
                  {h.row.beginYear}–{h.row.endYear} ·
                  {h.row.nSpecies.toLocaleString()} species
                  {#if !h.row.current}<span class="outdated">outdated</span>{/if}
                {/if}
              </span>
            </li>
          {/each}
        </ul>
        <p class="notice">
          {hubHits.length} match{hubHits.length === 1 ? "" : "es"} across
          everything stored. Hotspot names open their page.
        </p>
      {/if}
    {/if}
  </section>

  {#if form && "error" in form && form.error}
    <p class="error">{form.error}</p>
  {/if}
  {#if form?.queued}
    <p class="notice ok">
      {form.queued.deduped
        ? `Already loading — ${form.queued.label} is in the queue.`
        : `Queued: ${form.queued.label}.`}
    </p>
  {/if}

  {#if data.frequencyCorrections.length > 0}
    <section class="card">
      <details class="correction-section">
        <summary>
          <h2>Adjusted source values ({data.frequencyCorrections.length})</h2>
        </summary>
        <p class="notice">
          eBird occasionally returns a frequency above its documented 100% maximum,
          usually where very few checklists exist. The forecast stores 100% and keeps
          the original source value here rather than silently discarding the location.
        </p>
        <ul class="corrections">
          {#each data.frequencyCorrections as correction (`${correction.locCode}-${correction.speciesCode}-${correction.week}`)}
            <li>
              <strong>{correction.locName}</strong>
              <span>{correction.speciesName ?? correction.speciesCode}</span>
              <span>
                week {correction.week}: source {fmtFrequency(correction.originalFreq)} → stored
                {fmtFrequency(correction.storedFreq)} · {correction.sampleSize} checklist{correction.sampleSize === 1 ? "" : "s"}
              </span>
              <span class="when">{fmtDate(correction.detectedAt)}</span>
            </li>
          {/each}
        </ul>
      </details>
    </section>
  {/if}

  <section class="card">
    <h2>Background loads</h2>
    {#if data.nextEnrichmentScanAt}
      <p class="nextscan">
        Next enrichment scan — {fmtNextScan(data.nextEnrichmentScanAt)}
      </p>
    {/if}
    {#if jobsPoll.worker && !jobsPoll.worker.alive}
      <p class="error">
        The background worker isn't running — queued loads will wait until it
        returns. (It restarts automatically on deploys; if this persists,
        something is wrong.)
      </p>
    {/if}
    {#if jobsPoll.isStale}
      <p class="notice">
        Connection to the app lost — loads continue on the server; this list
        will catch up when the connection returns.
      </p>
    {/if}
    {#if jobsPoll.active.length === 0}
      <p class="notice">No loads running or queued.</p>
    {:else}
      <ul class="jobs">
        {#each jobsPoll.active as j (j.id)}
          {@const total = j.progress.unitsTotal ?? 0}
          {@const done = j.progress.unitsDone ?? 0}
          <li>
            <div class="jobhead">
              <strong>{j.displayName}</strong>
              {#if j.requestedByName}
                <span class="jobby">queued by {j.requestedByName}</span>
              {/if}
              <span class="jobstatus" data-color={j.statusColor}>
                {#if j.cancelRequested}
                  cancelling…
                {:else if j.status === "running"}
                  running{#if total > 0}
                    &nbsp;— {done} of {total}{/if}
                {:else if j.progress.phase === "waiting_retry"}
                  retrying {j.nextRetryAt ? `at ${fmtTime(j.nextRetryAt)}` : "soon"}
                  (attempt {j.attempts} of {j.maxAttempts})
                {:else}
                  queued
                {/if}
              </span>
              {#if !data.isViewer && !j.cancelRequested && j.type !== "scan_need_alerts"}
                <!-- The recurring scan singleton is not cancellable (server
                     noops it too) — need alerts are disabled in Settings. -->
                <button
                  type="button"
                  class="secondary"
                  onclick={() =>
                    (cancelTarget = {
                      id: j.id,
                      name: j.displayName,
                      by: j.requestedByName,
                    })}
                >
                  Cancel
                </button>
              {/if}
            </div>
            {#if j.status === "running" && total > 0}
              <ProgressBar value={done} max={total} --pb-margin="8px 0 4px" />
              {#if j.progress.currentUnit}
                <p class="jobdetail">now: {j.progress.currentUnit.name}</p>
              {/if}
            {/if}
            {#if j.progress.lastError}
              <p class="jobdetail err">last problem: {j.progress.lastError}</p>
            {/if}
            {#if ACTIVITY_TYPES.has(j.type)}{@render activity(j.id)}{/if}
          </li>
        {/each}
      </ul>
    {/if}
    {#if jobsPoll.recent.length > 0}
      <details class="history">
        <summary>Recent loads ({jobsPoll.recent.length})</summary>
        <ul class="jobs">
          {#each jobsPoll.recent as j (j.id)}
            <li>
              <div class="jobhead">
                <strong>{j.displayName}</strong>
                {#if j.requestedByName}
                  <span class="jobby">queued by {j.requestedByName}</span>
                {/if}
                <span class="jobstatus" data-color={j.statusColor}>
                  {j.status}{#if j.finishedAt}
                    &nbsp;· {fmtDate(j.finishedAt)}
                    {fmtTime(j.finishedAt)}{/if}{#if jobDuration(j) != null}
                    &nbsp;· {fmtDuration(jobDuration(j))}{/if}
                </span>
              </div>
              {#if j.error}
                <p class="jobdetail err">{j.error}</p>
              {/if}
              {#if (j.progress.unitsFailed ?? 0) > 0}
                <p class="jobdetail">
                  {j.progress.unitsFailed} of {j.progress.unitsTotal} location{(j
                    .progress.unitsFailed ?? 0) === 1
                    ? ""
                    : "s"} failed — see Failed loads below.
                </p>
              {/if}
              {#if ACTIVITY_TYPES.has(j.type)}{@render activity(j.id)}{/if}
            </li>
          {/each}
        </ul>
      </details>
    {/if}
  </section>

  {#if !data.isViewer}
    <section class="card">
      <h2>Load a region</h2>
      {#if !data.hasApiKey}
        <p class="notice">
          The region list needs an eBird API key — add one in
          <a href="/settings">Settings</a>.
        </p>
      {:else}
        {#if data.countries.length > 0}
          <div class="countrypick">
            <label for="country-search">Country</label>
            <input
              id="country-search"
              type="search"
              placeholder="Search {data.countries.length} countries…"
              autocomplete="off"
              bind:value={countryFilter}
            />
            <select
              id="country-select"
              aria-label="Country"
              value={data.selectedCountry}
              onchange={onCountryChange}
            >
              {#if usCountry}
                <optgroup label="United States">
                  <option value={usCountry.code}>{usCountry.name}</option>
                </optgroup>
              {/if}
              <optgroup label={data.hasHome ? "All countries (nearest known first)" : "All countries"}>
                {#each otherCountries as c (c.code)}
                  <option value={c.code}>{c.name}</option>
                {/each}
              </optgroup>
            </select>
          </div>
        {/if}
        {#if data.statesError}
          <p class="error">{data.statesError}</p>
        {:else if nothingLeftToLoad}
          <!-- Every region of this country (and its countrywide export) is
               already loaded — an empty <select> holding only the placeholder
               reads as a broken picker (GBV 2026-08-24, Norway). -->
          <p class="notice">
            Every {data.selectedCountry === "US" ? "state" : "region"} eBird lists
            for {selectedCountryName} is already loaded. Pick another country above,
            or refresh one below.
          </p>
        {:else}
          <form
            method="POST"
            action="?/loadRegion"
            class="loadstate"
            use:enhance={() => {
              refreshing = "new-region";
              return async ({ update }) => {
                refreshing = null;
                await update();
              };
            }}
          >
            <!-- Single instance on this page (not inside an {#each}) — the
                 for/id pairing below assumes that; a future refactor that
                 repeats this form must namespace the id. -->
            <label for="region-select"
              >Region{#if data.hasHome}<span class="muted">
                  (nearest known first)</span
                >{/if}</label
            >
            <select id="region-select" name="region" required>
              <option value="">Choose a region…</option>
              {#if data.selectedCountry !== "US" && !data.wholeCountryLoaded}
                <option value={data.selectedCountry}
                  >Entire {selectedCountryName}</option
                >
              {/if}
              {#each data.states as s (s.code)}
                <option value={s.code}>{s.name}</option>
              {/each}
            </select>
            <button type="submit" disabled={refreshing !== null}>
              {refreshing === "new-region"
                ? "Queueing…"
                : "Load data (one eBird request)"}
            </button>
          </form>
          <p class="notice">
            Region data powers the Species forecast month curves. Already
            loaded regions aren't listed.
          </p>
        {/if}
      {/if}
    </section>
  {/if}

  <section class="card">
    <div class="section-head">
      <h2>
        Loaded data ({totalGroupCount} region{totalGroupCount === 1 ? "" : "s"})
      </h2>
      <button
        type="button"
        class="secondary reload"
        disabled={reloading}
        onclick={reloadData}
      >
        {reloading ? "Reloading…" : "Reload"}
      </button>
    </div>
    {#if totalGroupCount === 0}
      <p class="notice">Nothing loaded yet — load a region above.</p>
    {:else}
      {#each data.stateGroups as g (g.stateCode)}
        {@render regionGroup(g, false)}
      {/each}
      {#each data.countrySections as s (s.countryCode)}
        {@render countrySection(s)}
      {/each}
      {#if data.orphanHotspots.length > 0}
        <details class="stategroup">
          <summary>
            <strong>Other hotspots</strong>
            <span class="groupmeta">
              {data.orphanHotspots.length} without a recorded region — Forecast
              near the hotspot to record it
            </span>
          </summary>
          {@render dataTable("Hotspot", data.orphanHotspots)}
        </details>
      {/if}
    {/if}
  </section>

  {#if data.failed.length > 0}
    <section class="card">
      <details class="failed-section">
        <summary>
          <h2>Failed loads ({data.failed.length})</h2>
        </summary>
        <p class="notice">
          These locations were attempted but have no stored data. eBird's export
          sometimes errors on individual hotspots — retrying later often works.
        </p>
        <ul class="failed">
          {#each data.failed as f (f.locCode)}
            <li>
              <div class="failinfo">
                <strong>{f.locName ?? f.locCode}</strong>
                {#if f.regionName}
                  <span class="region">· {f.regionName}</span>
                {/if}
                <span class="code">{f.locCode}</span>
                <span class="err">{f.error ?? "unknown error"}</span>
                <span class="when">{fmtDate(f.lastAttemptAt)}</span>
              </div>
              {#if !data.isViewer}
                <form
                  method="POST"
                  action="?/retry"
                  use:enhance={() => {
                    refreshing = f.locCode;
                    return async ({ update }) => {
                      refreshing = null;
                      await update();
                    };
                  }}
                >
                  <input type="hidden" name="loc" value={f.locCode} />
                  <button
                    type="submit"
                    class="secondary"
                    disabled={refreshing !== null}
                  >
                    {refreshing === f.locCode ? "Queueing…" : "Retry"}
                  </button>
                </form>
              {/if}
            </li>
          {/each}
        </ul>
      </details>
    </section>
  {/if}

  <p class="attribution">
    Data from
    <a href="https://ebird.org" target="_blank" rel="noopener">eBird.org</a>
  </p>
</div>

<!-- Destructive + communal action → modal confirmation (cs.md; GROK #3).
     Escape and overlay-click dismiss (GROK nit, Phase 2). -->
<svelte:window
  onkeydown={(e) => {
    if (e.key === "Escape" && cancelTarget) cancelTarget = null;
  }}
/>
{#if cancelTarget}
  <div
    class="modal-overlay"
    role="dialog"
    aria-modal="true"
    aria-labelledby="cancel-title"
  >
    <button
      class="modal-scrim"
      aria-label="Close dialog"
      onclick={() => (cancelTarget = null)}
    ></button>
    <div class="modal">
      <h3 id="cancel-title">Cancel this load?</h3>
      <p>
        "{cancelTarget.name}"{cancelTarget.by ? ` — queued by ${cancelTarget.by}` : ""}
        will stop after its current location. Data already loaded is kept;
        the rest stays unloaded until someone queues it again.
      </p>
      <div class="modal-actions">
        <button type="button" class="secondary" onclick={() => (cancelTarget = null)}>
          Keep loading
        </button>
        <button type="button" class="danger-solid" onclick={confirmCancel}>
          Cancel load
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .page {
    max-width: 860px;
    margin: 0 auto;
    padding: 16px;
  }
  h1 {
    font-size: 1.35rem;
    margin: 0 0 4px;
  }
  .intro {
    color: var(--muted);
    margin: 0 0 16px;
    font-size: 0.92rem;
  }
  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 16px;
    margin-bottom: 16px;
  }
  h2 {
    font-size: 1.05rem;
    margin: 0 0 10px;
  }
  .section-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    flex-wrap: wrap;
  }
  .section-head h2 {
    margin: 0;
  }
  .reload {
    font-size: 0.82rem;
    min-height: 36px;
    padding: 4px 12px;
  }
  .stategroup {
    border-top: 1px solid var(--border);
  }
  .stategroup:first-of-type {
    border-top: none;
  }
  /* A country's subnational1 regions, nested one level in (td-f1d6da UX
   * restructure) — same indentation convention as .tablewrap/.groupaction
   * below (12px), not a new design language. */
  .stategroup.nested {
    margin-left: 12px;
  }
  .stategroup summary {
    cursor: pointer;
    min-height: 48px;
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    color: var(--text);
    font-size: 0.95rem;
  }
  .stategroup summary:hover {
    background: var(--bg);
  }
  .groupmeta {
    color: var(--muted);
    font-size: 0.82rem;
  }
  .stategroup .tablewrap {
    margin: 0 0 12px 12px;
  }
  .groupaction {
    margin: 4px 0 12px 12px;
  }
  tr.indent td:first-child {
    padding-left: 34px;
  }
  .ctoggle {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: none;
    border: none;
    padding: 6px 4px 6px 0;
    min-height: 48px;
    cursor: pointer;
    color: var(--text);
    font-size: inherit;
    text-align: left;
  }
  .ctoggle:hover .hscount {
    text-decoration: underline;
  }
  .chev {
    color: var(--accent);
    width: 12px;
  }
  .hscount {
    color: var(--accent);
    font-size: 0.82rem;
    white-space: nowrap;
  }
  .hsload {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .hscounts,
  .hsprogress {
    font-size: 0.82rem;
    color: var(--muted);
  }
  .hsprogress {
    color: var(--accent);
  }
  .hsfail {
    color: var(--danger, #b3261e);
  }
  tr.indent strong {
    font-weight: 500;
  }
  .twig {
    color: var(--muted);
    margin-right: 4px;
  }
  .muted {
    color: var(--muted);
  }
  .groupaction button {
    min-height: 48px;
    padding: 10px 18px;
    font-size: 1rem;
    border: none;
    border-radius: 8px;
    background: var(--accent);
    color: #fff;
    cursor: pointer;
  }
  .groupaction button:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .tablewrap {
    overflow-x: auto;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.9rem;
  }
  th {
    text-align: left;
    color: var(--muted);
    font-weight: 600;
    font-size: 0.8rem;
    padding: 6px 10px 6px 0;
    border-bottom: 1px solid var(--border);
  }
  td {
    padding: 8px 10px 8px 0;
    border-bottom: 1px solid var(--border);
    vertical-align: middle;
  }
  tr:last-child td {
    border-bottom: none;
  }
  .code {
    display: block;
    color: var(--muted);
    font-size: 0.78rem;
  }
  .outdated {
    display: inline-block;
    background: var(--need-bg);
    color: var(--need-text);
    font-size: 0.75rem;
    font-weight: 600;
    border-radius: 6px;
    padding: 1px 6px;
    margin-left: 4px;
  }
  button.secondary {
    min-height: 48px;
    padding: 6px 14px;
    font-size: 0.88rem;
    border-radius: 8px;
    background: var(--card);
    color: var(--accent);
    border: 1px solid var(--accent);
    cursor: pointer;
  }
  button.secondary:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .failed-section summary {
    cursor: pointer;
    list-style: none;
    min-height: 48px;
    display: flex;
    align-items: center;
  }
  .failed-section summary::-webkit-details-marker {
    display: none;
  }
  .failed-section summary h2 {
    margin: 0;
  }
  .failed-section summary::before {
    content: "▸";
    color: var(--accent);
    margin-right: 8px;
    font-size: 0.9rem;
  }
  .failed-section[open] summary::before {
    content: "▾";
  }
  .failed {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .failed li {
    padding: 8px 0;
    border-bottom: 1px solid var(--border);
    font-size: 0.88rem;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    justify-content: space-between;
  }
  .failed li:last-child {
    border-bottom: none;
  }
  .failinfo {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: baseline;
    min-width: 0;
  }
  .failed .code {
    display: inline;
  }
  .region {
    color: var(--muted);
  }
  .countrypick {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    align-items: center;
    margin-bottom: 12px;
  }
  .countrypick label {
    font-weight: 600;
    font-size: 0.88rem;
  }
  .countrypick input[type="search"] {
    flex: 1 1 100%;
    font-size: 16px;
    padding: 10px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--card);
    color: var(--text);
    min-height: 48px;
  }
  .countrypick select {
    flex: 1;
    min-width: 200px;
    font-size: 16px;
    padding: 10px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--card);
    color: var(--text);
    min-height: 48px;
  }
  .loadstate {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    align-items: center;
  }
  .loadstate select {
    flex: 1;
    min-width: 200px;
    font-size: 16px;
    padding: 10px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--card);
    color: var(--text);
    min-height: 48px;
  }
  .loadstate button {
    min-height: 48px;
    padding: 10px 18px;
    font-size: 1rem;
    border: none;
    border-radius: 8px;
    background: var(--accent);
    color: #fff;
    cursor: pointer;
  }
  .loadstate button:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .err {
    color: var(--danger);
  }
  .when {
    color: var(--muted);
    font-size: 0.8rem;
  }
  .error {
    color: var(--danger);
    font-weight: 600;
    margin: 10px 0;
  }
  .notice {
    color: var(--muted);
    margin: 8px 0;
  }
  .notice.ok {
    color: var(--accent);
  }
  .jobs {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .jobs li {
    padding: 8px 0;
    border-bottom: 1px solid var(--border);
  }
  .jobs li:last-child {
    border-bottom: none;
  }
  .jobhead {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    align-items: center;
  }
  .jobstatus {
    font-size: 0.85rem;
    color: var(--muted);
    font-weight: 600;
  }
  .jobby {
    font-size: 0.82rem;
    color: var(--muted);
  }
  .seat {
    color: var(--muted);
    font-size: 0.82rem;
  }
  .seatmap {
    color: var(--link);
    text-decoration: none;
    font-size: 0.85rem;
    font-weight: 600;
    white-space: nowrap;
    padding: 0 6px;
    min-height: 48px;
    display: inline-flex;
    align-items: center;
    vertical-align: middle;
  }
  .seatmap:hover {
    text-decoration: underline;
  }
  .modal-overlay {
    position: fixed;
    inset: 0;
    z-index: 2000;
    background: rgba(33, 37, 41, 0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
  }
  .modal-scrim {
    position: absolute;
    inset: 0;
    background: none;
    border: none;
    cursor: default;
  }
  .modal {
    position: relative;
    background: var(--card);
    border-radius: 8px;
    padding: 24px;
    max-width: 420px;
    width: 100%;
  }
  .modal h3 {
    margin-bottom: 8px;
  }
  .modal p {
    color: var(--muted);
    margin-bottom: 20px;
  }
  .modal-actions {
    display: flex;
    gap: 10px;
    justify-content: flex-end;
    flex-wrap: wrap;
  }
  .danger-solid {
    min-height: 48px;
    padding: 10px 18px;
    font-size: 0.95rem;
    border: none;
    border-radius: 8px;
    background: var(--danger);
    color: #fff;
    cursor: pointer;
  }
  .jobstatus[data-color="ok"],
  .jobstatus[data-color="busy"] {
    color: var(--accent);
  }
  .jobstatus[data-color="error"] {
    color: var(--danger);
  }
  .jobdetail {
    margin: 4px 0 0;
    font-size: 0.85rem;
    color: var(--muted);
  }
  .jobdetail.err {
    color: var(--danger);
  }
  .history summary {
    cursor: pointer;
    min-height: 48px;
    display: flex;
    align-items: center;
    color: var(--muted);
    font-size: 0.9rem;
  }
  .attribution {
    text-align: center;
    color: var(--muted);
    font-size: 0.78rem;
    padding: 20px 0 8px;
  }
  .attribution a {
    color: var(--muted);
  }
  .correction-section summary {
    cursor: pointer;
    min-height: 48px;
    display: flex;
    align-items: center;
  }
  .correction-section summary h2 {
    display: inline;
    margin: 0;
  }
  .corrections {
    list-style: none;
    padding: 0;
    margin: 8px 0 0;
  }
  .corrections li {
    display: grid;
    gap: 2px;
    padding: 10px 0;
    color: var(--muted);
    font-size: 0.88rem;
  }
  .corrections li + li {
    border-top: 1px solid var(--border);
  }
  .corrections strong {
    color: var(--text);
  }
  @media (min-width: 640px) {
    .page {
      padding: 24px;
    }
    h1 {
      font-size: 1.6rem;
    }
  }

  /* ---- Phase 3: hub search ---- */
  .hubsearch {
    width: 100%;
    min-height: 48px;
    padding: 8px 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg);
    color: var(--text);
  }
  .hits {
    list-style: none;
    padding: 0;
    margin: 10px 0 0;
  }
  .hits li {
    display: flex;
    gap: 8px 12px;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    min-height: 48px;
    padding: 2px 0;
  }
  .hits li + li {
    border-top: 1px solid var(--border);
  }
  .hitmain {
    min-width: 0;
  }
  .hitctx {
    color: var(--muted);
    font-size: 0.88rem;
  }
  .hitmeta {
    color: var(--muted);
    font-size: 0.85rem;
    white-space: nowrap;
  }
  .hublink {
    color: inherit;
    text-decoration: none;
    display: inline-flex;
    align-items: center;
    min-height: 48px;
    /* Long hotspot names must wrap inside the flex row, not overflow. */
    min-width: 0;
  }
  .hublink strong {
    overflow-wrap: anywhere;
  }
  @media (hover: hover) {
    .hublink:hover strong {
      color: var(--accent);
    }
  }
  .unm {
    color: var(--muted);
    font-size: 0.82rem;
  }
  /* ---- Phase 3: per-unit activity ---- */
  .activity {
    margin-top: 4px;
  }
  .activity summary {
    display: inline-flex;
    align-items: center;
    min-height: 48px;
    cursor: pointer;
    font-size: 0.85rem;
    font-weight: 600;
    color: var(--accent);
  }
  .unitlog {
    list-style: none;
    padding: 0;
    margin: 0 0 4px;
    font-size: 0.85rem;
  }
  .unitlog li {
    display: flex;
    gap: 8px;
    align-items: baseline;
    padding: 2px 0;
  }
  .uwhen {
    color: var(--muted);
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .umark {
    font-weight: 700;
  }
  .unitlog li[data-act="unit_ok"] .umark {
    color: var(--seen-text);
  }
  .unitlog li[data-act="unit_failed"] .umark {
    color: var(--danger);
  }
  .uname {
    overflow-wrap: anywhere;
    /* flex min-content trap: without this a long name overflows the row. */
    min-width: 0;
    flex: 1;
  }
  .muted2 {
    color: var(--muted);
  }
  .nextscan {
    color: var(--muted);
    font-size: 0.85rem;
    margin: 0 0 8px;
  }
</style>
