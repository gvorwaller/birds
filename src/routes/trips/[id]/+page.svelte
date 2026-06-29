<script lang="ts">
  import { enhance } from "$app/forms";
  import { tick } from "svelte";
  import { env } from "$env/dynamic/public";
  import Badge from "$components/Badge.svelte";
  import DatePicker from "$components/DatePicker.svelte";
  import DistanceUnitToggle from "$components/DistanceUnitToggle.svelte";
  import MapLink from "$components/MapLink.svelte";
  import TripMap, { type MapStop } from "$components/TripMap.svelte";
  import { optimizeDrivingRoute, formatDuration } from "$lib/route";
  import { formatDistance, mapsRouteUrl, type DistanceUnit } from "$lib/geo";
  import type { ActionData, PageData } from "./$types";

  let { data, form }: { data: PageData; form: ActionData } = $props();

  let editing = $state(false);
  let deleteOpen = $state(false);
  let distanceUnit = $state<DistanceUnit>("mi");

  const MAPS_KEY = env.PUBLIC_GOOGLE_MAPS_API_KEY ?? "";

  // "Optimize order" runs Google's driving-distance optimizer in the browser,
  // then posts the resulting sequence to ?/set_order. If Directions is
  // unavailable it falls back to the server's straight-line ?/optimize.
  let optimizing = $state(false);
  let tipsLoading = $state(false);
  let orderValue = $state("");
  let orderForm = $state<HTMLFormElement>();
  let fallbackForm = $state<HTMLFormElement>();
  let routeSummary = $state<{ km: number; min: number } | null>(null);

  async function runOptimize() {
    if (optimizing) return;
    optimizing = true;
    try {
      const res = await optimizeDrivingRoute(MAPS_KEY, {
        home: data.home,
        stops: data.stops.map((s) => ({
          id: s.id,
          lat: s.lat as number,
          lon: s.lon as number,
        })),
      });
      orderValue = res.orderedIds.join(",");
      await tick();
      orderForm?.requestSubmit();
    } catch {
      fallbackForm?.requestSubmit();
    }
  }

  let mapStops = $derived<MapStop[]>(
    data.stops
      .filter((s) => s.lat != null && s.lon != null)
      .map((s, i) => ({
        lat: s.lat as number,
        lng: s.lon as number,
        label: s.custom_name ?? s.hotspot_id ?? "Stop",
        order: i + 1,
        googlePlaceId: s.google_place_id,
      })),
  );
  let mapExtra = $derived<MapStop | null>(
    data.hsCenter
      ? {
          lat: data.hsCenter.lat,
          lng: data.hsCenter.lng,
          label: data.hsCenter.label,
          order: 0,
        }
      : null,
  );
  // Multi-waypoint Google Maps hand-off: from the device's location through
  // every located stop in order. Needs ≥2 stops to be a "route".
  let routeUrl = $derived(
    mapStops.length >= 2
      ? mapsRouteUrl(mapStops.map((s) => ({ lat: s.lat, lng: s.lng })))
      : "",
  );

  function fmtDates(start: string | null, end: string | null): string {
    if (!start && !end) return "no dates set";
    const f = (d: string) => new Date(d + "T00:00:00").toLocaleDateString();
    if (start && end)
      return start === end ? f(start) : `${f(start)} – ${f(end)}`;
    return f((start ?? end) as string);
  }
</script>

<svelte:head>
  <title>{data.trip.name} — birds</title>
</svelte:head>

