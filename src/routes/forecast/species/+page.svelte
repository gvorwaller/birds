<script lang="ts">
  import { enhance } from "$app/forms";
  import FrequencyChart from "$components/FrequencyChart.svelte";
  import MonthPicker from "$components/MonthPicker.svelte";
  import MapLink from "$components/MapLink.svelte";
  import ObsMap, { type ObsPoint } from "$components/ObsMap.svelte";
  import type { ActionData, PageData } from "./$types";

  let { data, form }: { data: PageData; form: ActionData } = $props();

  let loading = $state(false);
  let analyzing = $state(false);
  let analyzeForm = $state<HTMLFormElement | undefined>();
  let liveProgress = $state<{
    total: number;
    current: number;
    stale: number;
    failed: number;
    remaining: number;
  } | null>(null);

  const progress = $derived(liveProgress ?? data.countyCoverage);

  // Resumable county analysis: each action invocation fetches ≤12 counties;
  // keep resubmitting while there is progress and more to do. The server's
  // per-owner single-flight lease makes overlapping loops harmless.
  function analyzeEnhance() {
    analyzing = true;
    return async ({
      result,
      update,
    }: {
      result: { type: string; data?: Record<string, unknown> };
      update: (opts?: { reset?: boolean }) => Promise<void>;
    }) => {
      await update({ reset: false });
      if (result.type === "success" && result.data) {
        const prog = result.data.progress as typeof liveProgress;
        const ens = result.data.ensure as {
          refreshed: string[];
          failed: unknown[];
          credentialProblem: string | null;
          busy: boolean;
        } | null;
        if (prog) liveProgress = prog;
        const madeProgress =
          (ens?.refreshed.length ?? 0) + (ens?.failed.length ?? 0) > 0;
        if (
          prog &&
          prog.remaining > 0 &&
          madeProgress &&
          !ens?.credentialProblem &&
          !ens?.busy
        ) {
          analyzeForm?.requestSubmit();
          return;
        }
      }
      analyzing = false;
    };
  }

  function countyHref(countyCode: string | null): string {
    const p = new URLSearchParams();
    if (data.taxon) p.set("species", data.taxon.species_code);
    if (data.region) p.set("region", data.region.code);
    p.set("month", String(data.month));
    if (countyCode) p.set("county", countyCode);
    return `?${p.toString()}`;
  }

  const hotspotPoints = $derived.by((): ObsPoint[] => {
    if (!data.countyHotspots) return [];
    const byCode = new Map(
      data.countyHotspots.ranking.map((r) => [r.code, r]),
    );
    return data.countyHotspots.selected
      .filter((h) => h.hasData)
      .map((h) => {
        const r = byCode.get(h.locId);
        return {
          lat: h.lat,
          lng: h.lng,
          // Low-sample marker travels onto the map pin too (CODEX8 #3).
          title: r?.lowSample ? `${h.locName} †` : h.locName,
          sub: r
            ? `${pct(r.freq)} of checklists (n=${r.n.toLocaleString()})${r.lowSample ? " — small sample" : ""}`
            : undefined,
          kind: "need" as const,
        };
      });
  });

  const MONTH_NAMES = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];

  const best = $derived(data.forecast?.best ?? null);
  const meta = $derived(data.forecast?.meta ?? null);

  function pct(freq: number): string {
    if (freq === 0) return "0%";
    if (freq < 0.01) return "<1%";
    return `${Math.round(freq * 100)}%`;
  }

  function fmtDate(d: Date | string): string {
    return new Date(d).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }
</script>

<svelte:head>
  <title>Species forecast · Birds</title>
</svelte:head>

