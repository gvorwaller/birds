<script lang="ts">
  import { enhance } from "$app/forms";
  import { invalidateAll } from "$app/navigation";
  import type { SubmitFunction } from "@sveltejs/kit";
  import { tick } from "svelte";
  import { env } from "$env/dynamic/public";
  import Badge from "$components/Badge.svelte";
  import DatePicker from "$components/DatePicker.svelte";
  import DistanceUnitToggle from "$components/DistanceUnitToggle.svelte";
  import MapLink from "$components/MapLink.svelte";
  import MapPicker, { type PickedLocation } from "$components/MapPicker.svelte";
  import TripMap, { type MapStop } from "$components/TripMap.svelte";
  import { normalizeTripStopNote, plannerTargetNote } from "$lib/planner-note";
  import { canShareText, isIosDevice, isIosStandalone, shareFile, shareText } from "$lib/share";
  import { optimizeDrivingRoute, formatDuration } from "$lib/route";
  import { formatDistance, mapsRouteUrl, type DistanceUnit } from "$lib/geo";
  import { calendarMonth } from "$lib/forecast-calendar";
  import { page } from "$app/state";
  import PathNavigation from "$components/PathNavigation.svelte";
  import { canonicalHref, withReturnTo } from "$lib/navigation-context";
  import { navigationAction } from "$lib/navigation-context.svelte";
  import { formatLegacyCountSnapshot, formatPlannedCountSnapshot } from "$lib/trip-count-context";
  import { remainingRoute, visitedCountLabel } from "$lib/trip-visited";
  import {
    formatFeet,
    formatTideDate,
    tideWord,
    TIDE_ATTRIBUTION_URL,
  } from "$lib/tide-format";
  import type { ActionData, PageData } from "./$types";

  let { data, form }: { data: PageData; form: ActionData } = $props();

  let editing = $state(false);
  let deleteOpen = $state(false);
  let distanceUnit = $state<DistanceUnit>("mi");

  // Share modal (trips-app pattern, td-8b959f follow-up). In the installed
  // PWA a navigation to a download strands the user — no back control — so
  // export text and the share URL surface IN-APP: modal + system share
  // sheet + copy. The export endpoints stay untouched.
  let shareModal = $state<{ title: string; text: string; error: boolean } | null>(null);
  let shareBusy = $state(false);
  let shareCopied = $state(false);
  let shareSheetError = $state("");
  let shareReturnFocus: HTMLElement | null = null;
  let shareCloseBtn = $state<HTMLButtonElement | null>(null);

  $effect(() => {
    if (shareModal && shareCloseBtn) shareCloseBtn.focus();
  });

  async function openShareText(url: string, title: string) {
    if (shareBusy) return;
    shareBusy = true;
    shareCopied = false;
    shareSheetError = "";
    shareReturnFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    try {
      const res = await fetch(url, { credentials: "same-origin" });
      if (!res.ok) throw new Error(`Export failed: ${res.status}`);
      shareModal = { title, text: await res.text(), error: false };
    } catch {
      shareModal = {
        title,
        text: "Could not load the text. Check your connection and try again.",
        error: true,
      };
    } finally {
      shareBusy = false;
    }
  }

  /** Same modal, no fetch — used to show/copy/share the share-link URL. */
  function openShareValue(text: string, title: string) {
    shareCopied = false;
    shareSheetError = "";
    shareReturnFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    shareModal = { title, text, error: false };
  }

  function closeShareModal() {
    shareModal = null;
    shareCopied = false;
    shareSheetError = "";
    shareReturnFocus?.focus();
    shareReturnFocus = null;
  }

  /** Keep Tab inside the dialog while it is open. */
  function trapShareFocus(e: KeyboardEvent) {
    if (e.key !== "Tab") return;
    const dialog = (e.currentTarget as HTMLElement) ?? null;
    if (!dialog) return;
    const focusables = dialog.querySelectorAll<HTMLElement>(
      'button, [href], textarea, input, [tabindex]:not([tabindex="-1"])',
    );
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  async function runShareSheet() {
    if (!shareModal) return;
    const outcome = await shareText(shareModal.text, shareModal.title);
    // 'cancelled' is the user closing the sheet — quiet, not an error.
    if (outcome === "failed" || outcome === "unavailable") {
      shareSheetError = "Sharing failed here — use Copy instead.";
    }
  }

  async function copyShareText() {
    if (!shareModal) return;
    try {
      await navigator.clipboard.writeText(shareModal.text);
      shareCopied = true;
      setTimeout(() => (shareCopied = false), 1600);
    } catch {
      shareSheetError = "Copy failed — select the text and copy manually.";
    }
  }

  let mdBusy = $state(false);

  /**
   * ⬇ .md without the standalone trap: never a page navigation. iOS gets
   * the system share sheet with the FILE (Save to Files / AirDrop /
   * Messages — proper Done button); the installed app without file-share
   * falls back to the in-app text modal; desktop gets a plain blob
   * download. The server endpoint is untouched — the filename comes from
   * its own Content-Disposition, so there is exactly one slugifier.
   */
  async function downloadMarkdown() {
    if (mdBusy) return;
    mdBusy = true;
    try {
      const res = await fetch(`/trips/${data.trip.id}/export?format=md`, {
        credentials: "same-origin",
      });
      if (!res.ok) throw new Error(`Export failed: ${res.status}`);
      const text = await res.text();
      const filename =
        res.headers.get("content-disposition")?.match(/filename="([^"]+)"/)?.[1] ??
        "trip.md";
      if (isIosDevice()) {
        const file = new File([text], filename, { type: "text/markdown" });
        const outcome = await shareFile(file, data.trip.name);
        if (outcome !== "unavailable") return; // shared/cancelled/failed all stay in-app
        if (isIosStandalone()) {
          // No file share and no safe navigation: the text modal is the exit.
          openShareValue(text, `${data.trip.name} — markdown`);
          return;
        }
      }
      const url = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      openShareValue(
        "Could not load the markdown. Check your connection and try again.",
        "Export failed",
      );
    } finally {
      mdBusy = false;
    }
  }

  const MONTH_ABBR = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  // Forecast links carry the TRIP's month (from its start date) so a stop
  // opens the needs forecast for when you'll actually be there (UX doc #1).
  const tripMonth = $derived.by(() => {
    const sd = data.trip?.start_date;
    if (sd) {
      const d = new Date(`${sd}T12:00:00`);
      if (!Number.isNaN(d.getTime())) return d.getMonth() + 1;
    }
    return calendarMonth();
  });
  const anyTides = $derived(Object.keys(data.tidesByStop ?? {}).length > 0);
  function stopForecastHref(s: {
    lat: number | null;
    lon: number | null;
    custom_name: string | null;
    hotspot_id: string | null;
  }): string {
    const p = new URLSearchParams();
    p.set("lat", s.lat!.toFixed(5));
    p.set("lng", s.lon!.toFixed(5));
    p.set("loc", s.custom_name ?? s.hotspot_id ?? "Trip stop");
    p.set("month", String(tripMonth));
    return withReturnTo(`/forecast?${p.toString()}`, tripContextHref, undefined, data.trip.name);
  }

  const tripContextHref = $derived(canonicalHref(page.url.pathname + page.url.search + page.url.hash) ?? `/trips/${data.trip.id}`);
  function adopt(label: string, originId: string) {
    return (event: MouseEvent) => navigationAction(data.user?.id, { label, originId })(event);
  }

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
        anchor: data.anchor,
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

  // Check-off (td-40a1b5). The tick shows at once; the server's answer then
  // replaces it via the reload, or it reverts with an inline error. A second
  // tap on the same stop while one is in flight is dropped, so responses
  // can't land out of order.
  let pendingVisited = $state<Record<number, boolean>>({});
  let visitedError = $state("");
  const isVisited = (s: { id: number; visited: boolean }) =>
    pendingVisited[s.id] ?? s.visited;
  const visitedCount = $derived(data.stops.filter(isVisited).length);

  // `enhance` ignores later parameter changes, so the new value is read from
  // the submitted form, never captured here.
  function checkOff(stopId: number): SubmitFunction {
    return ({ cancel, formData }) => {
      if (stopId in pendingVisited) {
        cancel();
        return;
      }
      pendingVisited[stopId] = formData.get("visited") === "true";
      visitedError = "";
      return async ({ result }) => {
        try {
          if (result.type === "success") {
            // Reload the data only: update()/applyAction would move focus to
            // <body>, losing a keyboard user's place in the list.
            await invalidateAll();
          } else {
            visitedError =
              result.type === "failure" && typeof result.data?.error === "string"
                ? `${result.data.error} The check-off was not saved.`
                : "Could not save that check-off — it has been undone. Try again.";
            // A 404 means the stop went away (removed elsewhere): show the
            // trip as it is now. Other failures leave the page alone.
            if (result.type === "failure") await invalidateAll();
          }
        } finally {
          delete pendingVisited[stopId];
        }
      };
    };
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
        id: s.id,
        visited: isVisited(s),
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
  // Start & end point (td-0f3c63): the map route, its totals and Optimize
  // order loop from here and back; Navigate ends here.
  let anchorPoint = $derived(
    data.anchor
      ? { lat: data.anchor.lat, lng: data.anchor.lon, label: data.anchor.label }
      : null,
  );
  let anchorOpen = $state(false);
  let anchorPicked = $state<PickedLocation | null>(null);
  const firstLocated = $derived(
    data.stops.find((s) => s.lat != null && s.lon != null) ?? null,
  );
  const locatedStops = $derived(
    data.stops.filter((s) => s.lat != null && s.lon != null),
  );
  // Where the picker opens. MapPicker pre-selects this point, so it must not
  // count as a choice: "Use …" waits for a search or tap (CODEX1 P3 — saving
  // the seed stored "Start & end: <old name>" as the new name).
  const anchorSeed = $derived(
    data.anchor
      ? { lat: data.anchor.lat, lng: data.anchor.lon, label: `Start & end: ${data.anchor.label}` }
      : firstLocated
        ? {
            lat: firstLocated.lat as number,
            lng: firstLocated.lon as number,
            label: firstLocated.custom_name ?? "Stop 1",
          }
        : data.home
          ? { lat: data.home.lat, lng: data.home.lon, label: "Saved home location" }
          : null,
  );
  const anchorChoice = $derived(
    anchorPicked &&
      !(
        anchorSeed &&
        anchorPicked.lat === anchorSeed.lat &&
        anchorPicked.lng === anchorSeed.lng &&
        anchorPicked.label === anchorSeed.label
      )
      ? anchorPicked
      : null,
  );
  const anchorSourceNote = $derived(
    data.anchor?.source === "stop"
      ? "Copied from a stop; moving or removing that stop won't change it."
      : data.anchor?.source === "home"
        ? "Copied from your saved home; changing your home won't change it."
        : "",
  );
  function anchorEnhance() {
    return async ({
      result,
      update,
    }: {
      result: { type: string };
      update: () => Promise<void>;
    }) => {
      await update();
      if (result.type === "success") {
        anchorOpen = false;
        anchorPicked = null;
      }
    };
  }

  // Multi-waypoint Google Maps hand-off: from the device's location through
  // every located stop in order that isn't checked off yet (td-40a1b5), then
  // back to the start & end point when the trip has one.
  let route = $derived(remainingRoute(mapStops, anchorPoint));
  let routeUrl = $derived(route ? mapsRouteUrl(route.points) : "");

  function fmtDates(start: string | null, end: string | null): string {
    if (!start && !end) return "no dates set";
    const f = (d: string) => new Date(d + "T00:00:00").toLocaleDateString();
    if (start && end)
      return start === end ? f(start) : `${f(start)} – ${f(end)}`;
    return f((start ?? end) as string);
  }

  function fmtTipGeneratedAt(value: string | null): string {
    if (!value) return "AI suggestion — verify in the field";
    return `AI suggestion — generated ${new Date(value).toLocaleString()} — verify in the field`;
  }

  function suggestedSpeciesList(
    p: PageData["suggestedHotspots"][number],
  ): string {
    const names = p.needSpecies.map((s) => s.comName);
    const head = names.slice(0, 6).join(", ");
    return head + (names.length > 6 ? ` +${names.length - 6} more` : "");
  }

  function suggestedNote(p: PageData["suggestedHotspots"][number]): string {
    const names = p.needSpecies.slice(0, 4).map((s) => s.comName);
    return plannerTargetNote(
      names,
      p.lastObsDt.slice(0, 10),
      p.needSpecies.length - names.length,
    );
  }
</script>

<svelte:head>
  <title>{data.trip.name} — birds</title>
</svelte:head>

<div class="page">
  <header class="page-head">
    <PathNavigation accountId={data.user?.id} label={data.trip.name} href={page.url.pathname + page.url.search + page.url.hash} fallbackHref="/trips" fallbackLabel="Trips" />
    <div class="title-row">
      <h1>{data.trip.name}</h1>
      {#if data.canEdit}
        <button class="link" onclick={() => (editing = !editing)}
          >{editing ? "Close" : "Edit"}</button
        >
      {/if}
      <!-- Export opens the self-contained HTML field sheet in a tab
           (savable/printable); .md keeps the original download (td-8b959f). -->
      <a
        class="link"
        href={`/trips/${data.trip.id}/export`}
        target="_blank"
        rel="noopener">🔗 Export</a
      >
      <button
        class="link"
        disabled={shareBusy}
        onclick={() =>
          openShareText(
            `/trips/${data.trip.id}/export?format=md`,
            `${data.trip.name} — field sheet`,
          )}>Share text</button
      >
      <button class="link" disabled={mdBusy} onclick={downloadMarkdown}
        >⬇ .md</button
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

  {#if data.canEdit}
    <section class="card sharecard">
      {#if data.share}
        <div class="sharebar">
          <span class="muted"
            >Share link active since {new Date(data.share.created_at).toLocaleDateString(
              "en-US",
            )} — anyone with the link can view this trip's field sheet.</span
          >
          <div class="share-actions">
            <button
              class="btn"
              onclick={() =>
                openShareValue(
                  `${location.origin}/share/trip/${data.share!.token}`,
                  `${data.trip.name} — share link`,
                )}>Show link</button
            >
            <form method="POST" action="?/revoke_share" use:enhance>
              <button type="submit" class="btn">Revoke</button>
            </form>
          </div>
        </div>
      {:else}
        <div class="sharebar">
          <span class="muted"
            >Share this trip's field sheet with a friend — no login needed on their
            end, and you can revoke the link anytime.</span
          >
          <form method="POST" action="?/create_share" use:enhance>
            <button type="submit" class="btn">Create share link</button>
          </form>
        </div>
      {/if}
    </section>
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

  {#if mapStops.length > 0 || mapExtra || anchorPoint}
    <section class="card map-card">
      <!-- Keyed on stop identity + position, not visited: a check-off
           restyles pins in place, while a reorder (even of two stops at the
           same spot) remounts so pin numbers stay matched to their stops. -->
      {#key mapStops
        .map((s) => `${s.id}@${s.lat},${s.lng}`)
        .join("|") +
        (mapExtra ? `+${mapExtra.lat}` : "") +
        (anchorPoint ? `S${anchorPoint.lat},${anchorPoint.lng}` : "")}
        <TripMap
          stops={mapStops}
          extra={mapExtra}
          anchor={anchorPoint}
          onSummary={(s) => (routeSummary = s)}
        />
      {/key}
      {#if routeSummary || routeUrl}
        <div class="route-bar">
          {#if routeSummary}
            <p class="route-summary">
              🚗 ~{formatDistance(routeSummary.km, distanceUnit)} ·
              {formatDuration(routeSummary.min)} driving{#if anchorPoint}, from
                {anchorPoint.label} through the stops in order and back{:else}
                (in order){/if}
            </p>
          {/if}
          {#if route && routeUrl}
            <a class="navigate" href={routeUrl} target="_blank" rel="noopener"
              >🧭 {route.label} ↗</a
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
      <h2>
        Stops{#if data.stops.length > 0}{" "}<span class="visit-count"
            >{visitedCountLabel(visitedCount, data.stops.length)}</span
          >{/if}
      </h2>
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
              {tipsLoading ? "Refreshing…" : "💡 Refresh field tips"}
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
    <div class="anchor">
      {#if data.anchor}
        <div class="anchor-row">
          <span class="anchor-dot" aria-hidden="true">S</span>
          <div class="grow">
            <div class="name">
              {data.anchor.label}
              <span class="anchor-tag">Start &amp; end</span>
            </div>
            <div class="meta">
              The map's route, its drive time and distance, and Optimize order
              run from here, through the stops, and back. {anchorSourceNote}
            </div>
          </div>
        </div>
      {:else if data.canEdit}
        <p class="meta">
          No start &amp; end point: the drive is measured from stop 1 to the last
          stop. Set one, such as your hotel, to see the real day's drive.
        </p>
      {/if}
      {#if data.canEdit}
        <div class="anchor-controls">
          <details class="anchor-edit" bind:open={anchorOpen}>
            <summary
              >{data.anchor ? "Change start & end" : "Set start & end point"}</summary
            >
            <div class="anchor-choices">
              {#if data.home}
                <form
                  method="POST"
                  action="?/set_anchor"
                  use:enhance={anchorEnhance}
                >
                  <input type="hidden" name="source" value="home" />
                  <button type="submit" class="small"
                    >⌂ Use my saved home ({data.home.label?.trim() ||
                      "Home"})</button
                  >
                </form>
              {/if}
              {#if locatedStops.length > 0}
                <form
                  method="POST"
                  action="?/set_anchor"
                  use:enhance={anchorEnhance}
                >
                  <input type="hidden" name="source" value="stop" />
                  <label
                    ><span>One of the stops</span>
                    <select name="stop_id">
                      {#each data.stops as s, i (s.id)}
                        {#if s.lat != null && s.lon != null}
                          <option value={s.id}
                            >{i + 1}. {s.custom_name ?? "Stop"}</option
                          >
                        {/if}
                      {/each}
                    </select>
                  </label>
                  <button type="submit" class="small">Use this stop</button>
                </form>
              {/if}
              <h3 class="sub2">Or search or tap the map</h3>
              {#if anchorOpen}
                <!-- Mounted only while open: a map in a closed <details>
                     renders blank. MapPicker has its own search form, so the
                     place form below is its sibling, not its parent. -->
                <MapPicker
                  bind:selected={anchorPicked}
                  initialLat={anchorSeed?.lat ?? null}
                  initialLng={anchorSeed?.lng ?? null}
                  initialLabel={anchorSeed?.label}
                />
                <form
                  method="POST"
                  action="?/set_anchor"
                  use:enhance={anchorEnhance}
                >
                  <input type="hidden" name="source" value="place" />
                  <input
                    type="hidden"
                    name="label"
                    value={anchorChoice?.label ?? ""}
                  />
                  <input type="hidden" name="lat" value={anchorChoice?.lat ?? ""} />
                  <input type="hidden" name="lon" value={anchorChoice?.lng ?? ""} />
                  <button type="submit" class="small" disabled={!anchorChoice}
                    >{anchorChoice
                      ? `Use ${anchorChoice.label}`
                      : "Search or tap the map first"}</button
                  >
                </form>
              {/if}
            </div>
          </details>
          {#if data.anchor}
            <form method="POST" action="?/clear_anchor" use:enhance>
              <button type="submit" class="small secondary-btn"
                >Remove start &amp; end</button
              >
            </form>
          {/if}
        </div>
      {/if}
    </div>
    {#if visitedError}<p class="err" role="alert">{visitedError}</p>{/if}
    {#each data.stops as s, i (s.id)}
      {@const visited = isVisited(s)}
      <div
        class="stop path-focus-target"
        class:visited
        id={`trip-stop-${s.id}`}
      >
        <div class="lead">
          <div class="ordnum">{i + 1}</div>
          <!-- A real form POST, so it works before hydration and without JS;
               role=checkbox gives it checkbox semantics for screen readers. -->
          <form
            method="POST"
            action="?/set_visited"
            use:enhance={checkOff(s.id)}
          >
            <input type="hidden" name="stop_id" value={s.id} />
            <input type="hidden" name="visited" value={String(!visited)} />
            <button
              type="submit"
              class="check"
              role="checkbox"
              aria-checked={visited}
              aria-label={`Visited: ${s.custom_name ?? "Stop"}`}
              title={visited ? "Visited — tap to uncheck" : "Check off as visited"}
              ><span class="box" aria-hidden="true">{visited ? "✓" : ""}</span
              ></button
            >
          </form>
        </div>
        <div class="grow">
          <div class="name">
            {#if s.hotspot_id}
              <!-- Name → internal hotspot page (Phase 1, td-32ca9b);
                   the external eBird link is shown only for cache-verified
                   hotspot membership. -->
              <a
                class="place-link"
                href={withReturnTo(`/hotspots/${s.hotspot_id}`, tripContextHref, undefined, data.trip.name)}
                onclick={adopt(s.custom_name ?? "Stop", `trip-stop-${s.id}`)}
                >{s.custom_name ?? "Stop"}</a
              >
              {#if s.isVerifiedHotspot}
                <a
                  class="hotspot-badge"
                  href={`https://ebird.org/hotspot/${s.hotspot_id}`}
                  target="_blank"
                  rel="noopener"
                  title="Verified eBird hotspot">eBird hotspot ↗</a
                >
              {:else}
                <span class="reported-status">Reported location</span>
              {/if}
            {:else}
              <span class="stop-title">{s.custom_name ?? "Stop"}</span>
            {/if}
            {#if visited}<Badge kind="seen" label="Visited" />{/if}
          </div>
          {#if s.hotspot_id && !s.isVerifiedHotspot}
            <div class="meta reported-status">
              Hotspot status unverified. Check access before visiting.
            </div>
          {/if}
          <div class="meta">
            {#if s.plannedCountContext}
              {formatPlannedCountSnapshot(
                s.plannedCountContext,
                formatDistance(s.plannedCountContext.radiusKm, distanceUnit),
              )}
              <span class="snapshot-note">Planning preview and current nearby counts use different coverage; they are not a trend.</span>
            {:else if s.target_count_at_save != null}
              {formatLegacyCountSnapshot(s.target_count_at_save)}
            {/if}
          </div>
          <div class="meta">
            {#if !data.hasApiKey}
              <span>Now nearby: unavailable — <a href="/settings">add eBird key</a> to load life-list needs.</span>
            {:else if data.needsUnavailableStopIds.includes(s.id)}
              Now nearby: unavailable
            {:else if data.needsCounts[String(s.id)] !== undefined}
              {@const stopNeeds = data.needsSpecies[String(s.id)] ?? []}
              Now nearby: {data.needsCounts[String(s.id)]} life-list needs · last
              14 days · within {formatDistance(16, distanceUnit)} of this stop
              {#if data.needsStale}<Badge kind="stale" label="cached" />{/if}
              {#if stopNeeds.length > 0}
                <!-- Tier-1 (td-97b22e): the need SET was always computed for
                     this count — the names are the point of the trip. -->
                <details class="stopneeds">
                  <summary
                    >Which {stopNeeds.length === 1 ? "one" : "ones"}?</summary
                  >
                  <span class="needlist">
                    {#each stopNeeds as sp, i (sp.code)}
                      <a
                        href={withReturnTo(`/species/${sp.code}?back=14`, tripContextHref, undefined, data.trip.name)}
                        onclick={adopt(sp.comName, `trip-stop-${s.id}`)}
                        >{sp.comName}</a
                      >{i < stopNeeds.length - 1 ? " · " : ""}
                    {/each}
                  </span>
                </details>
              {/if}
            {:else}
              Now nearby: unavailable
            {/if}
          </div>
          <MapLink
            lat={s.lat}
            lng={s.lon}
            name={s.custom_name ?? s.hotspot_id ?? "Stop"}
            googlePlaceId={s.google_place_id}
          />
          {#if s.lat != null && s.lon != null}
            <a class="stop-forecast" href={stopForecastHref(s)}
              >📅 Forecast for {MONTH_ABBR[tripMonth - 1]}</a
            >
          {/if}
          {#if data.tidesByStop[String(s.id)]}
            {@const t = data.tidesByStop[String(s.id)]}
            <div class="tideline">
              <span class="tidehead"
                >🌊 {t.mode === "day"
                  ? `Tides ${formatTideDate(t.date)}`
                  : "Tide"}
                {#if t.stale}<Badge kind="stale" label="cached" />{/if}</span
              >
              <span class="tidetimes">
                {#if t.mode === "next"}
                  {#if t.nextHigh}<span class="tideitem"
                      >{t.nextHigh.phrase}</span
                    >{/if}
                  {#if t.nextLow}<span class="tideitem">{t.nextLow.phrase}</span
                    >{/if}
                {:else}
                  {#each t.day as e, i (e.at + i)}
                    <span class="tideitem"
                      >{tideWord(e.type)}
                      {e.timeLabel}&nbsp;({formatFeet(e.feetMllw)})</span
                    >
                  {/each}
                {/if}
              </span>
              <span class="tidestation"
                >{t.station.name} · {formatDistance(
                  t.station.distanceKm,
                  distanceUnit,
                )} away</span
              >
            </div>
          {/if}
          {#if s.notes}<div class="stopnote">
              {normalizeTripStopNote(s.notes)}
            </div>{/if}
          {#if s.field_tip}
            <div class="aitip">
              💡 {s.field_tip}
              <span class="aiverify"
                >{fmtTipGeneratedAt(s.field_tip_generated_at)}</span
              >
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
                  >{s.notes ? normalizeTripStopNote(s.notes) : ""}</textarea
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
    {#if anyTides}
      <p class="wx-attr">
        Tide predictions from <a
          href={TIDE_ATTRIBUTION_URL}
          target="_blank"
          rel="noopener">NOAA CO-OPS</a
        >
        · heights relative to MLLW · predictions, not observations · not for navigation.
      </p>
    {/if}
  </section>

  {#if data.canEdit}
    <section class="card">
      <h2>Add a stop</h2>
      <p class="muted intro">
        Pick a suggested eBird hotspot, or search a place to add it directly.
      </p>
      {#if data.suggestionsError}<p class="err">{data.suggestionsError}</p>{/if}

      {#if data.suggestedHotspots.length > 0}
        <h3 class="sub2">
          Suggested hotspots near {data.suggestionCenter?.label ?? "this trip"}
        </h3>
        <p class="muted intro">
          Ranked by your needs reported in the last {data.suggestionBackDays}
          days within {formatDistance(data.suggestionDistKm, distanceUnit)}.
          {#if data.suggestionsStale}<Badge kind="stale" label="cached" />{/if}
        </p>
        {#each data.suggestedHotspots as h (h.locId)}
          <div class="result suggestion">
            <div class="grow">
              <div class="name">
                <a
                  class="place-link"
                  href={`https://ebird.org/hotspot/${h.locId}`}
                  target="_blank"
                  rel="noopener">{h.locName}</a
                >
                <a
                  class="hotspot-badge"
                  href={`https://ebird.org/hotspot/${h.locId}`}
                  target="_blank"
                  rel="noopener"
                  title="Verified eBird hotspot">eBird hotspot ↗</a
                >
              </div>
              <div class="meta">{suggestedSpeciesList(h)}</div>
              <MapLink
                lat={h.lat}
                lng={h.lng}
                name={h.locName}
                googlePlaceId={h.googlePlaceId}
              />
            </div>
            <div class="suggestion-right">
              <div class="count">
                {h.needCount}
                <span>{h.needCount === 1 ? "need" : "needs"}</span>
              </div>
              <div class="when">
                {#if h.distanceKm != null}{formatDistance(
                    h.distanceKm,
                    distanceUnit,
                  )} ·
                {/if}{h.lastObsDt.slice(0, 10)}
              </div>
              <form method="POST" action="?/add_hotspot" use:enhance>
                <input type="hidden" name="loc_id" value={h.locId ?? ""} />
                <input type="hidden" name="name" value={h.locName} />
                <input type="hidden" name="lat" value={h.lat} />
                <input type="hidden" name="lon" value={h.lng} />
                <input
                  type="hidden"
                  name="google_place_id"
                  value={h.googlePlaceId ?? ""}
                />
                <input type="hidden" name="notes" value={suggestedNote(h)} />
                <button type="submit" class="small primary">+ Add</button>
              </form>
            </div>
          </div>
        {/each}
      {/if}

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

<!-- Share modal (trips-app pattern): unlike the confirm modals this one
     closes on backdrop tap — the ticket is precisely that iOS users had no
     way out, and Escape does not exist on a phone. -->
{#if shareModal}
  <div
    class="modal-overlay"
    role="presentation"
    onclick={(e) => {
      if (e.target === e.currentTarget) closeShareModal();
    }}
  >
    <div
      class="modal share-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="share-title"
      tabindex="-1"
      onkeydown={trapShareFocus}
    >
      <h3 id="share-title">{shareModal.title}</h3>
      <textarea class="share-text-body" readonly value={shareModal.text}></textarea>
      {#if shareSheetError}
        <p class="err" role="alert">{shareSheetError}</p>
      {/if}
      <div class="actions">
        {#if !shareModal.error && canShareText()}
          <button class="btn" onclick={runShareSheet}>Share…</button>
        {/if}
        {#if !shareModal.error}
          <button class="btn" onclick={copyShareText}
            >{shareCopied ? "Copied ✓" : "Copy"}</button
          >
        {/if}
        <button class="btn" bind:this={shareCloseBtn} onclick={closeShareModal}
          >Close</button
        >
      </div>
    </div>
  </div>
{/if}

<svelte:window
  onkeydown={(e) => {
    if (e.key === "Escape" && shareModal) closeShareModal();
  }}
/>

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
    color: var(--on-accent);
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
  /* Tide line (td-6a3d2e) — same tokens as the species-page tide chip
     (var(--info-bg) bg / #163e5e text = 9.16:1, AAA). Do NOT use .muted here:
     var(--muted) on var(--info-bg) is not guaranteed to hit 7:1. */
  .tideline {
    margin-top: 6px;
    padding: 8px 10px;
    background: var(--info-bg);
    border-left: 3px solid var(--info-text);
    border-radius: 6px;
    font-size: 0.85rem;
    color: var(--info-text);
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .tidehead {
    font-weight: 700;
  }
  .tidetimes {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 12px;
  }
  .tidestation {
    font-size: 0.76rem;
  }
  .card h2 {
    font-size: 1.05rem;
    margin-bottom: 10px;
  }
  .stops-head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0 12px;
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
    color: var(--on-accent);
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
  .lead {
    flex: 0 0 48px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
  }
  .ordnum {
    flex: 0 0 28px;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    background: var(--accent);
    color: var(--on-accent);
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 700;
    font-size: 0.85rem;
  }
  /* Start & end point (td-0f3c63). */
  .anchor {
    padding: 4px 0 10px;
  }
  .anchor-row {
    display: flex;
    gap: 12px;
    align-items: flex-start;
  }
  .anchor-dot {
    flex: 0 0 28px;
    width: 28px;
    height: 28px;
    margin: 0 10px;
    border-radius: 50%;
    background: #4a2c82;
    color: #fff;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 700;
    font-size: 0.85rem;
  }
  .anchor-tag {
    background: var(--accent-soft);
    color: var(--accent);
    border-radius: 6px;
    font-size: 0.72rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    padding: 2px 8px;
  }
  .anchor-controls {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 4px 16px;
    margin-top: 4px;
  }
  .anchor-edit {
    flex: 1 1 100%;
    /* A flex item defaults to min-width: auto, which let the map picker's
       search row push the panel past a 320px screen. */
    min-width: 0;
  }
  .anchor-edit summary {
    cursor: pointer;
    color: var(--link);
    font-size: 0.85rem;
    font-weight: 600;
    min-height: 48px;
    display: flex;
    align-items: center;
  }
  .anchor-choices {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 4px 0 8px;
  }
  .anchor-choices button {
    max-width: 100%;
    white-space: normal;
  }
  /* button.small allows 40px; these new controls keep the 48px tap target. */
  .anchor-controls button.small {
    min-height: 48px;
  }
  .anchor-choices select {
    font-size: 16px;
    min-height: 48px;
    max-width: 100%;
  }
  .secondary-btn {
    background: var(--card);
    color: var(--accent);
  }

  /* Check-off (td-40a1b5): a 48px target around a 28px box. */
  button.check {
    width: 48px;
    min-height: 48px;
    padding: 0;
    background: transparent;
    border: none;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
  }
  .check .box {
    width: 28px;
    height: 28px;
    border: 2px solid var(--accent);
    border-radius: 6px;
    background: var(--card);
    color: var(--on-accent);
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 800;
    font-size: 1.05rem;
    line-height: 1;
  }
  .check[aria-checked="true"] .box {
    background: var(--accent);
  }
  .check:hover .box {
    box-shadow: 0 0 0 3px var(--accent-soft);
  }
  .visited .name .place-link,
  .visited .name .stop-title {
    color: var(--muted);
    text-decoration-line: line-through;
  }
  .visited .name .place-link {
    text-decoration-line: underline line-through;
  }
  .visit-count {
    white-space: nowrap;
    margin-left: 8px;
    font-size: 0.85rem;
    font-weight: 600;
    color: var(--muted);
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
    background: var(--info-bg);
    border: 1px solid var(--info-border);
    border-radius: 999px;
    color: var(--info-text);
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
  .stop-forecast {
    display: inline-flex;
    align-items: center;
    min-height: 48px;
    font-size: 0.85rem;
    margin-top: 4px;
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
    border-color: var(--danger-border);
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
  .suggestion {
    align-items: flex-start;
  }
  .suggestion-right {
    text-align: right;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 4px;
  }
  .count {
    color: var(--accent);
    font-weight: 700;
    white-space: nowrap;
  }
  .count span {
    font-size: 0.78rem;
    font-weight: 600;
  }
  .when {
    color: var(--muted);
    font-size: 0.78rem;
    white-space: nowrap;
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
    border: 1px solid var(--danger-border);
    color: var(--danger);
  }
  .danger-btn:hover {
    background: var(--danger-soft);
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
    color: var(--on-danger);
  }
  .share-modal {
    max-width: 560px;
  }
  .share-text-body {
    width: 100%;
    height: 40vh;
    min-height: 160px;
    font-size: 16px; /* prevents iOS zoom-on-focus */
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 10px;
    background: var(--bg);
    color: var(--text);
    resize: none;
    margin-bottom: 12px;
  }
  .sharecard {
    padding: 12px 16px;
  }
  .sharebar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }
  .share-actions {
    display: flex;
    gap: 8px;
  }

  @media (min-width: 640px) {
    .page {
      padding: 24px;
    }
    h1 {
      font-size: 1.6rem;
    }
  }
  @media (max-width: 639px) {
    .result.suggestion {
      flex-direction: column;
    }
    .suggestion-right {
      align-items: flex-start;
      text-align: left;
      width: 100%;
    }
  }
  .stopneeds {
    display: inline-block;
  }
  .stopneeds summary {
    display: inline-flex;
    align-items: center;
    min-height: 48px;
    cursor: pointer;
    color: var(--accent);
    font-weight: 600;
    font-size: 0.85rem;
  }
  .needlist a {
    color: var(--accent);
    font-weight: 600;
    text-decoration: none;
    display: inline-flex;
    align-items: center;
    min-height: 48px;
  }
</style>