<div class="page">
  <header class="page-head">
    <p class="sub"><a href="/trips">← Trips</a></p>
    <div class="title-row">
      <h1>{data.trip.name}</h1>
      {#if data.canEdit}
        <button class="link" onclick={() => (editing = !editing)}
          >{editing ? "Close" : "Edit"}</button
        >
      {/if}
      <a
        class="link"
        href={`/trips/${data.trip.id}/export`}
        data-sveltekit-reload>⬇ Export</a
      >
    </div>
    <p class="sub">
      {fmtDates(data.trip.start_date, data.trip.end_date)} · {data.stops.length}
      {data.stops.length === 1 ? "stop" : "stops"}
    </p>
    <div class="unit-row">
      <span>Distance units</span>
      <DistanceUnitToggle bind:unit={distanceUnit} />
    </div>
    {#if data.trip.notes && !editing}<p class="notes">{data.trip.notes}</p>{/if}
  </header>

  {#if form && "message" in form && form.message}
    <section class="card"><p class="ok">{form.message}</p></section>
  {/if}
  {#if form && "error" in form && form.error}
    <section class="card"><p class="err" role="alert">{form.error}</p></section>
  {/if}

  {#if editing}
    <section class="card">
      <h2>Edit trip</h2>
      <form
        method="POST"
        action="?/update_trip"
        use:enhance={() =>
          async ({ update }) => {
            await update();
            editing = false;
          }}
      >
        <label class="grow-field"
          ><span>Name</span>
          <input type="text" name="name" value={data.trip.name} required />
        </label>
        <label
          ><span>Start</span><DatePicker
            name="start_date"
            value={data.trip.start_date}
          /></label
        >
        <label
          ><span>End</span><DatePicker
            name="end_date"
            value={data.trip.end_date}
          /></label
        >
        <label class="grow-field"
          ><span>Notes</span>
          <textarea name="notes" rows="2" placeholder="Trip notes…"
            >{data.trip.notes ?? ""}</textarea
          >
        </label>
        <button type="submit">Save</button>
      </form>
    </section>
  {/if}

  {#if mapStops.length > 0 || mapExtra}
    <section class="card map-card">
      {#key mapStops
        .map((s) => `${s.lat},${s.lng}`)
        .join("|") + (mapExtra ? `+${mapExtra.lat}` : "")}
        <TripMap
          stops={mapStops}
          extra={mapExtra}
          onSummary={(s) => (routeSummary = s)}
        />
      {/key}
      {#if routeSummary || routeUrl}
        <div class="route-bar">
          {#if routeSummary}
            <p class="route-summary">
              🚗 ~{formatDistance(routeSummary.km, distanceUnit)} ·
              {formatDuration(routeSummary.min)} driving (in order)
            </p>
          {/if}
          {#if routeUrl}
            <a class="navigate" href={routeUrl} target="_blank" rel="noopener"
              >🧭 Navigate all stops ↗</a
            >
          {/if}
        </div>
      {/if}
    </section>
  {/if}

  {#if data.weather && data.weather.periods.length > 0}
    <section class="card">
      <div class="wx-head">
        <h2>
          Weather{#if data.weather.locationLabel}
            · {data.weather.locationLabel}{/if}
        </h2>
        {#if data.weather.stale}<Badge kind="stale" label="cached" />{/if}
      </div>
      <div class="wx-periods">
        {#each data.weather.periods as p (p.name)}
          <div class="wx-period" class:night={!p.isDaytime}>
            <div class="wx-name">{p.name}</div>
            <div class="wx-temp">{p.tempF}°F</div>
            <div class="wx-short">{p.shortForecast}</div>
            <div class="wx-wind">
              {p.windDirection}
              {p.windSpeed}{#if p.precipPct != null && p.precipPct > 0}
                · {p.precipPct}% precip{/if}
            </div>
          </div>
        {/each}
      </div>
      <p class="wx-attr">
        Weather from the US <a
          href="https://www.weather.gov"
          target="_blank"
          rel="noopener">National Weather Service</a
        >.
      </p>
    </section>
  {/if}

  <section class="card">
    <div class="stops-head">
      <h2>Stops</h2>
      <div class="stops-actions">
        {#if data.stops.length > 0 && data.canEdit}
          <form
            method="POST"
            action="?/field_tips"
            use:enhance={() => {
              tipsLoading = true;
              return async ({ update }) => {
                await update();
                tipsLoading = false;
              };
            }}
          >
            <button type="submit" class="small tips-btn" disabled={tipsLoading}>
              {tipsLoading ? "Thinking…" : "💡 Field tips"}
            </button>
          </form>
        {/if}
        {#if data.stops.length >= 3 && data.canEdit}
          <button
            type="button"
            class="small optimize"
            onclick={runOptimize}
            disabled={optimizing}
          >
            {optimizing ? "Optimizing…" : "↕ Optimize order"}
          </button>
        {/if}
      </div>
    </div>
    {#if data.canEdit}
      <!-- hidden: client computes the driving order, posts it here to persist -->
      <form
        bind:this={orderForm}
        method="POST"
        action="?/set_order"
        use:enhance={() =>
          async ({ update }) => {
            await update();
            optimizing = false;
          }}
        hidden
      >
        <input type="hidden" name="order" value={orderValue} />
      </form>
      <!-- hidden: straight-line fallback when Directions is unavailable -->
      <form
        bind:this={fallbackForm}
        method="POST"
        action="?/optimize"
        use:enhance={() =>
          async ({ update }) => {
            await update();
            optimizing = false;
          }}
        hidden
      ></form>
    {/if}
    {#if data.stops.length === 0}
      <p class="muted">No stops yet — add one below.</p>
    {/if}
    {#each data.stops as s, i (s.id)}
      <div class="stop">
        <div class="ordnum">{i + 1}</div>
        <div class="grow">
          <div class="name">
            {#if s.hotspot_id}
              <a
                class="place-link"
                href={`https://ebird.org/hotspot/${s.hotspot_id}`}
                target="_blank"
                rel="noopener">{s.custom_name ?? "Stop"}</a
              >
              <a
                class="hotspot-badge"
                href={`https://ebird.org/hotspot/${s.hotspot_id}`}
                target="_blank"
                rel="noopener"
                title="eBird hotspot">eBird hotspot ↗</a
              >
            {:else}
              {s.custom_name ?? "Stop"}
            {/if}
          </div>
          <div class="meta">
            {#if !data.hasApiKey}
              <a href="/settings">add eBird key</a> for needs counts
            {:else if data.needsCounts[String(s.id)] !== undefined}
              {data.needsCounts[String(s.id)]} of your needs reported here · last
              14 days, ≤{formatDistance(16, distanceUnit)}
              {#if data.needsStale}<Badge kind="stale" label="cached" />{/if}
            {:else}
              —
            {/if}
          </div>
          <MapLink
            lat={s.lat}
            lng={s.lon}
            name={s.custom_name ?? s.hotspot_id ?? "Stop"}
            googlePlaceId={s.google_place_id}
          />
          {#if s.notes}<div class="stopnote">{s.notes}</div>{/if}
          {#if form && "tips" in form && form.tips?.[s.id]}
            <div class="aitip">
              💡 {form.tips[s.id]}
              <span class="aiverify">AI suggestion — verify in the field</span>
            </div>
          {/if}
          {#if data.canEdit}
            <details class="noteedit">
              <summary>{s.notes ? "Edit note" : "Add note"}</summary>
              <form method="POST" action="?/save_notes" use:enhance>
                <input type="hidden" name="stop_id" value={s.id} />
                <textarea
                  name="notes"
                  rows="2"
                  placeholder="e.g. scope the lagoon spit at low tide"
                  >{s.notes ?? ""}</textarea
                >
                <button type="submit" class="small">Save note</button>
              </form>
            </details>
          {/if}
        </div>
        {#if data.canEdit}
          <div class="stop-actions">
            <form method="POST" action="?/move_stop" use:enhance>
              <input type="hidden" name="stop_id" value={s.id} />
              <input type="hidden" name="direction" value="up" />
              <button
                type="submit"
                class="icon"
                aria-label="Move up"
                disabled={i === 0}>↑</button
              >
            </form>
            <form method="POST" action="?/move_stop" use:enhance>
              <input type="hidden" name="stop_id" value={s.id} />
              <input type="hidden" name="direction" value="down" />
              <button
                type="submit"
                class="icon"
                aria-label="Move down"
                disabled={i === data.stops.length - 1}>↓</button
              >
            </form>
            <form method="POST" action="?/remove_stop" use:enhance>
              <input type="hidden" name="stop_id" value={s.id} />
              <button type="submit" class="icon danger" aria-label="Remove stop"
                >✕</button
              >
            </form>
          </div>
        {/if}
      </div>
    {/each}
  </section>

  {#if data.canEdit}
    <section class="card">
      <h2>Add a stop</h2>
      <p class="muted intro">
        Search a place to add it directly, or pick a nearby eBird hotspot.
      </p>
      <form method="GET" class="search">
        <input
          type="text"
          name="hs"
          value={data.hs}
          placeholder="Search a place — park, town, address…"
        />
        <button type="submit">Search</button>
      </form>
      {#if data.hsError}<p class="err">{data.hsError}</p>{/if}

      {#if data.hsCenter}
        <div class="result">
          <div class="grow">
            <div class="name">{data.hsCenter.label}</div>
            <div class="meta">Add this exact location as a custom stop</div>
          </div>
          <form method="POST" action="?/add_place" use:enhance>
            <input type="hidden" name="name" value={data.hsCenter.label} />
            <input type="hidden" name="lat" value={data.hsCenter.lat} />
            <input type="hidden" name="lon" value={data.hsCenter.lng} />
            <input
              type="hidden"
              name="google_place_id"
              value={data.hsCenter.googlePlaceId ?? ""}
            />
            <button type="submit" class="small primary">+ Add</button>
          </form>
        </div>
      {/if}

      {#if data.hotspots.length > 0}
        <h3 class="sub2">eBird hotspots nearby</h3>
        {#each data.hotspots as h (h.locId)}
          <div class="result">
            <div class="grow">
              <div class="name">{h.locName}</div>
              <div class="meta">
                {#if h.numSpeciesAllTime}{h.numSpeciesAllTime} species all-time{/if}
                {#if h.latestObsDt}· last report {h.latestObsDt.slice(
                    0,
                    10,
                  )}{/if}
              </div>
            </div>
            <form method="POST" action="?/add_hotspot" use:enhance>
              <input type="hidden" name="loc_id" value={h.locId} />
              <input type="hidden" name="name" value={h.locName} />
              <input type="hidden" name="lat" value={h.lat} />
              <input type="hidden" name="lon" value={h.lng} />
              <input
                type="hidden"
                name="google_place_id"
                value={h.googlePlaceId ?? ""}
              />
              <button type="submit" class="small primary">+ Add</button>
            </form>
          </div>
        {/each}
      {/if}
    </section>

    <section class="card">
      <button class="danger-btn" onclick={() => (deleteOpen = true)}
        >Delete trip…</button
      >
    </section>
  {/if}

  <p class="attribution">
    Data from <a href="https://ebird.org" target="_blank" rel="noopener"
      >eBird.org</a
    >
  </p>
</div>

<!-- Destructive action → modal confirmation (cs.md) -->
{#if deleteOpen}
  <div
    class="modal-overlay"
    role="dialog"
    aria-modal="true"
    aria-labelledby="del-title"
  >
    <div class="modal">
      <h3 id="del-title">Delete this trip?</h3>
      <p>
        “{data.trip.name}” and its {data.stops.length}
        {data.stops.length === 1 ? "stop" : "stops"} will be permanently deleted.
        Your life list and photos are not affected.
      </p>
      <div class="actions">
        <button class="btn" onclick={() => (deleteOpen = false)}>Cancel</button>
        <form method="POST" action="?/delete_trip" use:enhance>
          <button type="submit" class="btn danger-solid">Delete trip</button>
        </form>
      </div>
    </div>
  </div>
{/if}

<style>
  .page {
    max-width: 1100px;
    margin: 0 auto;
    padding: 16px;
  }
  .page-head {
    margin: 4px 0 16px;
  }
  .title-row {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  h1 {
    font-size: 1.4rem;
  }
  .sub,
  .muted {
    color: var(--muted);
    font-size: 0.89rem;
  }
  .intro {
    margin-bottom: 10px;
  }
  .notes {
    margin-top: 6px;
  }
  .unit-row {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--muted);
    font-size: 0.83rem;
    font-weight: 600;
    margin-top: 8px;
  }
  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px;
    margin-bottom: 12px;
  }
  .map-card {
    padding: 8px;
  }
  .route-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    flex-wrap: wrap;
    margin: 8px 4px 2px;
  }
  .route-summary {
    font-size: 0.85rem;
    font-weight: 600;
    color: var(--muted);
    margin: 0;
  }
  .navigate {
    margin-left: auto;
    min-height: 40px;
    display: inline-flex;
    align-items: center;
    padding: 8px 14px;
    border: 1px solid var(--accent);
    border-radius: 8px;
    background: var(--accent);
    color: #fff;
    font-size: 0.85rem;
    font-weight: 600;
    text-decoration: none;
  }
  .navigate:hover {
    filter: brightness(0.95);
  }
  .wx-head {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 10px;
  }
  .wx-head h2 {
    margin-bottom: 0;
  }
  .wx-periods {
    display: flex;
    gap: 10px;
    overflow-x: auto;
    padding-bottom: 4px;
  }
  .wx-period {
    flex: 0 0 auto;
    min-width: 130px;
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 10px;
    background: var(--bg);
  }
  .wx-period.night {
    background: var(--card);
  }
  .wx-name {
    font-weight: 700;
    font-size: 0.85rem;
  }
  .wx-temp {
    font-size: 1.3rem;
    font-weight: 700;
    color: var(--accent);
    margin: 2px 0;
  }
  .wx-short {
    font-size: 0.82rem;
  }
  .wx-wind {
    font-size: 0.78rem;
    color: var(--muted);
    margin-top: 4px;
  }
  .wx-attr {
    text-align: left;
    color: var(--muted);
    font-size: 0.76rem;
    margin-top: 8px;
  }
  .wx-attr a {
    color: var(--muted);
  }
  .stops-actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .tips-btn {
    background: var(--card);
    border: 1px solid var(--accent);
    color: var(--accent);
  }
  .tips-btn:hover:not(:disabled) {
    background: var(--accent-soft);
  }
  .aitip {
    margin-top: 6px;
    padding: 8px 10px;
    background: var(--accent-soft);
    border-left: 3px solid var(--accent);
    border-radius: 6px;
    font-size: 0.85rem;
  }
  .aiverify {
    display: block;
    color: var(--muted);
    font-size: 0.76rem;
    font-style: italic;
    margin-top: 3px;
  }
  .card h2 {
    font-size: 1.05rem;
    margin-bottom: 10px;
  }
  .stops-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  .stops-head h2 {
    margin-bottom: 10px;
  }
  .optimize {
    background: var(--card);
    border: 1px solid var(--accent);
    color: var(--accent);
  }
  .optimize:hover {
    background: var(--accent-soft);
  }
  .sub2 {
    font-size: 0.9rem;
    margin: 12px 0 4px;
    color: var(--muted);
  }
  button.link {
    min-height: auto;
    padding: 4px 0;
    background: none;
    border: none;
    color: var(--link);
    font-weight: 600;
    font-size: 0.85rem;
    text-decoration: underline;
  }

  form {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    align-items: flex-end;
  }
  form label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--muted);
  }
  .grow-field {
    flex: 1;
    min-width: 200px;
  }
  input,
  textarea {
    min-height: 48px;
    padding: 8px 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--card);
    color: var(--text);
    font-family: inherit;
  }
  .grow-field input,
  .grow-field textarea {
    width: 100%;
  }
  textarea {
    min-height: 60px;
  }
  button {
    min-height: 48px;
    padding: 10px 20px;
    border-radius: 8px;
    border: 1px solid var(--accent);
    background: var(--accent);
    color: #fff;
    font-weight: 600;
  }
  button.small {
    min-height: 40px;
    padding: 8px 14px;
    font-size: 0.85rem;
  }
  button:disabled {
    opacity: 0.4;
  }

  .stop {
    display: flex;
    gap: 12px;
    padding: 12px 0;
    border-top: 1px solid var(--border);
    align-items: flex-start;
  }
  .stop:first-of-type {
    border-top: none;
  }
  .ordnum {
    flex: 0 0 28px;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    background: var(--accent);
    color: #fff;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 700;
    font-size: 0.85rem;
  }
  .grow {
    flex: 1;
    min-width: 0;
  }
  .name {
    font-weight: 700;
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .place-link {
    color: var(--text);
    text-decoration: underline;
    text-decoration-thickness: 1px;
    text-underline-offset: 2px;
  }
  .hotspot-badge {
    background: #e8f2ff;
    border: 1px solid #bfd8ff;
    border-radius: 999px;
    color: #165c9f;
    font-size: 0.68rem;
    font-weight: 800;
    letter-spacing: 0.02em;
    padding: 2px 7px;
    text-decoration: none;
    text-transform: uppercase;
  }
  .meta {
    color: var(--muted);
    font-size: 0.83rem;
    margin-top: 2px;
  }
  .meta a {
    color: var(--link);
  }
  .stopnote {
    font-size: 0.85rem;
    margin-top: 4px;
    font-style: italic;
    color: var(--text);
  }
  .noteedit {
    margin-top: 6px;
  }
  .noteedit summary {
    cursor: pointer;
    color: var(--link);
    font-size: 0.8rem;
    min-height: 32px;
    display: flex;
    align-items: center;
  }
  .noteedit form {
    margin-top: 6px;
    flex-direction: column;
    align-items: stretch;
  }
  .noteedit textarea {
    width: 100%;
  }
  .noteedit button {
    align-self: flex-start;
  }

  .stop-actions {
    display: flex;
    flex-direction: column;
    gap: 4px;
    flex-shrink: 0;
  }
  .stop-actions form {
    display: inline;
  }
  button.icon {
    min-height: 36px;
    width: 36px;
    padding: 0;
    background: var(--card);
    border: 1px solid var(--border);
    color: var(--text);
    font-weight: 700;
  }
  button.icon:hover:not(:disabled) {
    background: var(--bg);
  }
  button.icon.danger {
    color: var(--danger);
    border-color: #d9a5ab;
  }

  .result {
    display: flex;
    gap: 12px;
    align-items: center;
    padding: 10px 0;
    border-top: 1px solid var(--border);
  }
  .result:first-of-type {
    border-top: none;
  }
  .search input {
    flex: 1;
    min-width: 200px;
  }

  .ok {
    color: var(--seen-text);
    font-weight: 600;
  }
  .err {
    color: var(--danger);
    font-weight: 600;
  }
  .danger-btn {
    background: var(--card);
    border: 1px solid #d9a5ab;
    color: var(--danger);
  }
  .danger-btn:hover {
    background: #fdf0f1;
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
  .modal {
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
  .modal .actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
  }
  .btn {
    min-height: 48px;
    padding: 10px 20px;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: var(--card);
    color: var(--text);
    font-weight: 600;
  }
  .btn.danger-solid {
    background: var(--danger);
    border-color: var(--danger);
    color: #fff;
  }

  @media (min-width: 640px) {
    .page {
      padding: 24px;
    }
    h1 {
      font-size: 1.6rem;
    }
  }
</style>
