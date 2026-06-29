<script lang="ts">
  import { enhance } from "$app/forms";
  import Badge from "$components/Badge.svelte";
  import DistanceUnitToggle from "$components/DistanceUnitToggle.svelte";
  import MapLink from "$components/MapLink.svelte";
  import MapPicker, { type PickedLocation } from "$components/MapPicker.svelte";
  import TripMap, { type MapStop } from "$components/TripMap.svelte";
  import {
    formatDistance,
    nearestNeighborOrder,
    type DistanceUnit,
  } from "$lib/geo";
  import { plannerTargetNote } from "$lib/planner-note";
  import { untrack } from "svelte";
  import type { ActionData, PageData } from "./$types";

  let { data, form }: { data: PageData; form: ActionData } = $props();

  let saving = $state(false);
  let distanceUnit = $state<DistanceUnit>("mi");

  // Map-pick anchor (option "b"): a dropped pin sets exact lat/lng plus a
  // reverse-geocoded label. Coords ride along in hidden fields; the label fills
  // the "Near" box. Typing in "Near" clears the coords so the text geocodes.
  let showPicker = $state(false);
  let picked = $state<PickedLocation | null>(null);
  // Seeded once from the URL (direct load/refresh); thereafter this client state
  // is the source of truth and persists across the GET-form re-navigation.
  let placeText = $state(untrack(() => data.inputs.place));
  let pickedLat = $state<number | null>(untrack(() => data.inputs.placeLat));
  let pickedLng = $state<number | null>(untrack(() => data.inputs.placeLng));

  $effect(() => {
    if (picked) {
      placeText = picked.label;
      pickedLat = picked.lat;
      pickedLng = picked.lng;
    }
  });

  function onPlaceInput() {
    // Manual typing overrides a dropped pin → geocode the text instead.
    pickedLat = null;
    pickedLng = null;
  }

  type PreviewStop = NonNullable<PageData["preview"]>["stops"][number];
  type Candidate = NonNullable<PageData["query"]>["candidates"][number];

  const candKey = (c: { locId: string | null; lat: number; lng: number }) =>
    c.locId ?? `${c.lat},${c.lng}`;
  const stopKey = (s: PreviewStop) => s.hotspotId ?? `${s.lat},${s.lng}`;

  function noteFor(c: Candidate): string {
    const names = c.triggerSpecies.slice(0, 4).map((t) => t.comName);
    const extra = c.triggerSpecies.length - names.length;
    return plannerTargetNote(names, c.lastObsDt.slice(0, 10), extra);
  }

  // eBird hotspot stats (species all-time + last report), keyed by locId from
  // the server's one geo call. Empty string when the spot isn't an eBird hotspot.
  function hotspotMetaLine(locId: string | null | undefined): string {
    const m = locId ? data.hotspotMeta[locId] : undefined;
    if (!m) return "";
    const parts: string[] = [];
    if (m.numSpeciesAllTime != null)
      parts.push(`${m.numSpeciesAllTime} species all-time`);
    if (m.latestObsDt) parts.push(`last report ${m.latestObsDt.slice(0, 10)}`);
    return parts.join(" · ");
  }

  // Reactive defaults from the current plan. The historical stop isn't in the
  // candidate list, so it gets its own toggle.
  let historicalStop = $derived<PreviewStop | null>(
    data.preview?.stops.find((s) => s.kind === "historical") ?? null,
  );
  let defaultKeys = $derived(
    (data.preview?.stops ?? [])
      .filter((s) => s.kind === "hotspot")
      .map(stopKey),
  );
  // Identity of the current plan; changes whenever new filters produce a new
  // result, which re-seeds curation (the component is reused across same-route
  // navigations, so this can't rely on a remount).
  let planSig = $derived(
    (data.anchor?.label ?? "") +
      "|" +
      (data.query?.candidates ?? []).map(candKey).join(","),
  );

  // Curation state, seeded from the planner's auto-selection. untrack() marks
  // the initial read as intentional (keeps SSR correct); the $effect re-seeds
  // when a new plan loads. The candidate list lets you add/remove freely (no cap).
  let selected = $state(untrack(() => new Set(defaultKeys)));
  let includeHistorical = $state(untrack(() => !!historicalStop));
  let appliedSig = $state(untrack(() => planSig));

  $effect(() => {
    if (planSig !== appliedSig) {
      appliedSig = planSig;
      selected = new Set(defaultKeys);
      includeHistorical = !!historicalStop;
    }
  });

  function toggle(key: string) {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    selected = next;
  }

  // Selected hotspots in candidate-rank order, mapped to the stop shape.
  let hotspotStops = $derived<PreviewStop[]>(
    (data.query?.candidates ?? [])
      .filter((c) => selected.has(candKey(c)))
      .map((c) => ({
        hotspotId: c.locId,
        name: c.locName,
        lat: c.lat,
        lng: c.lng,
        googlePlaceId: c.googlePlaceId,
        matchCount: c.matchCount,
        triggerSpecies: c.triggerSpecies,
        kind: "hotspot" as const,
        note: noteFor(c),
      })),
  );

  // Final ordered itinerary: hotspots (+ historical if kept), nearest-neighbor
  // ordered from the anchor — the same logic the server uses, recomputed live.
  let stops = $derived.by<PreviewStop[]>(() => {
    const all = [...hotspotStops];
    if (includeHistorical && historicalStop) all.push(historicalStop);
    return data.anchor && all.length > 1
      ? nearestNeighborOrder(
          { lat: data.anchor.lat, lng: data.anchor.lng },
          all,
        )
      : all;
  });

  let distinctNeeds = $derived(
    new Set(hotspotStops.flatMap((s) => s.triggerSpecies.map((t) => t.code)))
      .size,
  );

  let mapStops = $derived<MapStop[]>(
    stops.map((s, i) => ({
      lat: s.lat,
      lng: s.lng,
      label: s.name,
      order: i + 1,
    })),
  );
  let mapAnchor = $derived<MapStop | null>(
    data.anchor
      ? {
          lat: data.anchor.lat,
          lng: data.anchor.lng,
          label: data.anchor.label,
          order: 0,
        }
      : null,
  );

  // What Save persists — exactly the curated, ordered stops (no drift).
  let saveStops = $derived(
    JSON.stringify(
      stops.map((s) => ({
        hotspot_id: s.hotspotId,
        name: s.name,
        lat: s.lat,
        lon: s.lng,
        google_place_id: s.googlePlaceId,
        notes: s.note,
        target_count_at_save: s.matchCount,
      })),
    ),
  );
