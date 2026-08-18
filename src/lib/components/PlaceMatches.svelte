<script lang="ts">
  import { formatDistance, type DistanceUnit } from "$lib/geo";
  import MapLink from "$components/MapLink.svelte";
  import type { PlaceMatch } from "$lib/place-search";

  let {
    places = [],
    query = "",
    focusedKey = null,
    distanceUnit = "mi",
    partial = false,
    onfocusplace,
  }: {
    places?: PlaceMatch[];
    query?: string;
    focusedKey?: string | null;
    distanceUnit?: DistanceUnit;
    /** Some per-species detail calls failed, so coverage is incomplete. */
    partial?: boolean;
    onfocusplace?: (place: PlaceMatch) => void;
  } = $props();

  // Once a place is focused, the point of the page is the birds BELOW this
  // list — so collapse to the focused row and put the rest behind a toggle.
  // Left expanded, 20 matches push the bird results thousands of pixels down a
  // phone screen, which defeats the Focus action the user just took.
  let showAll = $state(false);
  // Collapse only when the focused place is actually among the current
  // matches. Editing the query after focusing can leave a focused key that no
  // longer matches — collapsing then would render zero rows under a "Focused
  // on 1 of N" heading, hiding every result behind a button nobody knows about.
  let focusedInResults = $derived(
    !!focusedKey && places.some((p) => p.key === focusedKey),
  );
  let collapsed = $derived(focusedInResults && !showAll);
  let shown = $derived(
    collapsed ? places.filter((p) => p.key === focusedKey) : places,
  );
  let hiddenCount = $derived(places.length - shown.length);

  // Re-collapse whenever the focused place changes, so picking a new place from
  // the expanded list doesn't leave the long list open on top of the results.
  $effect(() => {
    focusedKey;
    showAll = false;
  });

  function summary(p: PlaceMatch): string {
    const bits: string[] = [];
    if (p.needCodes.size > 0) {
      bits.push(`${p.needCodes.size} ${p.needCodes.size === 1 ? "need" : "needs"}`);
    }
    if (p.notableCodes.size > 0) {
      bits.push(
        `${p.notableCodes.size} ${p.notableCodes.size === 1 ? "rarity" : "rarities"}`,
      );
    }
    if (p.distanceKm != null) bits.push(formatDistance(p.distanceKm, distanceUnit));
    bits.push(p.lastObsDt.slice(0, 10));
    return bits.join(" · ");
  }
</script>

{#if places.length > 0}
  <section class="card" aria-labelledby="place-matches-heading">
    <h2 id="place-matches-heading">Places</h2>
    <p class="muted intro">
      {#if collapsed}
        Focused on 1 of {places.length}
        {places.length === 1 ? "place" : "places"} matching “{query}”{partial
          ? " (some locations may be missing)"
          : ""}.
      {:else}
        {places.length}
        {places.length === 1 ? "place" : "places"} matching “{query}” in the
        reports loaded for this view{partial
          ? " (some locations may be missing)"
          : ""}.
      {/if}
    </p>
    {#each shown as p (p.key)}
      <div class="place" class:focused={p.key === focusedKey}>
        <div class="grow">
          <div class="name">
            {#if p.isHotspot && p.locId}
              <!-- Name → internal hotspot page (Phase 1); badge stays eBird. -->
              <a class="place-link" href={`/hotspots/${p.locId}`}>{p.locName}</a>
              <a
                class="hotspot-badge"
                href={`https://ebird.org/hotspot/${p.locId}`}
                target="_blank"
                rel="noopener"
                title="Verified eBird hotspot">eBird hotspot ↗</a
              >
            {:else}
              {p.locName}
            {/if}
          </div>
          <div class="meta">{summary(p)}</div>
          <MapLink
            lat={p.lat}
            lng={p.lng}
            name={p.locName}
            googlePlaceId={p.googlePlaceId}
          />
        </div>
        <button
          type="button"
          class="focus-btn"
          aria-pressed={p.key === focusedKey}
          onclick={() => onfocusplace?.(p)}
        >
          {p.key === focusedKey ? "Focused" : "Focus"}
        </button>
      </div>
    {/each}
    {#if focusedInResults && (hiddenCount > 0 || showAll)}
      <button
        type="button"
        class="toggle-all"
        aria-expanded={showAll}
        onclick={() => (showAll = !showAll)}
      >
        {showAll
          ? "Hide other places"
          : `Change place (${hiddenCount} other ${hiddenCount === 1 ? "match" : "matches"})`}
      </button>
    {/if}
  </section>
{/if}

<style>
  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px;
    margin-bottom: 12px;
  }
  .card h2 {
    font-size: 1.05rem;
    margin-bottom: 4px;
  }
  .intro {
    color: var(--muted);
    font-size: 0.83rem;
    margin-bottom: 6px;
  }
  .place {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 12px 0;
    border-top: 1px solid var(--border);
  }
  .place:first-of-type {
    border-top: none;
  }
  .focused {
    background: var(--accent-soft);
    border-radius: 6px;
    padding-left: 8px;
    padding-right: 8px;
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
  .focus-btn {
    flex-shrink: 0;
    min-height: 48px;
    padding: 8px 16px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--card);
    color: var(--accent);
    font-weight: 700;
    font-size: 0.9rem;
    cursor: pointer;
    white-space: nowrap;
  }
  .toggle-all {
    display: inline-flex;
    align-items: center;
    min-height: 48px;
    margin-top: 8px;
    padding: 8px 16px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--card);
    color: var(--accent);
    font-weight: 600;
    cursor: pointer;
  }
  .focus-btn[aria-pressed="true"] {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }
</style>
