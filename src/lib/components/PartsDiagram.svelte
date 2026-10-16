<script lang="ts">
  import { onMount, tick } from "svelte";
  import { PART_GROUPS, type BirdDiagram, type DiagramView, type Layer, type View } from "$lib/bird-parts/types";
  import {
    getView,
    hasFeatherLayer,
    layerAfterViewChange,
    selectionAfterLayerChange,
    viewsDrawing,
    visibleParts,
  } from "$lib/bird-parts";

  let {
    diagram,
    selected = $bindable<string | null>(null),
    layer = $bindable<Layer>("main"),
    view = $bindable<View>("standing"),
    wingOnly = $bindable(false),
  }: { diagram: BirdDiagram; selected?: string | null; layer?: Layer; view?: View; wingOnly?: boolean } = $props();

  // Without JS the page is a read-only glossary: every view's drawing, no switches, no tap instructions.
  let hydrated = $state(false);
  onMount(() => (hydrated = true));

  const active = $derived(getView(diagram, view));
  const twoLayers = $derived(hasFeatherLayer(active));
  const shown = $derived(visibleParts(active, layer));
  const part = $derived(diagram.glossary.find((p) => p.id === selected) ?? null);
  const drawnHere = $derived(shown.find((p) => p.id === selected) ?? null);
  const elsewhere = $derived(selected && !drawnHere ? viewsDrawing(diagram, selected).filter((v) => v.id !== view) : []);
  const order = $derived(diagram.glossary.map((p) => p.id));
  const listed = $derived(
    hydrated
      ? [...shown].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))
      : diagram.glossary,
  );
  const groups = $derived(
    PART_GROUPS.map((g) => ({ name: g, parts: listed.filter((p) => p.group === g) })).filter((g) => g.parts.length),
  );
  const captionId = $derived(`${diagram.id}-caption`);
  const switchId = $derived(`${diagram.id}-layers`);
  const viewsId = $derived(`${diagram.id}-views`);

  function choose(id: string) {
    selected = selected === id ? null : id;
  }

  // A switch can remove the focused part's button; never leave focus on nothing.
  async function keepFocus(groupId: string, focusedPart: string | null) {
    await tick();
    if (focusedPart && !document.getElementById(`${diagram.id}-${focusedPart}`)) {
      document.getElementById(groupId)?.querySelector<HTMLButtonElement>("button[aria-pressed='true']")?.focus();
    }
  }
  const focusedPart = () => (document.activeElement as HTMLElement | null)?.dataset?.part ?? null;

  async function setLayer(next: Layer) {
    const f = focusedPart();
    layer = next;
    selected = selectionAfterLayerChange(active, selected, next);
    await keepFocus(switchId, f);
  }

  // A view change keeps the selection, so the same feathers can be found on the open wing.
  async function setView(next: View) {
    const f = focusedPart();
    layer = layerAfterViewChange(diagram, selected, next, layer);
    view = next;
    await keepFocus(viewsId, f);
  }

  // From the caption: the pressed link disappears once the part is drawn, so focus its name instead.
  async function showIn(next: View) {
    await setView(next);
    const chip = selected ? document.getElementById(`${diagram.id}-${selected}`) : null;
    (chip ?? document.getElementById(viewsId)?.querySelector<HTMLButtonElement>("button[aria-pressed='true']"))?.focus();
  }

  // The drawing is a pointer shortcut; the list below is the keyboard and screen-reader control.
  function tapParts(svg: SVGSVGElement) {
    const onClick = (e: MouseEvent) => {
      const id = (e.target as Element | null)?.closest("[data-part]")?.getAttribute("data-part");
      if (id) choose(id);
    };
    svg.addEventListener("click", onClick);
    return { destroy: () => svg.removeEventListener("click", onClick) };
  }

  const describe = (v: DiagramView) =>
    v.id === "standing" ? `${diagram.model.pose}` : v.id === "above" ? "in flight, from above" : "in flight, from below";

  const TONES: Record<string, string> = {
    pale: "#f4efe6", light: "#e6dccb", mid: "#b9a68a", wing: "#a18c6f", dark: "#7a6650", darker: "#4a3d30",
    bill: "#8c8172", leg: "#c49a7a", legyellow: "#e0b23a", billyellow: "#d9c05a", accent2: "#5b5fa8",
    water: "#6c8fb0", gullgray: "#a9b1ba", legpink: "#d9a79b", eye: "#1c1c1c", perch: "#9b9286",
    accent: "#c0392b", orbital: "#e08a2c", mallardgreen: "#3c5f45", chestnut: "#7a4a35",
    gullpale: "#d3d8de", linegray: "#6f7780", orange: "#e0893a",
  };