</script>

<svelte:head>
  <title>Plan a trip — birds</title>
</svelte:head>

<div class="page">
  <header class="page-head">
    <p class="sub"><a href="/trips">← Trips</a></p>
    <h1>Plan a trip</h1>
    <p class="sub">
      Find hotspots near a place that have enough of your needs, and build a
      route.
    </p>
  </header>

  <section class="card">
    <form method="GET" class="filters">
      <input type="hidden" name="lat" value={pickedLat ?? ""} />
      <input type="hidden" name="lng" value={pickedLng ?? ""} />
      <label class="grow-field">
        <span>Near</span>
        <input
          type="text"
          name="place"
          placeholder="City, county, park, or address…"
          bind:value={placeText}
          oninput={onPlaceInput}
        />
      </label>
      <label>
        <span>Radius</span>
        <select name="radius">
          {#each [5, 10, 15, 25] as mi (mi)}
            <option value={mi} selected={data.inputs.radiusMi === mi}
              >{mi} mi</option
            >
          {/each}
        </select>
      </label>
      <label>
        <span>Window</span>
        <select name="back">
          {#each [7, 14, 30] as d (d)}
            <option value={d} selected={data.inputs.back === d}
              >Last {d} days</option
            >
          {/each}
        </select>
      </label>
      <label>
        <span>Stops</span>
        <select name="stops">
          {#each [2, 3, 4, 5] as n (n)}
            <option value={n} selected={data.inputs.stops === n}>{n}</option>
          {/each}
        </select>
      </label>
      <label>
        <span>Min needs/stop</span>
        <select name="minneeds">
          {#each [1, 2, 3, 5] as n (n)}
            <option value={n} selected={data.inputs.minNeeds === n}>{n}</option>
          {/each}
        </select>
      </label>
      <label>
        <span>Count</span>
        <select name="seen">
          <option value="needs" selected={data.inputs.seenStatus === "needs"}
            >My needs</option
          >
          <option value="all" selected={data.inputs.seenStatus === "all"}
            >All species</option
          >
        </select>
      </label>
      <label class="check">
        <input
          type="checkbox"
          name="rare"
          value="1"
          checked={data.inputs.rareOnly}
        />
        <span>Rare only</span>
      </label>
      <label class="check">
        <input
          type="checkbox"
          name="hist"
          value="1"
          checked={data.inputs.includeHistorical}
        />
        <span>Add a historical stop</span>
      </label>
      <button type="submit">Plan</button>
    </form>
    <button
      type="button"
      class="pick-toggle"
      aria-expanded={showPicker}
      onclick={() => (showPicker = !showPicker)}
    >
      📍 {showPicker ? "Hide map" : "Pick on map"}
    </button>
    {#if showPicker}
      <div class="picker-wrap">
        <p class="muted">
          Tap the map (or drag the pin) to drop your start point, then press
          <strong>Plan</strong>.
        </p>
        <MapPicker
          bind:selected={picked}
          initialLat={data.anchor?.lat ?? null}
          initialLng={data.anchor?.lng ?? null}
        />
      </div>
    {/if}
    {#if data.anchor}
      <p class="muted loc">
        📍 {data.anchor.label} · {data.inputs.radiusMi} mi · last {data.inputs
          .back} days
      </p>
    {/if}
    <div class="unit-row">
      <span>Distance units</span>
      <DistanceUnitToggle bind:unit={distanceUnit} />
    </div>
  </section>

  {#if form?.error}
    <section class="card"><p class="err" role="alert">{form.error}</p></section>
  {/if}

  {#each data.errors as e (e)}
    <section class="card"><p class="err" role="alert">{e}</p></section>
  {/each}

  {#if data.needsLocation}
    <section class="card">
      <p class="muted">
        Enter a place above, or <a href="/settings">set your home location</a> to
        default to it.
      </p>
    </section>
  {/if}

  {#if data.preview}
    {#if mapStops.length > 0}
      <section class="card map-card">
        {#key mapStops.map((s) => `${s.lat},${s.lng}`).join("|")}
          <TripMap stops={mapStops} extra={mapAnchor} />
        {/key}
      </section>
    {/if}

    <section class="card">
      <div class="preview-head">
        <h2>Trip preview</h2>
        {#if data.preview.stale}<Badge kind="stale" label="cached" />{/if}
      </div>

      {#each data.preview.warnings as w (w)}
        <p class="warn">{w}</p>
      {/each}

      {#if stops.length === 0}
        <p class="muted">
          No stops selected — add hotspots from the list below, or loosen the
          filters and re-plan.
        </p>
      {:else}
        <p class="muted summary">
          {stops.length}
          {stops.length === 1 ? "stop" : "stops"} ·
          {distinctNeeds} distinct {data.inputs.seenStatus === "needs"
            ? "needs"
            : "species"} across the route
        </p>

        {#each stops as s, i (stopKey(s))}
          <div class="stop">
            <div class="ordnum" class:hist={s.kind === "historical"}>
              {i + 1}
            </div>
            <div class="grow">
              <div class="name">
                {s.name}
                {#if s.kind === "historical"}<Badge
                    kind="notable"
                    label="history"
                  />{:else}<Badge
                    kind="seen"
                    label={`${s.matchCount} ${s.matchCount === 1 ? "need" : "needs"}`}
                  />{/if}
              </div>
              {#if s.triggerSpecies.length}
                <div class="meta">
                  {s.triggerSpecies.map((t) => t.comName).join(", ")}
                </div>
              {/if}
              {#if hotspotMetaLine(s.hotspotId)}
                <div class="meta hsmeta">{hotspotMetaLine(s.hotspotId)}</div>
              {/if}
              <div class="stopnote">{s.note}</div>
              <MapLink
                lat={s.lat}
                lng={s.lng}
                name={s.name}
                googlePlaceId={s.googlePlaceId}
              />
            </div>
            <button
              type="button"
              class="remove"
              onclick={() =>
                s.kind === "historical"
                  ? (includeHistorical = false)
                  : toggle(stopKey(s))}
              aria-label="Remove {s.name}">Remove</button
            >
          </div>
        {/each}
      {/if}

      {#if historicalStop && !includeHistorical}
        <button
          type="button"
          class="add-hist"
          onclick={() => (includeHistorical = true)}
          >+ Add historical stop — {historicalStop.name}</button
        >
      {/if}

      {#if stops.length > 0}
        {#if data.canEdit}
          <form
            method="POST"
            action="?/save"
            class="save"
            use:enhance={() => {
              saving = true;
              return async ({ update }) => {
                await update();
                saving = false;
              };
            }}
          >
            <input type="hidden" name="stops" value={saveStops} />
            <label class="grow-field">
              <span>Trip name</span>
              <input
                type="text"
                name="name"
                value={data.preview.suggestedName}
                required
              />
            </label>
            <button type="submit" disabled={saving}
              >{saving ? "Saving…" : "Save trip"}</button
            >
          </form>
        {/if}
      {/if}
    </section>
  {/if}

  {#if data.query && data.query.candidates.length > 0}
    <section class="card">
      <h2>All matching places ({data.query.candidates.length})</h2>
      <p class="muted intro">
        Every hotspot in range with {data.inputs.seenStatus === "needs"
          ? "your needs"
          : "species"} reported, ranked. Add or remove any to curate the trip above
        before saving.
      </p>
      {#each data.query.candidates as c (c.locId ?? c.locName)}
        {@const inTrip = selected.has(candKey(c))}
        <div class="obs">
          <div class="grow">
            <div class="name">
              {c.locName}
              {#if inTrip}<Badge kind="seen" label="in trip" />{/if}
              {#if !c.eligible}<Badge kind="stale" label="below min" />{/if}
            </div>
            <div class="meta">
              {c.triggerSpecies.map((t) => t.comName).join(", ")}
            </div>
            {#if hotspotMetaLine(c.locId)}
              <div class="meta hsmeta">{hotspotMetaLine(c.locId)}</div>
            {/if}
            <div class="links">
              <MapLink
                lat={c.lat}
                lng={c.lng}
                name={c.locName}
                googlePlaceId={c.googlePlaceId}
              />
              {#if c.locId}
                <a
                  href={`https://ebird.org/hotspot/${c.locId}`}
                  target="_blank"
                  rel="noopener">eBird hotspot ↗</a
                >
              {/if}
            </div>
          </div>
          <div class="right">
            <div class="count">{c.matchCount}</div>
            <div class="when">{formatDistance(c.distanceKm, distanceUnit)}</div>
            {#if data.canEdit}
              <button
                type="button"
                class="toggle"
                class:in={inTrip}
                onclick={() => toggle(candKey(c))}
                >{inTrip ? "Remove" : "+ Add"}</button
              >
            {/if}
          </div>
        </div>
      {/each}
    </section>
  {/if}

  <p class="attribution">
    Data from <a href="https://ebird.org" target="_blank" rel="noopener"
      >eBird.org</a
    >
  </p>
</div>

<style>
  .page {
    max-width: 1100px;
    margin: 0 auto;
    padding: 16px;
  }
  .page-head {
    margin: 4px 0 16px;
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
    margin-bottom: 8px;
  }
  .loc {
    margin-top: 10px;
    font-weight: 600;
  }
  .summary {
    margin-bottom: 10px;
    font-weight: 600;
  }
  .unit-row {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--muted);
    font-size: 0.83rem;
    font-weight: 600;
    margin-top: 10px;
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
  .card h2 {
    font-size: 1.05rem;
    margin-bottom: 10px;
  }
  .preview-head {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 6px;
  }
  .preview-head h2 {
    margin-bottom: 0;
  }

  .filters {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: flex-end;
  }
  .filters label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--muted);
  }
  .filters .grow-field {
    flex: 1;
    min-width: 200px;
  }
  .filters .check {
    flex-direction: row;
    align-items: center;
    gap: 6px;
    min-height: 48px;
  }
  .filters .check input {
    min-height: 0;
    width: 18px;
    height: 18px;
  }
  .filters input,
  .filters select {
    min-height: 48px;
    padding: 8px 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--card);
    color: var(--text);
    font-family: inherit;
    font-size: 16px;
  }
  .filters .grow-field input {
    width: 100%;
  }
  .filters button {
    min-height: 48px;
    padding: 10px 20px;
    border-radius: 8px;
    border: 1px solid var(--accent);
    background: var(--accent);
    color: #fff;
    font-weight: 600;
  }

  .pick-toggle {
    margin-top: 10px;
    min-height: 40px;
    padding: 8px 14px;
    border-radius: 8px;
    border: 1px dashed var(--accent);
    background: var(--card);
    color: var(--accent);
    font-size: 0.85rem;
    font-weight: 600;
  }
  .pick-toggle:hover {
    background: var(--accent-soft);
  }
  .picker-wrap {
    margin-top: 10px;
  }
  .picker-wrap .muted {
    margin-bottom: 8px;
  }

  .warn {
    color: var(--danger);
    font-size: 0.85rem;
    margin: 4px 0;
  }
  .err {
    color: var(--danger);
    font-weight: 600;
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
  .ordnum.hist {
    background: #842029;
  }
  .grow {
    flex: 1;
    min-width: 0;
  }
  .name {
    font-weight: 700;
  }
  .meta {
    color: var(--muted);
    font-size: 0.83rem;
    margin-top: 2px;
  }
  .hsmeta {
    font-size: 0.78rem;
    opacity: 0.85;
  }
  .stopnote {
    font-size: 0.85rem;
    margin-top: 4px;
    font-style: italic;
    color: var(--text);
  }
  .remove {
    flex-shrink: 0;
    align-self: center;
    min-height: 36px;
    padding: 6px 12px;
    border-radius: 8px;
    border: 1px solid #d9a5ab;
    background: var(--card);
    color: var(--danger);
    font-size: 0.8rem;
    font-weight: 600;
  }
  .remove:hover {
    background: #fdf0f1;
  }
  .add-hist {
    margin-top: 12px;
    min-height: 40px;
    padding: 8px 14px;
    border-radius: 8px;
    border: 1px dashed var(--accent);
    background: var(--card);
    color: var(--accent);
    font-size: 0.85rem;
    font-weight: 600;
  }
  .add-hist:hover {
    background: var(--accent-soft);
  }
  .toggle {
    margin-top: 6px;
    min-height: 34px;
    padding: 5px 12px;
    border-radius: 8px;
    border: 1px solid var(--accent);
    background: var(--accent);
    color: #fff;
    font-size: 0.8rem;
    font-weight: 600;
  }
  .toggle.in {
    background: var(--card);
    color: var(--danger);
    border-color: #d9a5ab;
  }
  .links {
    display: flex;
    gap: 14px;
    flex-wrap: wrap;
    margin-top: 4px;
  }
  .links a {
    color: var(--link);
    font-size: 0.83rem;
    font-weight: 600;
  }

  .save {
    margin-top: 16px;
    padding-top: 16px;
    border-top: 1px solid var(--border);
    display: flex;
    gap: 8px;
    align-items: flex-end;
    flex-wrap: wrap;
  }
  .save label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--muted);
  }
  .save .grow-field {
    flex: 1;
    min-width: 200px;
  }
  .save input {
    min-height: 48px;
    padding: 8px 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--card);
    color: var(--text);
    width: 100%;
    font-size: 16px;
  }
  .save button {
    min-height: 48px;
    padding: 10px 20px;
    border-radius: 8px;
    border: 1px solid var(--accent);
    background: var(--accent);
    color: #fff;
    font-weight: 600;
  }
  .save button:disabled {
    opacity: 0.5;
  }

  .obs {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 12px 0;
    border-top: 1px solid var(--border);
  }
  .obs:first-of-type {
    border-top: none;
  }
  .right {
    text-align: right;
    flex-shrink: 0;
  }
  .count {
    font-weight: 700;
    color: var(--accent);
  }
  .when {
    color: var(--muted);
    font-size: 0.78rem;
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
  }
</style>