<div class="page">
  <h1>Species forecast</h1>
  <p class="intro">
    Best months for a species in a state, from prior years' eBird checklist
    frequencies. Area needs by month?
    <a href="/forecast">Forecast</a> · What's loaded?
    <a href="/forecast/data">Forecast data</a>.
  </p>

  <section class="card">
    <form method="GET" class="pick">
      <div class="row">
        <label for="q">Species</label>
        {#if data.taxon}
          <div class="chosen">
            <strong>{data.taxon.com_name}</strong>
            <span class="sci">{data.taxon.sci_name}</span>
            <a
              class="change"
              href="?region={encodeURIComponent(data.region?.code ?? '')}"
              >change</a
            >
          </div>
          <input type="hidden" name="species" value={data.taxon.species_code} />
        {:else}
          <input
            id="q"
            name="q"
            type="search"
            placeholder="Search by common or scientific name…"
            value={data.q}
          />
        {/if}
      </div>
      <div class="row">
        <label for="region">State</label>
        <select id="region" name="region">
          <option value="">Choose a state…</option>
          {#each data.states as s (s.code)}
            <option value={s.code} selected={s.code === data.region?.code}
              >{s.name}</option
            >
          {/each}
        </select>
      </div>
      <div class="row">
        <button type="submit">{data.taxon ? "View" : "Search"}</button>
      </div>
    </form>

    {#if data.speciesError}
      <p class="error">{data.speciesError}</p>
    {/if}
    {#if data.regionError}
      <p class="error">{data.regionError}</p>
    {/if}
    {#if !data.hasApiKey}
      <p class="notice">
        The state list needs an eBird API key — add one in
        <a href="/settings">Settings</a>.
      </p>
    {:else if data.statesError}
      <p class="error">{data.statesError}</p>
    {:else if data.statesStale}
      <p class="notice">State list shown from cache.</p>
    {/if}

    {#if !data.taxon && data.q}
      {#if data.speciesMatches.length === 0}
        <p class="notice">No species matched "{data.q}".</p>
      {:else}
        <ul class="matches">
          {#each data.speciesMatches as m (m.species_code)}
            <li>
              <a
                href="?species={m.species_code}&region={encodeURIComponent(
                  data.region?.code ?? '',
                )}"
              >
                {m.com_name} <span class="sci">{m.sci_name}</span>
              </a>
            </li>
          {/each}
        </ul>
      {/if}
    {/if}
  </section>

  {#if data.taxon && data.region}
    <section class="card">
      <h2>{data.taxon.com_name} in {data.region.name}</h2>

      {#if data.forecast}
        {@const f = data.forecast}
        {#if f.neverReported}
          <p>
            Not reported in {data.region.name} checklists in
            {f.meta.beginYear}–{f.meta.endYear}.
          </p>
        {:else}
          {#if best}
            <p class="best">
              Best month: <strong>{MONTH_NAMES[best.month - 1]}</strong> —
              reported on {pct(best.freq)} of checklists (n={best.n.toLocaleString()})
              {#if best.lowSample}
                <span class="lowflag"
                  >— small sample; no month reached the reliable-checklist
                  threshold</span
                >
              {/if}
            </p>
          {/if}
          <FrequencyChart
            months={f.curve}
            highlightMonth={best?.month ?? null}
            caption="Share of {data.region.name} eBird checklists reporting {data
              .taxon.com_name}, by month, {f.meta.beginYear}–{f.meta.endYear}"
          />
        {/if}
        <p class="meta">
          Data: {f.meta.beginYear}–{f.meta.endYear}, fetched
          {fmtDate(f.meta.fetchedAt)} · {f.meta.nSpecies.toLocaleString()} species
          stored{#if f.meta.nUnmatched > 0}
            · {f.meta.nUnmatched} names not matched to the taxonomy{/if}
        </p>
        {#if !data.isViewer}
          {#if data.hasLogin}
            <form
              method="POST"
              action="?/loadState"
              use:enhance={() => {
                loading = true;
                return async ({ update }) => {
                  loading = false;
                  await update();
                };
              }}
            >
              <input type="hidden" name="region" value={data.region.code} />
              <input type="hidden" name="force" value="1" />
              <button type="submit" class="secondary" disabled={loading}>
                {loading ? "Refreshing…" : "Refresh data"}
              </button>
            </form>
          {:else}
            <p class="notice">
              Refreshing uses your eBird sign-in — add it in
              <a href="/settings">Settings</a>.
            </p>
          {/if}
        {/if}
      {:else}
        <p>No frequency data loaded yet for {data.region.name}.</p>
        {#if data.attempt?.status === "error"}
          <p class="error">
            Last attempt ({fmtDate(data.attempt.lastAttemptAt)}) failed:
            {data.attempt.error}
          </p>
        {/if}
        {#if data.isViewer}
          <p class="notice">
            The account owner hasn't loaded forecast data for this state yet.
          </p>
        {:else if !data.hasLogin}
          <p class="notice">
            Loading frequency data uses your eBird sign-in — add it in
            <a href="/settings">Settings</a>.
          </p>
        {:else}
          <form
            method="POST"
            action="?/loadState"
            use:enhance={() => {
              loading = true;
              return async ({ update }) => {
                loading = false;
                await update();
              };
            }}
          >
            <input type="hidden" name="region" value={data.region.code} />
            <button type="submit" disabled={loading}>
              {loading ? "Loading from eBird…" : "Load data (one eBird request)"}
            </button>
          </form>
        {/if}
      {/if}

      {#if form && "error" in form && form.error}
        <p class="error">{form.error}</p>
      {/if}
      {#if form?.ensure && !analyzing}
        {#if form.ensure.credentialProblem}
          <p class="error">{form.ensure.credentialProblem}</p>
        {:else if form.ensure.busy}
          <p class="notice">
            Another data load is already running — try again in a moment.
          </p>
        {:else if form.ensure.failed.length > 0}
          <p class="error">
            {form.ensure.failed.length} location{form.ensure.failed.length === 1
              ? ""
              : "s"} failed: {form.ensure.failed[0].error}
          </p>
        {:else if form.ensure.refreshed.length > 0}
          <p class="notice ok">Data loaded from eBird.</p>
        {:else if form.ensure.ready.length > 0}
          <p class="notice ok">Data was already up to date.</p>
        {/if}
      {/if}
    </section>

    {#if data.forecast && !data.forecast.neverReported}
      <section class="card">
        <h2>Where in {data.region.name}</h2>
        <form method="GET" class="monthform">
          <input type="hidden" name="species" value={data.taxon.species_code} />
          <input type="hidden" name="region" value={data.region.code} />
          {#if data.county}
            <input type="hidden" name="county" value={data.county.code} />
          {/if}
          <span class="label">Month</span>
          <MonthPicker value={data.month} />
        </form>

        {#if data.countyError}
          <p class="error">{data.countyError}</p>
          <p class="notice">
            Any previously analyzed counties still rank below; reload the page
            to retry the county list.
          </p>
        {/if}

        {#if progress}
          <p class="coverage">
            {progress.current} of {progress.total} counties analyzed
            {#if progress.stale > 0}
              · <span class="lowflag">{progress.stale} outdated</span>
            {/if}
            {#if progress.failed > 0}
              · {progress.failed} failed (will retry after a day)
            {/if}
          </p>
          {#if analyzing || (progress.current > 0 && progress.remaining > 0)}
            <div
              class="progressbar"
              role="progressbar"
              aria-valuenow={progress.current}
              aria-valuemin={0}
              aria-valuemax={progress.total}
            >
              <div
                class="fill"
                style="width: {(progress.current / progress.total) * 100}%"
              ></div>
            </div>
          {/if}

          {#if progress.remaining > 0 && !data.isViewer}
            {#if data.hasLogin}
              <form
                method="POST"
                action="?/analyzeCounties"
                bind:this={analyzeForm}
                use:enhance={analyzeEnhance}
              >
                <input type="hidden" name="region" value={data.region.code} />
                <button type="submit" disabled={analyzing}>
                  {analyzing
                    ? `Analyzing… ${progress.current}/${progress.total}`
                    : progress.stale > 0 && progress.current + progress.stale === progress.total
                      ? `Refresh ${progress.stale} outdated counties`
                      : `Analyze ${progress.remaining} remaining counties`}
                </button>
              </form>
              <p class="notice">
                One eBird request per county, politely spaced — a full state takes
                a few minutes the first time and then only refreshes yearly.
              </p>
            {:else}
              <p class="notice">
                Analyzing counties uses your eBird sign-in — add it in
                <a href="/settings">Settings</a>.
              </p>
            {/if}
          {:else if progress.remaining > 0 && data.isViewer}
            <p class="notice">
              {progress.current === 0
                ? "The account owner hasn't analyzed this state's counties yet."
                : "More counties can be analyzed by the account owner."}
            </p>
          {/if}
        {/if}

        {#if data.countyRanking.length > 0}
          {@const reported = data.countyRanking.filter((c) => c.freq > 0)}
          {@const adequate = reported.filter((c) => !c.lowSample)}
          {@const lowSampleCounties = reported.filter((c) => c.lowSample)}
          {@const unreported = data.countyRanking.length - reported.length}
          {#if reported.length === 0}
            <p>
              Not reported in any analyzed county's checklists in
              {MONTH_NAMES[data.month - 1]}.
            </p>
          {:else}
            {#if adequate.length > 0}
              <p class="summary">
                Best counties for {data.taxon.com_name} in
                {MONTH_NAMES[data.month - 1]}:
              </p>
              <ol class="ranked">
                {#each adequate.slice(0, 15) as c (c.code)}
                  <li>
                    <div class="sp">
                      <a href={countyHref(c.code)} class="name">{c.name}</a>
                      <span class="freq"
                        >{pct(c.freq)} of checklists (n={c.n.toLocaleString()})</span
                      >
                    </div>
                  </li>
                {/each}
              </ol>
            {/if}
            {#if lowSampleCounties.length > 0}
              <details class="lown">
                <summary>
                  {lowSampleCounties.length} count{lowSampleCounties.length === 1
                    ? "y"
                    : "ies"} with small samples (fewer than 40 checklists) —
                  not ranked
                </summary>
                <ul class="ranked">
                  {#each lowSampleCounties as c (c.code)}
                    <li>
                      <div class="sp">
                        <a href={countyHref(c.code)} class="name">{c.name}</a>
                        <span class="freq"
                          >{pct(c.freq)} (n={c.n.toLocaleString()}) †</span
                        >
                      </div>
                    </li>
                  {/each}
                </ul>
              </details>
            {/if}
            {#if unreported > 0}
              <p class="notice">
                Not reported in {unreported} other analyzed count{unreported ===
                1
                  ? "y"
                  : "ies"} that month.
              </p>
            {/if}
            {#if data.countyDataYears}
              <p class="meta">
                County data: {data.countyDataYears.begin}–{data.countyDataYears
                  .end} checklists{#if progress && progress.stale > 0}
                  · includes {progress.stale} count{progress.stale === 1
                    ? "y"
                    : "ies"} from an older year window{/if}
              </p>
            {/if}
          {/if}
        {/if}
      </section>
    {/if}

    {#if data.hotspotError}
      <section class="card">
        <h2>Hotspots</h2>
        <p class="error">{data.hotspotError}</p>
      </section>
    {/if}

    {#if data.county && data.countyHotspots}
      {@const ch = data.countyHotspots}
      {@const uncovered = ch.selected.filter((h) => !h.current).length}
      <section class="card">
        <h2>
          Hotspots in {data.county.name} — {MONTH_NAMES[data.month - 1]}
        </h2>
        <p class="coverage">
          Top {ch.selected.length} hotspots by all-time species
          {#if ch.hotspotListStale}
            · <span class="lowflag">hotspot list from cache</span>
          {/if}
          · <a href={countyHref(null)}>close county</a>
        </p>

        {#if uncovered > 0 && !data.isViewer}
          {#if data.hasLogin}
            <form
              method="POST"
              action="?/loadHotspots"
              use:enhance={() => {
                loading = true;
                return async ({ update }) => {
                  loading = false;
                  await update();
                };
              }}
            >
              <input type="hidden" name="region" value={data.region.code} />
              <input type="hidden" name="county" value={data.county.code} />
              <button type="submit" disabled={loading}>
                {loading
                  ? "Loading from eBird…"
                  : `Load data for ${uncovered} hotspot${uncovered === 1 ? "" : "s"}`}
              </button>
            </form>
          {:else}
            <p class="notice">
              Loading hotspot data uses your eBird sign-in — add it in
              <a href="/settings">Settings</a>.
            </p>
          {/if}
        {:else if uncovered > 0 && data.isViewer}
          <p class="notice">
            {uncovered} hotspot{uncovered === 1 ? " has" : "s have"} no current
            data — the account owner can load it.
          </p>
        {/if}

        {#if ch.ranking.length > 0}
          {@const reportedHs = ch.ranking.filter((h) => h.freq > 0)}
          {@const adequateHs = reportedHs.filter((h) => !h.lowSample)}
          {@const lowHs = reportedHs.filter((h) => h.lowSample)}
          {#if reportedHs.length === 0}
            <p>
              Not reported at the loaded hotspots' checklists in
              {MONTH_NAMES[data.month - 1]}.
            </p>
          {:else}
            {#if adequateHs.length > 0}
              <ol class="ranked">
                {#each adequateHs as h (h.code)}
                  {@const sel = ch.selected.find((s) => s.locId === h.code)}
                  <li>
                    <div class="sp">
                      <span class="name">{h.name}</span>
                      <span class="freq"
                        >{pct(h.freq)} of checklists (n={h.n.toLocaleString()})</span
                      >
                    </div>
                    {#if sel}
                      <MapLink lat={sel.lat} lng={sel.lng} name={h.name} />
                    {/if}
                  </li>
                {/each}
              </ol>
            {/if}
            {#if lowHs.length > 0}
              <details class="lown">
                <summary>
                  {lowHs.length} hotspot{lowHs.length === 1 ? "" : "s"} with
                  small samples (fewer than 40 checklists) — not ranked
                </summary>
                <ul class="ranked">
                  {#each lowHs as h (h.code)}
                    {@const sel = ch.selected.find((s) => s.locId === h.code)}
                    <li>
                      <div class="sp">
                        <span class="name">{h.name}</span>
                        <span class="freq"
                          >{pct(h.freq)} (n={h.n.toLocaleString()}) †</span
                        >
                      </div>
                      {#if sel}
                        <MapLink lat={sel.lat} lng={sel.lng} name={h.name} />
                      {/if}
                    </li>
                  {/each}
                </ul>
              </details>
            {/if}
            {#if ch.dataYears}
              <p class="meta">
                Hotspot data: {ch.dataYears.begin}–{ch.dataYears.end} checklists
              </p>
            {/if}
          {/if}
        {/if}

        {#if hotspotPoints.length > 0}
          <div class="map">
            <ObsMap points={hotspotPoints} />
          </div>
        {/if}
      </section>
    {/if}
  {/if}

  <p class="attribution">
    Data from
    <a href="https://ebird.org" target="_blank" rel="noopener">eBird.org</a>
  </p>
</div>

<style>
  .page {
    max-width: 760px;
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
    font-size: 1.1rem;
    margin: 0 0 10px;
  }
  .pick .row {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-bottom: 12px;
  }
  label {
    font-weight: 600;
    font-size: 0.88rem;
  }
  input[type="search"],
  select {
    font-size: 16px;
    padding: 10px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--card);
    color: var(--text);
    min-height: 48px;
  }
  button {
    min-height: 48px;
    padding: 10px 18px;
    font-size: 1rem;
    border: none;
    border-radius: 8px;
    background: var(--accent);
    color: #fff;
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.6;
    cursor: default;
  }
  button.secondary {
    background: var(--card);
    color: var(--accent);
    border: 1px solid var(--accent);
  }
  .chosen {
    display: flex;
    align-items: baseline;
    gap: 8px;
    flex-wrap: wrap;
    min-height: 48px;
    align-content: center;
  }
  .sci {
    color: var(--muted);
    font-style: italic;
    font-size: 0.88rem;
  }
  .change {
    font-size: 0.88rem;
  }
  .matches {
    list-style: none;
    margin: 8px 0 0;
    padding: 0;
  }
  .matches li a {
    display: block;
    padding: 12px 8px;
    border-top: 1px solid var(--border);
    text-decoration: none;
    color: var(--text);
  }
  .matches li a:hover {
    background: var(--bg);
  }
  .best {
    font-size: 1rem;
  }
  .lowflag {
    color: var(--muted);
    font-size: 0.88rem;
  }
  .meta {
    color: var(--muted);
    font-size: 0.82rem;
    margin: 10px 0;
  }
  .monthform {
    margin-bottom: 12px;
  }
  .monthform .label {
    display: block;
    font-weight: 600;
    font-size: 0.88rem;
    margin-bottom: 4px;
  }
  .coverage {
    color: var(--muted);
    font-size: 0.85rem;
    margin: 0 0 10px;
  }
  .progressbar {
    height: 8px;
    background: var(--accent-soft);
    border-radius: 4px;
    overflow: hidden;
    margin-bottom: 10px;
  }
  .progressbar .fill {
    height: 100%;
    background: var(--accent);
    transition: width 0.4s ease;
  }
  .summary {
    margin: 14px 0 8px;
  }
  .ranked {
    margin: 0;
    padding-left: 1.4em;
  }
  .ranked li {
    padding: 8px 0;
    border-bottom: 1px solid var(--border);
  }
  .ranked li:last-child {
    border-bottom: none;
  }
  .sp {
    display: flex;
    justify-content: space-between;
    gap: 10px;
    flex-wrap: wrap;
    align-items: baseline;
  }
  .name {
    font-weight: 600;
  }
  .freq {
    color: var(--muted);
    font-size: 0.85rem;
  }
  .map {
    margin-top: 14px;
  }
  .lown {
    margin-top: 14px;
  }
  .lown summary {
    cursor: pointer;
    color: var(--accent);
    font-size: 0.9rem;
    min-height: 48px;
    display: flex;
    align-items: center;
  }
  .lown ul {
    list-style: none;
    padding-left: 0;
  }
  .error {
    color: var(--danger);
    font-weight: 600;
    margin: 10px 0 0;
  }
  .notice {
    color: var(--muted);
    margin: 10px 0 0;
  }
  .notice.ok {
    color: var(--accent);
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
  @media (min-width: 640px) {
    .page {
      padding: 24px;
    }
    h1 {
      font-size: 1.6rem;
    }
    .pick {
      display: flex;
      gap: 12px;
      align-items: flex-end;
    }
    .pick .row {
      margin-bottom: 0;
    }
    .pick .row:first-child {
      flex: 1;
    }
  }
</style>
