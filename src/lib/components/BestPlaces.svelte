<script lang="ts" module>
  // Structurally matches PlaceRanking from $server/needs (kept local to avoid
  // importing a server-only module into client code).
  export interface Place {
    locId: string | null;
    locName: string;
    lat: number;
    lng: number;
    needCount: number;
    needSpecies: { code: string; comName: string }[];
    lastObsDt: string;
    distanceKm: number | null;
  }
</script>

<script lang="ts">
  import { formatKm } from "$lib/geo";
  import MapLink from "$components/MapLink.svelte";

  let {
    places = [],
    title = "Best places for your needs",
    limit = 10,
  }: { places?: Place[]; title?: string; limit?: number } = $props();

  let shown = $derived(places.slice(0, limit));

  function speciesList(p: Place): string {
    const names = p.needSpecies.map((s) => s.comName);
    const head = names.slice(0, 6).join(", ");
    return head + (names.length > 6 ? ` +${names.length - 6} more` : "");
  }
</script>

{#if places.length > 0}
  <section class="card">
    <h2>{title}</h2>
    <p class="muted intro">
      Ranked by how many of your needs were reported there recently.
    </p>
    {#each shown as p, i (p.locId ?? p.locName)}
      <div class="place">
        <div class="rank">{i + 1}</div>
        <div class="grow">
          <div class="name">
            {#if p.locId}
              <a
                href={`https://ebird.org/hotspot/${p.locId}`}
                target="_blank"
                rel="noopener">{p.locName}</a
              >
            {:else}
              {p.locName}
            {/if}
          </div>
          <div class="meta">{speciesList(p)}</div>
          <MapLink lat={p.lat} lng={p.lng} name={p.locName} />
        </div>
        <div class="right">
          <div class="count">
            {p.needCount}
            <span class="lbl">{p.needCount === 1 ? "need" : "needs"}</span>
          </div>
          <div class="when">
            {#if p.distanceKm != null}{formatKm(p.distanceKm)} ·
            {/if}{p.lastObsDt.slice(0, 10)}
          </div>
        </div>
      </div>
    {/each}
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
  .rank {
    flex: 0 0 24px;
    width: 24px;
    height: 24px;
    border-radius: 50%;
    background: var(--accent-soft);
    color: var(--accent);
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 700;
    font-size: 0.8rem;
    margin-top: 2px;
  }
  .grow {
    flex: 1;
    min-width: 0;
  }
  .name {
    font-weight: 700;
  }
  .name a {
    color: var(--text);
    text-decoration: none;
  }
  .name a:hover {
    text-decoration: underline;
  }
  .meta {
    color: var(--muted);
    font-size: 0.83rem;
    margin-top: 2px;
  }
  .right {
    text-align: right;
    flex-shrink: 0;
  }
  .count {
    font-weight: 700;
    color: var(--accent);
    white-space: nowrap;
  }
  .count .lbl {
    font-weight: 600;
    font-size: 0.78rem;
  }
  .when {
    color: var(--muted);
    font-size: 0.78rem;
  }
</style>