</script>

{#snippet drawing(v: DiagramView, lyr: Layer, viewBox: string, interactive: boolean)}
  <svg {viewBox} role="img" aria-label={`Diagram of a ${diagram.title.toLowerCase()}, ${describe(v)}`} use:tapParts>
    {#each v.insets as inset}
      <circle class="inset" cx={inset.cx} cy={inset.cy} r={inset.r} />
      <text class="inset-label" x={inset.cx} y={inset.cy + inset.r - 8}>{inset.label}</text>
    {/each}
    {#each v.under as s}
      <path d={s.d} fill={TONES[s.tone]} class="base" />
    {/each}
    {#each visibleParts(v, lyr) as p (p.id)}
      <path d={p.d} fill={TONES[p.tone]} fill-rule="evenodd" class="part" class:selected={interactive && p.id === selected} data-part={p.id} />
      {#each p.marks ?? [] as m}
        <path d={m.d} fill={TONES[m.tone]} class="mark" />
      {/each}
    {/each}
    {#if v.outline}<path d={v.outline} class="outline" />{/if}
    {#each v.over as s}
      <path d={s.d} fill={TONES[s.tone]} class="over" />
    {/each}
    {#if interactive && drawnHere}
      <path d={drawnHere.d} fill-rule="evenodd" class="selection" />
    {/if}
  </svg>
{/snippet}

<div class="diagram">
  <p class="model">{diagram.intro}</p>

  {#if hydrated}
    <div class="switches">
      <div class="layers views" id={viewsId} role="group" aria-label="View">
        {#each diagram.views as v (v.id)}
          <button type="button" aria-pressed={view === v.id} onclick={() => setView(v.id)}>{v.label}</button>
        {/each}
      </div>
      {#if twoLayers}
        <div class="layers" id={switchId} role="group" aria-label="Parts shown">
          <button type="button" aria-pressed={layer === "main"} onclick={() => setLayer("main")}>Main parts</button>
          <button type="button" aria-pressed={layer === "feathers"} onclick={() => setLayer("feathers")}>All feather groups</button>
        </div>
      {/if}
      {#if active.wingViewBox}
        <div class="layers" role="group" aria-label="Drawing size">
          <button type="button" aria-pressed={!wingOnly} onclick={() => (wingOnly = false)}>Whole bird</button>
          <button type="button" aria-pressed={wingOnly} onclick={() => (wingOnly = true)}>One wing, larger</button>
        </div>
      {/if}
    </div>

    <div class="plate">
      {@render drawing(active, layer, wingOnly && active.wingViewBox ? active.wingViewBox : active.viewBox, true)}
    </div>

    <p class="caption" id={captionId} aria-live="polite">
      {#if part}
        <strong>{part.name}</strong>{#if part.aka}<span class="aka"> ({part.aka})</span>{/if} — {part.lookFor}
        {#if part.visibility}<span class="visibility">{part.visibility}</span>{/if}
        {#if elsewhere.length}
          <span class="elsewhere">
            Not drawn in this view. Show it:
            {#each elsewhere as v (v.id)}
              <button type="button" class="btn-link" onclick={() => showIn(v.id)}>{v.label}</button>
            {/each}
          </span>
        {/if}
      {:else}
        Tap a part, or a name below.
      {/if}
    </p>
  {:else}
    {#each diagram.views as v (v.id)}
      <figure class="plate">
        {@render drawing(v, "main", v.viewBox, false)}
        <figcaption>{v.label}</figcaption>
      </figure>
    {/each}
  {/if}

  {#each groups as g (g.name)}
    <h3 class="group">{g.name}</h3>
    {#if hydrated}
      <ul class="chips">
        {#each g.parts as p (p.id)}
          <li>
            <button
              type="button"
              id={`${diagram.id}-${p.id}`}
              data-part={p.id}
              aria-pressed={p.id === selected}
              aria-describedby={p.id === selected ? captionId : undefined}
              onclick={() => choose(p.id)}>{p.name}</button
            >
          </li>
        {/each}
      </ul>
    {:else}
      <dl class="glossary">
        {#each g.parts as p (p.id)}
          <dt id={`${diagram.id}-${p.id}`}>{p.name}{#if p.aka}<span class="aka"> ({p.aka})</span>{/if}</dt>
          <dd>{p.lookFor}{#if p.visibility}<span class="visibility">{p.visibility}</span>{/if}</dd>
        {/each}
      </dl>
    {/if}
  {/each}

  <details class="sources">
    <summary>Drawing and sources</summary>
    <p>Our own simplified drawings of an {diagram.model.age} {diagram.model.species}: {diagram.model.pose}, and in flight from above and below. Reference photos were used only for proportions.</p>
    <ul>
      {#each diagram.sources as s}
        <li><a href={s.url} target="_blank" rel="noopener">{s.label}</a>{#if s.credit}<span class="muted"> — {s.credit}</span>{/if}</li>
      {/each}
    </ul>
  </details>
</div>

<style>
  .diagram {
    display: grid;
    gap: 10px;
  }
  .model {
    margin: 0;
  }
  .switches {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .layers {
    display: inline-flex;
    justify-self: start;
    flex-wrap: wrap;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg);
    padding: 2px;
  }
  .layers button,
  .chips button {
    min-height: 48px;
    padding: 8px 14px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--muted);
    font: inherit;
    font-size: 0.9rem;
    font-weight: 700;
    cursor: pointer;
  }
  /* On a phone each switch is one row of equal columns (labels may wrap to two lines),
     the view switch a full row of its own; from 640px they sit side by side at natural width. */
  @media (max-width: 639.98px) {
    .layers {
      display: grid;
      grid-auto-flow: column;
      grid-auto-columns: minmax(0, 1fr);
    }
    .layers button {
      padding: 6px 8px;
      line-height: 1.2;
    }
    .views {
      flex: 1 1 100%;
    }
  }
  .layers button[aria-pressed="true"] {
    background: var(--accent);
    color: var(--on-accent);
  }
  .layers button:focus-visible,
  .chips button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  /* The drawing keeps its natural colours on a light plate in every theme. */
  .plate {
    background: #fbfaf7;
    border: 1px solid var(--border);
    border-radius: 8px;
  }
  svg {
    display: block;
    width: 100%;
    max-width: 760px;
    height: auto;
    margin: 0 auto;
  }
  .part {
    cursor: pointer;
    stroke: #8a7d6c;
    stroke-width: 0.6;
    stroke-linejoin: round;
  }
  .part.selected {
    fill: #f6c344;
  }
  .base {
    stroke: #2a2a2a;
    stroke-width: 0.6;
  }
  .outline {
    fill: none;
    stroke: #2a2a2a;
    stroke-width: 1.4;
    stroke-linejoin: round;
    pointer-events: none;
  }
  .over,
  .mark,
  .selection,
  .inset,
  .inset-label {
    pointer-events: none;
  }
  /* The selected part is repainted on top, because feather rows overlap (a gull's white trailing
     edge lies over its secondaries). The dashed, fixed-width outline means a selection never
     depends on colour alone, even on tiny parts. */
  .selection {
    fill: #f6c344;
    stroke: #8e1b10;
    stroke-width: 2.5px;
    stroke-dasharray: 5 3;
    vector-effect: non-scaling-stroke;
  }
  .inset {
    fill: #f7f7f5;
    stroke: #8a7d6c;
    stroke-width: 0.8;
    stroke-dasharray: 3 2;
  }
  .inset-label {
    font-size: 13px;
    text-anchor: middle;
    fill: #333;
  }
  .caption {
    margin: 0;
    min-height: 3em;
  }
  .elsewhere {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0 8px;
    margin-top: 4px;
    color: var(--muted);
    font-size: 0.9rem;
  }
  .btn-link {
    min-height: 48px;
    padding: 0 6px;
    border: 0;
    background: none;
    color: var(--link);
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }
  .btn-link:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  figure.plate {
    margin: 0;
  }
  figcaption {
    padding: 4px 10px 8px;
    color: #4a4a4a;
    font-size: 0.85rem;
    text-align: center;
  }
  .aka {
    color: var(--muted);
    font-weight: 400;
  }
  .visibility {
    display: block;
    margin-top: 4px;
    color: var(--muted);
    font-size: 0.9rem;
  }
  .group {
    margin: 6px 0 0;
    font-size: 0.85rem;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .chips button {
    border: 1px solid var(--border);
    border-radius: 22px;
    background: var(--card);
    color: var(--text);
    font-weight: 400;
  }
  .chips button[aria-pressed="true"] {
    border-color: var(--accent);
    background: var(--accent-soft);
    color: var(--text);
    font-weight: 700;
  }
  .glossary {
    margin: 0;
  }
  .glossary dt {
    font-weight: 700;
    margin-top: 8px;
    scroll-margin-top: 90px;
  }
  .glossary dd {
    margin: 2px 0 0;
  }
  .sources summary {
    min-height: 48px;
    display: flex;
    align-items: center;
    cursor: pointer;
    color: var(--muted);
    font-size: 0.9rem;
  }
  .sources ul {
    margin: 0;
    padding-left: 18px;
  }
  .sources li {
    margin: 4px 0;
    overflow-wrap: anywhere;
  }
  .muted {
    color: var(--muted);
  }
</style>
