<script lang="ts">
  import { enhance } from "$app/forms";
  import { browser } from "$app/environment";
  import { goto, invalidateAll, replaceState } from "$app/navigation";
  import { onMount, tick } from "svelte";
  import { page } from "$app/state";
  import PathNavigation from "$components/PathNavigation.svelte";
  import { navigationAction } from "$lib/navigation-context.svelte";
  import { withReturnTo } from "$lib/navigation-context";
  import {
    groupCountriesByGeographicArea,
    type GeographicAreaGroup,
  } from "$lib/geographic-areas";
  import { mapsPlaceUrl } from "$lib/geo";
  import { jobsPoll } from "$lib/job-poll.svelte";
  import { jobPresentationText } from "$lib/job-presentation";
  import { fmtNextScan } from "$lib/next-scan";
  import ForecastTabs from "$lib/components/ForecastTabs.svelte";
  import ProgressBar from "$components/ProgressBar.svelte";
  import Skeleton from "$components/Skeleton.svelte";
  import type { ActionData, PageData } from "./$types";
  import MapPicker, { type PickedLocation } from "$components/MapPicker.svelte";
  import { GUIDE_RADIUS_MAX, GUIDE_RADIUS_MIN } from "$lib/guide-location";
  import {
    HUB_DISCOVERY_PARAMS,
    HUB_FIND_MIN,
    HUB_RESULTS_ID,
    HUB_SELECTION_PARAMS,
    clearHubDiscovery,
    hubFailedId,
    hubHotspotPath,
    hubHref,
    hubNodeId,
    hubSelectHref,
    normalizeHubFind,
    withHubMap,
    withHubPage,
    withHubTyped,
  } from "$lib/hub-discovery";
  import type { HubDiscovery, HubResult, HubSummaryArea } from "$server/hub-discovery";

  let { data, form }: { data: PageData; form: ActionData } = $props();

  // Country picker (td-f1d6da): switching countries reloads the loader with
  // the new ?country= so the region select + stored-data labels update —
  // no client-side eBird calls, no new endpoint.
  const selectedCountryName = $derived(
    data.countries.find((c) => c.code === data.selectedCountry)?.name ??
      data.selectedCountry,
  );
  // The loader removes fully-loaded countries and sorts the remainder
  // alphabetically. The current selection survives the text filter so the
  // select never renders blank while the user searches.
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
  const filteredCountries = $derived(data.countries.filter(countryMatches));
  function onCountryChange(e: Event & { currentTarget: HTMLSelectElement }) {
    // Keep every unrelated parameter (discovery included); a new country makes
    // any preselected region or opened section stale.
    const next = new URLSearchParams(page.url.searchParams);
    next.set("country", e.currentTarget.value);
    for (const name of ["region", "show"]) next.delete(name);
    void goto(`?${next}`, { keepFocus: true, noScroll: true });
  }
  // Nothing left to offer: every subnational1 region is loaded, and so is the
  // countrywide export where one is offered (never for US).
  const nothingLeftToLoad = $derived(
    data.states.length === 0 &&
      (data.selectedCountry === "US" || data.wholeCountryLoaded),
  );
  type LoadedCountrySection = PageData["countrySections"][number];
  type LoadedArea = GeographicAreaGroup<LoadedCountrySection>;

  // Normalize the old US-special response shape into the same country shape
  // used everywhere else. US states now live below United States instead of
  // consuming 50+ top-level rows; the server shape stays backward-compatible.
  const loadedCountries = $derived.by((): LoadedCountrySection[] => {
    const usStates = data.stateGroups.filter((g) => g.level === "subnational1");
    const usCountry = data.stateGroups.find((g) => g.level === "country");
    const sections = [...data.countrySections];
    if (usStates.length > 0 || usCountry) {
      sections.push({
        countryCode: "US",
        countryName: "United States",
        countrywide: usCountry?.state ?? null,
        countryHotspots: [],
        groups: usStates,
        hotspotCount:
          (usCountry?.hotspotCount ?? 0) +
          usStates.reduce((sum, state) => sum + state.hotspotCount, 0),
        regionTotal: null,
        regionsLoaded: usStates.filter((state) => state.state).length,
        regionRemaining: null,
      });
    }
    return sections;
  });
  const geographicAreas = $derived(
    groupCountriesByGeographicArea(loadedCountries),
  );
  const totalCountryCount = $derived(loadedCountries.length);

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
    if (s.countryCode === "US") {
      parts.push(`${s.groups.length} state${s.groups.length === 1 ? "" : "s"}`);
      parts.push(`${s.hotspotCount} hotspot${s.hotspotCount === 1 ? "" : "s"}`);
      return parts.join(" · ");
    }
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
  function areaStatusText(area: LoadedArea): string {
    const regionCount = area.countries.reduce(
      (sum, country) => sum + country.groups.length,
      0,
    );
    const hotspotCount = area.countries.reduce(
      (sum, country) => sum + country.hotspotCount,
      0,
    );
    return [
      `${area.countries.length} countr${area.countries.length === 1 ? "y" : "ies"}`,
      `${regionCount} region${regionCount === 1 ? "" : "s"}`,
      `${hotspotCount} hotspot${hotspotCount === 1 ? "" : "s"}`,
    ].join(" · ");
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

  // Geographic areas are independently remembered and lazily render their
  // country summaries only while open. This keeps the all-world page light
  // on phones after every country has data.
  const OPEN_AREAS_KEY = "forecast-data-open-areas";
  let openAreas = $state<string[]>([]);
  $effect(() => {
    if (!browser) return;
    try {
      const value = JSON.parse(localStorage.getItem(OPEN_AREAS_KEY) ?? "[]");
      openAreas = Array.isArray(value)
        ? value.filter((item) => typeof item === "string")
        : [];
    } catch {
      openAreas = [];
    }
  });
  // A discovery selection can ask for a chain of disclosures (area → country →
  // region) to be open. The server renders that chain, so it works without
  // JavaScript; a person can still close any of it (tracked in `dismissed`).
  const focusAreas = $derived(new Set(data.focus?.kind === "area" ? [data.focus.area] : []));
  const focusStates = $derived(new Set(data.focus?.kind === "area" ? data.focus.states : []));
  let dismissed = $state<string[]>([]);
  function noteToggle(id: string, open: boolean, focused: Set<string>) {
    if (open) dismissed = dismissed.filter((x) => x !== id);
    else if (focused.has(id) && !dismissed.includes(id)) dismissed = [...dismissed, id];
  }
  const areaOpen = (id: string) =>
    openAreas.includes(id) || (focusAreas.has(id) && !dismissed.includes(id));
  const stateOpen = (code: string) =>
    openStates.includes(code) || (focusStates.has(code) && !dismissed.includes(code));

  function toggleArea(id: string, open: boolean) {
    noteToggle(id, open, focusAreas);
    const next = openAreas.filter((areaId) => areaId !== id);
    if (open) next.push(id);
    openAreas = next;
    if (browser) {
      try {
        localStorage.setItem(OPEN_AREAS_KEY, JSON.stringify(next));
      } catch {
        // private mode
      }
    }
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
    // The toggle event a landing's own server-opened chain fires on hydration is
    // not a person's action, so it never fetches counts; closing then reopening is.
    const landingOpen = open && focusStates.has(code) && !dismissed.includes(code);
    noteToggle(code, open, focusStates);
    const next = openStates.filter((c) => c !== code);
    if (open) next.push(code);
    openStates = next;
    if (open) {
      if (!landingOpen) void loadHotspotCounts(code);
      // Detail is fetched on expand, not shipped with the page (td-3bf3a2).
      const g =
        data.stateGroups.find((x) => x.stateCode === code) ??
        data.countrySections.flatMap((x) => x.groups).find((x) => x.stateCode === code);
      const sec = data.countrySections.find((x) => x.countryCode === code);
      if (g) void loadGroupDetail(g.stateCode, g.stateName);
      else if (sec) void loadGroupDetail(sec.countryCode, sec.countryName);
    }
    if (browser) {
      try {
        localStorage.setItem(OPEN_KEY, JSON.stringify(next));
      } catch {
        // private mode
      }
    }
  }

  // Group detail (county blocks + their hotspots) is fetched when a group is
  // opened, not shipped with the page (td-3bf3a2). Same shape the loader used
  // to embed; same lazy discipline as the hotspot tallies just below.
  type GroupDetail = {
    countyBlocks: PageData["stateGroups"][number]["countyBlocks"];
    stateHotspots: PageData["stateGroups"][number]["stateHotspots"];
  };
  let groupDetail = $state<Record<string, GroupDetail>>({});
  const detailFetched = new Set<string>();
  async function loadGroupDetail(code: string, name: string) {
    if (!browser || detailFetched.has(code) || data.focusDetail[code]) return;
    detailFetched.add(code);
    try {
      const res = await fetch(
        `/api/region-detail?region=${encodeURIComponent(code)}&name=${encodeURIComponent(name)}`,
      );
      if (!res.ok) {
        detailFetched.delete(code); // transient — allow a retry on reopen
        return;
      }
      groupDetail = { ...groupDetail, [code]: (await res.json()) as GroupDetail };
    } catch {
      detailFetched.delete(code);
    }
  }
  /** Blocks for a group once fetched; empty until then. */
  function detailOf(code: string): GroupDetail {
    return (
      groupDetail[code] ??
      data.focusDetail[code] ?? { countyBlocks: [], stateHotspots: [] }
    );
  }
  const hasDetail = (code: string) => !!(groupDetail[code] ?? data.focusDetail[code]);

  // Hotspot tallies per county ("229 of 312 loaded · 83 to load"), fetched
  // only for groups you actually open — one cached eBird request per region
  // covers all of its counties, but 20 groups shouldn't fan out on page load.
  type HotspotCounts = { total: number; loaded: number; pending: number };
  let hotspotCounts = $state<Record<string, HotspotCounts>>({});
  const countsFetched = new Set<string>();
  // These tallies come from eBird hotspot lists. A discovery or selection view
  // never triggers them on its own: only after the person interacts (a plain
  // variable, so engaging does not re-run the effect that restores open groups).
  let engaged = false;
  onMount(() => {
    const mark = () => {
      engaged = true;
    };
    window.addEventListener("pointerdown", mark, { capture: true, passive: true });
    window.addEventListener("keydown", mark, { capture: true, passive: true });
    return () => {
      window.removeEventListener("pointerdown", mark, { capture: true });
      window.removeEventListener("keydown", mark, { capture: true });
    };
  });
  async function loadHotspotCounts(regionCode: string) {
    if (!browser || countsFetched.has(regionCode)) return;
    if (data.offlineView && !engaged) return;
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
  // Groups restored open from localStorage need their counts too, except on a
  // local-only discovery/selection view, where nothing is fetched automatically.
  $effect(() => {
    for (const code of openStates) {
      if (!data.offlineView) void loadHotspotCounts(code);
      const g =
        data.stateGroups.find((x) => x.stateCode === code) ??
        data.countrySections.flatMap((x) => x.groups).find((x) => x.stateCode === code);
      if (g) void loadGroupDetail(g.stateCode, g.stateName);
      const sec = data.countrySections.find((x) => x.countryCode === code);
      if (sec) void loadGroupDetail(sec.countryCode, sec.countryName);
    }
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

  // ---- Discovery (Phase 8B): find a country, region, county or hotspot by
  // typing or by a map point + explicit radius. The server renders the result
  // (native GET form, no JavaScript needed); this only adds debounced live
  // results from the same service through /api/hub-search.
  const NAV_KEYS = ["returnTo", "returnLabel", "navNode", "navParent", "navAccount"];
  /** The current URL's parameters without navigation bookkeeping. */
  function baseParams(): URLSearchParams {
    const next = new URLSearchParams(page.url.searchParams);
    for (const name of NAV_KEYS) next.delete(name);
    return next;
  }
  // Unrelated parameters ride along on the native forms; discovery and stale
  // selection state do not.
  const preservedParams = $derived(
    [...page.url.searchParams].filter(
      ([name]) =>
        !HUB_DISCOVERY_PARAMS.includes(name) &&
        !(HUB_SELECTION_PARAMS as readonly string[]).includes(name) &&
        !NAV_KEYS.includes(name),
    ),
  );

  let typedText = $state<string | null>(null);
  const findValue = $derived(
    typedText ??
      (data.discovery?.mode === "typed" ? (data.discovery.submitted ?? data.discovery.find ?? "") : ""),
  );
  // Live results replace the server-rendered ones until the next navigation;
  // `discovery: null` means the search was cleared.
  let live = $state<{ discovery: HubDiscovery | null } | null>(null);
  const shown = $derived<HubDiscovery | null>(live ? live.discovery : data.discovery);
  $effect(() => {
    void data.discovery;
    typedText = null;
    live = null;
  });

  let findSeq = 0;
  let findTimer: ReturnType<typeof setTimeout> | undefined;
  function onFindInput(e: Event & { currentTarget: HTMLInputElement }) {
    typedText = e.currentTarget.value;
    const text = normalizeHubFind(typedText);
    const params = withHubTyped(baseParams(), text);
    clearTimeout(findTimer);
    findTimer = setTimeout(async () => {
      const seq = ++findSeq;
      if (!text) {
        live = { discovery: null };
        replaceState(hubHref(params, ""), {});
        return;
      }
      try {
        const res = await fetch(`/api/hub-search?${params}`);
        // Out-of-order guard: only the newest query may paint. A failure keeps
        // the last answer; the Search button always works.
        if (seq !== findSeq || !res.ok) return;
        const body = (await res.json()) as { discovery: HubDiscovery | null };
        live = { discovery: body.discovery };
        replaceState(hubHref(params), {});
      } catch {
        /* the native form remains authoritative */
      }
    }, 250);
  }

  // The named immediate return path: the exact canonical query of what is on
  // screen (mode, page, unrelated parameters) with the fragment of the very row
  // that was chosen, so coming back lands on and focuses that row.
  function selectHref(target: HubResult["target"], rowId: string): string | null {
    const returnHref = hubHref(baseParams(), rowId);
    if (target.kind === "hotspot")
      return withReturnTo(hubHotspotPath(target.id), returnHref, undefined, "Hotspots & data");
    // Only the account owner can act on the Load workflow this would preselect.
    if (target.kind === "load" && data.isViewer) return null;
    const destination = hubSelectHref(baseParams(), target);
    return destination ? withReturnTo(destination, returnHref, undefined, "Hotspots & data") : null;
  }
  const resultRowId = (id: string) => `forecast-data-search-${encodeURIComponent(id)}`;
  const areaRowId = (area: HubSummaryArea) => `forecast-data-area-${area.type}-${encodeURIComponent(area.code)}`;

  // Arriving on a row's fragment (a return path) focuses that row.
  $effect(() => {
    void shown;
    if (!browser) return;
    let id = "";
    try {
      id = decodeURIComponent(page.url.hash.slice(1));
    } catch {
      return;
    }
    if (!id.startsWith("forecast-data-search-") && !id.startsWith("forecast-data-area-")) return;
    void tick().then(() => {
      const el = document.getElementById(id);
      if (el instanceof HTMLElement) el.focus({ preventScroll: true });
    });
  });
  function pageHref(n: number): string {
    return hubHref(withHubPage(baseParams(), shown?.mode === "map" ? "map" : "typed", n));
  }
  const clearDiscoveryHref = $derived(hubHref(clearHubDiscovery(baseParams()), "discovery"));
  // The ordinary inventory view: no discovery or selection state.
  const fullViewHref = $derived.by(() => {
    const next = clearHubDiscovery(baseParams());
    for (const name of HUB_SELECTION_PARAMS) next.delete(name);
    return hubHref(next, "");
  });

  const TYPE_LABEL: Record<HubResult["type"], string> = {
    country: "country",
    region: "first-level region",
    county: "county or equivalent",
    hotspot: "verified eBird hotspot",
    reported: "reported location — hotspot status unverified",
  };
  function stateText(r: HubResult): string {
    const span = r.row ? `${r.row.beginYear}–${r.row.endYear} · ${r.row.nSpecies.toLocaleString()} species` : "";
    switch (r.loadState) {
      case "current":
        return `loaded, current · ${span}`;
      case "outdated":
        return `loaded, outdated · ${span}`;
      case "failed":
        return `last load failed${r.error ? ` — ${r.error}` : ""}`;
      case "unverified":
        return `not verified as a hotspot${r.error ? ` · last load failed — ${r.error}` : ""}`;
      default:
        return r.loadedBeneath > 0
          ? `not loaded as a whole · ${r.loadedBeneath.toLocaleString()} loaded ${r.loadedBeneath === 1 ? "area or hotspot" : "areas and hotspots"} inside`
          : "available, not loaded";
    }
  }
  const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
  function countsText(d: HubDiscovery): string {
    const parts = [
      d.counts.country ? plural(d.counts.country, "country", "countries") : "",
      d.counts.region ? plural(d.counts.region, "first-level region", "first-level regions") : "",
      d.counts.county ? plural(d.counts.county, "loaded county or equivalent", "loaded counties or equivalents") : "",
      d.counts.hotspot ? plural(d.counts.hotspot, "verified hotspot", "verified hotspots") : "",
      d.counts.reported ? plural(d.counts.reported, "reported location, hotspot status unverified", "reported locations, hotspot status unverified") : "",
    ].filter(Boolean);
    return parts.join(" · ");
  }

  // Map + radius chooser. Creating a marker needs JavaScript, so the control
  // appears once the page has hydrated; <noscript> explains it. The radius is
  // explicit and never defaulted, saved or taken from the map view.
  const chooserId = "hub-map-chooser";
  let jsReady = $state(false);
  onMount(() => {
    jsReady = true;
  });
  let mapOpen = $state(false);
  let picked = $state<PickedLocation | null>(null);
  let radiusText = $state("");
  let applyError = $state("");
  let chooseButton = $state<HTMLButtonElement | undefined>();
  let chooserHeading = $state<HTMLHeadingElement | undefined>();
  const radiusValid = $derived(
    /^\d+$/.test(radiusText.trim()) &&
      Number(radiusText) >= GUIDE_RADIUS_MIN &&
      Number(radiusText) <= GUIDE_RADIUS_MAX,
  );
  const canApply = $derived(picked !== null && radiusValid);
  async function openChooser() {
    picked = null;
    applyError = "";
    radiusText = shown?.map ? String(shown.map.dist) : "";
    mapOpen = true;
    await tick();
    chooserHeading?.focus({ preventScroll: true });
    chooserHeading?.scrollIntoView({ block: "start" });
  }
  async function cancelChooser() {
    mapOpen = false;
    picked = null;
    radiusText = "";
    applyError = "";
    await tick();
    chooseButton?.focus();
  }
  function applyChooser() {
    if (!picked || !radiusValid) return;
    const built = withHubMap(baseParams(), {
      place: picked.label,
      lat: picked.lat,
      lng: picked.lng,
      dist: Number(radiusText),
    });
    if (!built.ok) {
      applyError = built.message;
      return;
    }
    mapOpen = false;
    picked = null;
    radiusText = "";
    applyError = "";
    void goto(hubHref(built.params));
  }

  // Land on the section a selection asked for (its disclosures are already
  // rendered open by the server) or on the preselected Load form.
  $effect(() => {
    const f = data.focus;
    const target =
      f?.kind === "area"
        ? f.targetId
        : f?.kind === "failed"
          ? hubFailedId(f.code)
          : data.preselectRegion
            ? "region-select"
            : null;
    if (!browser || !target) return;
    void tick().then(() => {
      const el = document.getElementById(target);
      if (!el) return;
      el.scrollIntoView({ block: "start" });
      el.focus({ preventScroll: true });
    });
  });

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
  const pausedJobs = $derived(
    jobsPoll.active.filter((j) => j.presentation?.state === "paused"),
  );
  const scheduledJobs = $derived(
    jobsPoll.active.filter((j) => ["scheduled", "retry-scheduled", "waiting"].includes(j.presentation?.state ?? "")),
  );
  const recurringJobTypes = new Set(["scan_enrichment", "scan_need_alerts", "enrich_families"]);
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
        if (jobsPoll.active.some((j) => j.id === id && j.presentation?.state === "running")) {
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
        {@const failed = job.progress.unitsFailed ?? 0}
        <span class="hsprogress">
          {jobPresentationText(job.presentation, job.progress)}
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
          id={`forecast-data-hotspot-${encodeURIComponent(r.locCode)}`}
          class="hublink path-focus-target"
          href={withReturnTo(hubHotspotPath(r.locCode),page.url.pathname + page.url.search + page.url.hash,undefined,'Hotspots & data')}
          onclick={navigationAction(data.accountId,{label:r.locName,originId:`forecast-data-hotspot-${encodeURIComponent(r.locCode)}`})}
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
    open={stateOpen(g.stateCode)}
    ontoggle={(e) => toggleState(g.stateCode, e.currentTarget.open)}
  >
    <summary id={hubNodeId(g.stateCode)} class="hub-target">
      <strong>{g.stateName}</strong>
      <span class="groupmeta">{groupStatusText(g)} · {@render speciesTotal("regions", g.stateCode)}</span>
    </summary>
    <!-- Lazy body (Gaylon 2026-08-31): a <details> keeps its contents in the
         DOM even when closed, so all 3,459 loaded county rows used to render
         and hydrate on every visit — blocking input on the country search for
         ~10 s on a phone. Render a group's table only while it is open, the
         same treatment the hotspot rows inside it already get. -->
    {#if stateOpen(g.stateCode)}
      {@const detail = detailOf(g.stateCode)}
      {#if !hasDetail(g.stateCode)}
        <Skeleton minHeight="120px" label="Loading {g.stateName}…" />
      {/if}
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
      {#if detail.countyBlocks.length > 0}
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
              {#each detail.countyBlocks as b (b.countyCode)}
                {@const open = openCounties.includes(b.countyCode)}
                <tr>
                  <td id={hubNodeId(b.countyCode)} class="hub-target" tabindex="-1">
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
      {#if detail.stateHotspots.length > 0}
        {#if g.countyTotal !== null && g.countyTotal > 0}
          <p class="notice">
            These hotspots are recorded under {g.stateName}, without a more
            specific {g.countryCode === "US" ? "county" : "subdivision"} assignment.
          </p>
        {/if}
        {@render dataTable("Hotspot", detail.stateHotspots)}
      {/if}
    {/if}
  </details>
{/snippet}

{#snippet countrySection(s: PageData["countrySections"][number])}
  <!-- One country node inside a geographic area. US uses this same shape now,
       with states as its nested groups and no countrywide export. -->
  <details
    class="stategroup countrygroup"
    open={stateOpen(s.countryCode)}
    ontoggle={(e) => toggleState(s.countryCode, e.currentTarget.open)}
  >
    <summary id={hubNodeId(s.countryCode)} class="hub-target">
      <strong>{s.countryName}</strong>
      <span class="groupmeta">{sectionStatusText(s)} · {@render speciesTotal("regions", s.countryCode)}</span>
    </summary>
    <!-- Same lazy body as the state groups above: a closed <details> still
         hydrates everything inside it. -->
    {#if stateOpen(s.countryCode)}
      {@const cdetail = detailOf(s.countryCode)}
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
      {#if cdetail.stateHotspots.length > 0}
        {#if s.regionTotal !== null && s.regionTotal > 0}
          <p class="notice">
            These hotspots are recorded under {s.countryName}, without a more
            specific region assignment.
          </p>
        {/if}
        {@render dataTable("Hotspot", cdetail.stateHotspots)}
      {/if}
      {#each s.groups as g (g.stateCode)}
        {@render regionGroup(g, true)}
      {/each}
    {/if}
  </details>
{/snippet}

{#snippet areaLink(area: HubSummaryArea)}
  {@const href = selectHref(area.target, areaRowId(area))}
  <li>
    {#if href}
      <a
        id={areaRowId(area)}
        class="hublink path-focus-target"
        {href}
        onclick={navigationAction(data.accountId, { label: area.name, originId: areaRowId(area) })}
        ><strong>{area.name}</strong></a
      >
    {:else}
      <strong>{area.name}</strong>
    {/if}
    <span class="hitmeta"
      >{area.type === "county" ? "loaded county or equivalent" : area.type === "region" ? "first-level region" : "country"}
      · {plural(area.hotspots, "nearby verified hotspot", "nearby verified hotspots")}</span
    >
  </li>
{/snippet}

{#snippet speciesTotal(kind: "areas" | "regions" | "world", code: string)}
  <span class="species-total">
    {#await data.speciesCounts}
      Counting species…
    {:then result}
      {@const count = result.ok ? (kind === "world" ? result.data.world : result.data[kind][code]) : undefined}
      {#if count !== undefined}
        {count.toLocaleString()} species
      {:else}
        Species counts unavailable
      {/if}
    {:catch}
      Species counts unavailable
    {/await}
  </span>
{/snippet}

{#snippet geographicArea(area: LoadedArea)}
  <details
    class="area-group"
    open={areaOpen(area.id)}
    ontoggle={(e) => toggleArea(area.id, e.currentTarget.open)}
  >
    <summary>
      <strong>{area.name}</strong>
      <span class="groupmeta">{areaStatusText(area)} · {@render speciesTotal("areas", area.id)}</span>
    </summary>
    <!-- Do not even render the country summaries while this area is closed.
         Country and region bodies have the same lazy boundary one level down. -->
    {#if areaOpen(area.id)}
      <div class="area-countries">
        {#each area.countries as country (country.countryCode)}
          {@render countrySection(country)}
        {/each}
      </div>
    {/if}
  </details>
{/snippet}

<svelte:head>
  <title>Hotspots &amp; data · Birds</title>
</svelte:head>

<div class="page">
  <PathNavigation
    accountId={data.accountId}
    label="Hotspots & data"
    href={page.url.pathname + page.url.search + page.url.hash}
    fallbackHref={data.returnLink.href !== "/" ? data.returnLink.href : "/forecast"}
    fallbackLabel={data.returnLink.href !== "/" ? data.returnLink.label : "Forecast"}
    hasExplicitSource={data.returnLink.href !== "/"}
    hideWhenNoPath={data.returnLink.href === "/"}
  />
  <h1>Hotspots &amp; data</h1>
  <ForecastTabs mode="data" />
  <p class="intro">
    Every hotspot, county, and region this app has loaded — how current the
    data is, what's running, and what failed. Data refreshes matter only once
    a year, when a new complete year of checklists becomes available.
  </p>

  <section class="card hub-target" id="discovery" aria-labelledby="discovery-title">
    <h2 id="discovery-title">Find a country, region, county or hotspot</h2>
    <form method="GET" action={`${page.url.pathname}#${HUB_RESULTS_ID}`} class="findform" role="search">
      {#each preservedParams as [pname, pvalue], i (`keep-${i}-${pname}-${pvalue}`)}
        <input type="hidden" name={pname} value={pvalue} />
      {/each}
      <div class="find-entry">
        <input
          class="hubsearch"
          type="search"
          name="find"
          value={findValue}
          oninput={onFindInput}
          maxlength="100"
          autocomplete="off"
          placeholder="A country, region, county or hotspot name or code"
          aria-label="Find a country, region, county or hotspot"
        />
        <button type="submit" class="find-submit">Search</button>
      </div>
    </form>
    <p class="notice">
      Searches reference countries and first-level regions, loaded counties or
      equivalents, verified eBird hotspots, and failed loads. Searching and
      selecting a result never loads bird data.
    </p>

    <div class="map-chooser">
      <p id="hub-map-label" class="map-label">Or choose a point on the map</p>
      <noscript>
        <p class="notice">
          Typed search above works without JavaScript. Choosing or moving a map
          point needs JavaScript; a shared map link still shows its results.
        </p>
      </noscript>
      {#if jsReady}
        <button
          type="button"
          class="secondary"
          bind:this={chooseButton}
          hidden={mapOpen}
          aria-expanded={mapOpen}
          aria-controls={chooserId}
          onclick={openChooser}>Choose on map</button
        >
      {/if}
      {#if mapOpen}
        <div id={chooserId} class="chooser" role="group" aria-labelledby="hub-map-heading">
          <h3 bind:this={chooserHeading} id="hub-map-heading" tabindex="-1">Choose a map point and radius</h3>
          <p class="muted2">
            Search for a place or tap the map, then enter a radius. Results are
            verified eBird hotspots with recorded coordinates inside the circle;
            the part of the map you can see is never a boundary, and a place
            you pick is only a point.
          </p>
          <MapPicker bind:selected={picked} initialLat={shown?.map?.lat ?? null} initialLng={shown?.map?.lng ?? null} initialLabel={shown?.map?.place} />
          <p class="picked">{picked ? `Chosen point: ${picked.label}` : "No point chosen yet."}</p>
          <div class="radius-field">
            <label for="hub-radius">Radius in miles ({GUIDE_RADIUS_MIN}–{GUIDE_RADIUS_MAX})</label>
            <input id="hub-radius" type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="off" bind:value={radiusText} aria-describedby="hub-apply-help" aria-invalid={radiusText.trim() !== "" && !radiusValid} />
          </div>
          <p id="hub-apply-help" class="muted2">{canApply ? "Ready to apply." : `Choose a point on the map and enter a whole number of miles from ${GUIDE_RADIUS_MIN} to ${GUIDE_RADIUS_MAX}.`}</p>
          {#if applyError}<p class="err" role="alert">{applyError}</p>{/if}
          <div class="chooser-actions">
            <button type="button" class="apply" disabled={!canApply} onclick={applyChooser}>Apply location</button>
            <button type="button" class="secondary" onclick={cancelChooser}>Cancel</button>
          </div>
        </div>
      {/if}
    </div>

    {#if data.focus?.kind === "unavailable"}
      <p class="notice" role="status">
        No data is loaded for {data.focus.code}, so there is no section to open. It
        can still be found by searching.
      </p>
    {/if}

    {#if shown}
      <div id={HUB_RESULTS_ID} class="hub-results hub-target">
        {#if shown.tooShort}
          <p class="notice" role="status">Type at least {HUB_FIND_MIN} characters to search.</p>
        {:else if shown.total === 0}
          <p class="notice" role="status">
            {#if shown.mode === "typed"}
              No local match for “{shown.submitted ?? shown.find}”.
            {:else if shown.map}
              No coordinate-known verified hotspot lies within {plural(shown.map.dist, "mile", "miles")} of {shown.map.place}.
            {/if}
            This means nothing in the reference geography, loaded counties, verified
            hotspots or failed loads matches — not that the place does not exist in
            eBird. To bring a new area in, load hotspots from
            <a href="/forecast">Forecast</a> or a region below.
          </p>
        {:else}
          <p class="hub-count" role="status">
            {#if shown.mode === "typed"}
              Showing {shown.first.toLocaleString()}–{shown.last.toLocaleString()} of
              {shown.total.toLocaleString()} {shown.total === 1 ? "match" : "matches"} for
              “{shown.submitted ?? shown.find}”
            {:else if shown.map}
              Showing {shown.first.toLocaleString()}–{shown.last.toLocaleString()} of
              {shown.total.toLocaleString()} verified {shown.total === 1 ? "hotspot" : "hotspots"} within
              {plural(shown.map.dist, "mile", "miles")} of {shown.map.place}, nearest first
            {/if}
            <span class="muted2">· page {shown.page} of {shown.pageCount.toLocaleString()}</span>
          </p>
          <p class="muted2">
            {#if shown.mode === "typed"}
              {countsText(shown)}. Best matches first: exact code, exact name, name
              prefix, then names and contexts that contain your text.
            {:else if shown.map}
              Measured {shown.map.evaluated.toLocaleString()} verified hotspots with recorded
              coordinates. {shown.map.unevaluable.toLocaleString()} more locally known verified
              hotspots have no recorded coordinates and could not be measured. Region
              centres are never used.
            {/if}
          </p>
          {#if shown.mode === "map" && shown.summary && (shown.summary.countries.length || shown.summary.regions.length || shown.summary.counties.length)}
            <div class="hub-summary">
              <h3>Areas represented by nearby verified hotspots</h3>
              <p class="muted2">
                Taken from these hotspots' recorded areas. This does not say the
                map point lies inside any of them.
              </p>
              <ul class="hub-areas">
                {#each [...shown.summary.countries, ...shown.summary.regions, ...shown.summary.counties] as area (area.type + area.code)}
                  {@render areaLink(area)}
                {/each}
              </ul>
            </div>
          {/if}
          <ul class="hub-hits">
            {#each shown.results as r (r.type + r.id)}
              {@const href = selectHref(r.target, resultRowId(r.id))}
              <li class="hub-hit" data-type={r.type}>
                <span class="hitmain">
                  {#if href}
                    <a
                      id={resultRowId(r.id)}
                      class="hublink path-focus-target"
                      {href}
                      onclick={navigationAction(data.accountId, { label: r.name, originId: resultRowId(r.id) })}
                      ><strong>{r.name}</strong></a
                    >
                  {:else}
                    <strong class="hubname">{r.name}</strong>
                  {/if}
                  {#if r.context}<span class="hitctx">· {r.context}</span>{/if}
                  <span class="code">{r.id}</span>
                </span>
                <span class="hitmeta">
                  <span class="hittype" data-type={r.type}>{TYPE_LABEL[r.type]}</span>
                  {#if r.distanceMiles != null}<span> · {r.distanceMiles.toLocaleString()} mi</span>{/if}
                  <span> · {stateText(r)}</span>
                  {#if r.type === "hotspot" && r.evidence.length > 1}
                    <span class="evidence"> · evidence: {r.evidence.slice(1).join("; ")}</span>
                  {/if}
                  {#if !href}
                    <span class="evidence"> · loading is available to the account owner</span>
                  {/if}
                </span>
              </li>
            {/each}
          </ul>
          {#if shown.pageCount > 1}
            <nav class="pagination" aria-label="More discovery results">
              {#if shown.page > 1}<a href={pageHref(shown.page - 1)}>← Previous</a>{/if}
              <span>Page {shown.page} of {shown.pageCount.toLocaleString()}</span>
              {#if shown.page < shown.pageCount}<a href={pageHref(shown.page + 1)}>Next →</a>{/if}
            </nav>
          {/if}
        {/if}
        <a class="clear-discovery" href={clearDiscoveryHref}>Clear search</a>
      </div>
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

  <section class="card" id="background-work">
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
      {#if pausedJobs.length > 0}
        <p class="jobgroup"><strong>Paused</strong> · {pausedJobs.length} job{pausedJobs.length === 1 ? "" : "s"}</p>
      {/if}
      {#if scheduledJobs.length > 0}
        <p class="jobgroup"><strong>Scheduled or waiting</strong> · {scheduledJobs.length} job{scheduledJobs.length === 1 ? "" : "s"}</p>
      {/if}
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
                {jobPresentationText(j.presentation, j.progress)}
                {#if j.presentation?.state === "waiting" || j.presentation?.state === "retry-scheduled"}&nbsp;(attempt {j.attempts} of {j.maxAttempts}){/if}
              </span>
              {#if !data.isViewer && j.presentation?.state !== "cancelling" && !recurringJobTypes.has(j.type)}
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
            {#if j.presentation?.state === "running" && total > 0}
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
        <summary>Recent load history (latest 15 terminal jobs)</summary>
        <ul class="jobs">
          {#each jobsPoll.recent as j (j.id)}
            <li>
              <div class="jobhead">
                <strong>{j.displayName}</strong>
                {#if j.requestedByName}
                  <span class="jobby">queued by {j.requestedByName}</span>
                {/if}
                <span class="jobstatus" data-color={j.statusColor}>
                  {j.presentation?.state ?? j.status}{#if j.finishedAt}
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
    <section class="card hub-target" id="load-region">
      <h2>Load a region</h2>
      {#if data.preselectRegion}
        <p class="notice" role="status">
          Preselected from your search: <strong>{data.states.find((r) => r.code === data.preselectRegion)?.name ?? data.preselectRegion}</strong>.
          Nothing has been loaded; choose <em>Load data</em> below if you want it.
        </p>
      {/if}
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
              <optgroup label="Countries not fully loaded (alphabetical)">
                {#each filteredCountries as c (c.code)}
                  <option value={c.code}>{c.name}</option>
                {/each}
              </optgroup>
            </select>
          </div>
        {/if}
        <!-- Region lists are local reference data (Phase 3) — the old
             list-fetch error state no longer exists. -->
        {#if data.countries.length === 0}
          <p class="notice">
            Every available country and region is loaded. Refresh existing data below when a
            newer complete year becomes available.
          </p>
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
            <select id="region-select" name="region" required value={data.preselectRegion ?? ""}>
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
        Loaded data ({totalCountryCount} countr{totalCountryCount === 1 ? "y" : "ies"}
        · {@render speciesTotal("world", "world")})
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
    {#if totalCountryCount === 0}
      <p class="notice">Nothing loaded yet — load a region above.</p>
    {:else}
      {#if data.offlineView}
        <p class="notice" role="status">
          This search or selection view did not contact eBird when it opened, so
          totals such as “of N counties” and hotspot-to-load counts are not
          shown. Explicitly opening inventory groups below may request current
          hotspot counts from eBird. <a href={fullViewHref}>Open the full inventory</a>
          to see the totals.
        </p>
      {/if}
      <p class="notice">
        Species totals count each species once across loaded historical data—not
        a complete range checklist.
      </p>
      {#each geographicAreas as area (area.id)}
        {@render geographicArea(area)}
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
      <details class="failed-section" open={data.focus?.kind === "failed"}>
        <summary>
          <h2>Failed loads ({data.failed.length})</h2>
        </summary>
        <p class="notice">
          These locations were attempted but have no stored data. eBird's export
          sometimes errors on individual hotspots — retrying later often works.
        </p>
        <ul class="failed">
          {#each data.failed as f (f.locCode)}
            <li id={hubFailedId(f.locCode)} class="hub-target" class:unverified={f.unverified} tabindex="-1">
              <div class="failinfo">
                <strong>{f.locName ?? f.locCode}</strong>
                {#if f.unverified}
                  <span class="unverified-tag">reported location — hotspot status unverified</span>
                {/if}
                {#if f.regionName}
                  <span class="region">· {f.regionName}</span>
                {/if}
                <span class="code">{f.locCode}</span>
                <span class="err">{f.error ?? "unknown error"}</span>
                <span class="when">{fmtDate(f.lastAttemptAt)}</span>
                {#if f.unverified}
                  <span class="muted2">Retrying reloads history; it does not verify that this is a hotspot or say anything about public access.</span>
                {/if}
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
  .area-group {
    border-top: 1px solid var(--border);
  }
  .area-group:first-of-type {
    border-top: none;
  }
  .area-group > summary {
    cursor: pointer;
    min-height: 52px;
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    color: var(--text);
    font-size: 1rem;
  }
  .area-group > summary:hover {
    background: var(--bg);
  }
  .area-countries {
    margin-left: 12px;
    border-left: 2px solid var(--border);
    padding-left: 12px;
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
  .species-total {
    white-space: nowrap;
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
    color: var(--on-accent);
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
    color: var(--on-accent);
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
    color: var(--on-danger);
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

  /* ---- Phase 8B: discovery ---- */
  .hub-target {
    scroll-margin-top: calc(var(--nav-h) + 16px);
  }
  .hub-target:focus-visible {
    outline: 3px solid var(--accent);
    outline-offset: 2px;
  }
  .findform {
    margin: 0;
  }
  .find-entry {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .hubsearch {
    flex: 1;
    min-width: 0;
    width: 100%;
    min-height: 48px;
    padding: 8px 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg);
    color: var(--text);
    font-size: 1rem;
  }
  .find-entry .hubsearch {
    width: auto;
    min-width: 12rem;
  }
  .find-submit,
  .chooser-actions button,
  .map-chooser > button.secondary {
    min-height: 48px;
    padding: 10px 18px;
    font-size: 1rem;
    font-weight: 600;
    border-radius: 8px;
  }
  .find-submit,
  .chooser-actions .apply {
    border: 1px solid var(--accent);
    background: var(--accent);
    color: var(--on-accent);
    cursor: pointer;
  }
  .chooser-actions .apply:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .map-chooser {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 12px;
    padding-top: 12px;
    border-top: 1px solid var(--border);
    margin-top: 8px;
  }
  .map-label {
    margin: 0;
    font-weight: 600;
  }
  .map-chooser > button.secondary {
    width: fit-content;
  }
  /* minmax(0, 1fr): an auto column would size to the picker's intrinsic search
     row and push it past a 320px viewport. */
  .chooser {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 12px;
    min-width: 0;
  }
  .chooser h3 {
    margin: 0;
    font-size: 1.05rem;
    scroll-margin-top: calc(var(--nav-h) + 16px);
  }
  .chooser p {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .picked {
    font-weight: 600;
  }
  .radius-field {
    display: grid;
    gap: 4px;
    font-size: 0.89rem;
    font-weight: 600;
  }
  .radius-field input {
    min-height: 48px;
    max-width: 12rem;
    padding: 8px 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg);
    color: var(--text);
    font-size: 1rem;
  }
  .chooser-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
  }
  .hub-results {
    margin-top: 12px;
    padding-top: 12px;
    border-top: 1px solid var(--border);
  }
  .hub-count {
    margin: 0 0 4px;
    font-weight: 600;
  }
  .hub-summary h3 {
    font-size: 1rem;
    margin: 8px 0 4px;
  }
  .hub-areas,
  .hub-hits {
    list-style: none;
    padding: 0;
    margin: 8px 0 0;
  }
  .hub-areas li,
  .hub-hits li {
    display: flex;
    gap: 4px 12px;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    min-height: 48px;
    padding: 2px 0;
  }
  .hub-areas li + li,
  .hub-hits li + li {
    border-top: 1px solid var(--border);
  }
  .hitmain {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .hitctx {
    color: var(--muted);
    font-size: 0.88rem;
  }
  .hitmeta {
    color: var(--muted);
    font-size: 0.85rem;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .hittype {
    color: var(--text);
    font-weight: 600;
  }
  /* Verified hotspot and unverified reported location differ in shape and mark,
     not only in words or colour: solid bar and ✓ versus dashed bar and ⚠. */
  .hub-hit[data-type="hotspot"] {
    border-left: 4px solid var(--accent);
    padding-left: 10px;
  }
  .hub-hit[data-type="reported"],
  .failed li.unverified {
    border-left: 4px dashed var(--muted);
    padding-left: 10px;
    background: var(--bg);
  }
  .hittype[data-type="hotspot"]::before {
    content: "✓ ";
  }
  .hittype[data-type="reported"]::before,
  .unverified-tag::before {
    content: "⚠ ";
  }
  .unverified-tag {
    color: var(--text);
    font-weight: 600;
  }
  .evidence {
    color: var(--muted);
  }
  .hubname {
    overflow-wrap: anywhere;
  }
  .pagination {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 16px;
    margin: 12px 0 0;
  }
  .pagination a,
  .clear-discovery {
    display: inline-flex;
    align-items: center;
    min-height: 48px;
  }
  .clear-discovery {
    margin-top: 4px;
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
