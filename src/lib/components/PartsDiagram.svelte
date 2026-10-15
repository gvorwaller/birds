<script lang="ts">
  import { onMount, tick } from "svelte";
  import { PART_GROUPS, type BirdDiagram, type Layer } from "$lib/bird-parts/types";
  import { hasFeatherLayer, selectionAfterLayerChange, visibleParts } from "$lib/bird-parts";

  let {
    diagram,
    selected = $bindable<string | null>(null),
    layer = $bindable<Layer>("main"),
  }: { diagram: BirdDiagram; selected?: string | null; layer?: Layer } = $props();

  // Without JS the page is a read-only glossary: no layer switch, no tap instructions.
  let hydrated = $state(false);
  onMount(() => (hydrated = true));

  const twoLayers = $derived(hasFeatherLayer(diagram));
  const shown = $derived(visibleParts(diagram, hydrated ? layer : "main"));
  const current = $derived(diagram.parts.find((p) => p.id === selected) ?? null);
  const listed = $derived(
    [...(hydrated ? shown : diagram.parts)].sort((a, b) => diagram.listOrder.indexOf(a.id) - diagram.listOrder.indexOf(b.id)),
  );
  const groups = $derived(
    PART_GROUPS.map((g) => ({ name: g, parts: listed.filter((p) => p.group === g) })).filter((g) => g.parts.length),
  );
  const captionId = $derived(`${diagram.id}-caption`);
  const switchId = $derived(`${diagram.id}-layers`);

  function choose(id: string) {
    selected = selected === id ? null : id;
  }

  async function setLayer(next: Layer) {
    const focusedPart = (document.activeElement as HTMLElement | null)?.dataset?.part ?? null;
    layer = next;
    selected = selectionAfterLayerChange(diagram, selected, next);
    await tick();
    // A layer change can remove the focused part's button; never leave focus on nothing.
    if (focusedPart && !document.querySelector(`#${diagram.id}-${focusedPart}`)) {
      document.getElementById(switchId)?.querySelector<HTMLButtonElement>("button[aria-pressed='true']")?.focus();
    }
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

  const TONES: Record<string, string> = {
    pale: "#f4efe6", light: "#e6dccb", mid: "#b9a68a", wing: "#a18c6f", dark: "#7a6650", darker: "#4a3d30",
    bill: "#8c8172", leg: "#c49a7a", legyellow: "#e0b23a", billyellow: "#d9c05a", accent2: "#5b5fa8",
    water: "#6c8fb0", gullgray: "#a9b1ba", legpink: "#d9a79b", eye: "#1c1c1c", perch: "#9b9286",
    accent: "#c0392b", orbital: "#e08a2c", mallardgreen: "#3c5f45", chestnut: "#7a4a35",
  };
</script>

<div class="diagram">
  <p class="model">{diagram.intro}</p>

  {#if hydrated && twoLayers}
    <div class="layers" id={switchId} role="group" aria-label="Parts shown">
      <button type="button" aria-pressed={layer === "main"} onclick={() => setLayer("main")}>Main parts</button>
      <button type="button" aria-pressed={layer === "feathers"} onclick={() => setLayer("feathers")}>All feather groups</button>
    </div>
  {/if}

  <div class="plate">
    <svg viewBox={diagram.viewBox} role="img" aria-label={`Diagram of a ${diagram.title.toLowerCase()}`} use:tapParts>
      {#each diagram.insets as inset}
        <circle class="inset" cx={inset.cx} cy={inset.cy} r={inset.r} />
        <text class="inset-label" x={inset.cx} y={inset.cy + inset.r - 8}>{inset.label}</text>
      {/each}
      {#each diagram.under as s}
        <path d={s.d} fill={TONES[s.tone]} class="base" />
      {/each}
      {#each shown as p (p.id)}
        <path d={p.d} fill={TONES[p.tone]} fill-rule="evenodd" class="part" class:selected={p.id === selected} data-part={p.id} />
      {/each}
      {#if diagram.outline}<path d={diagram.outline} class="outline" />{/if}
      {#each diagram.over as s}
        <path d={s.d} fill={TONES[s.tone]} class="over" />
      {/each}
      {#if current && current.layers.includes(layer)}
        <path d={current.d} class="selection" />
      {/if}
    </svg>
  </div>

  {#if hydrated}
    <p class="caption" id={captionId} aria-live="polite">
      {#if current}
        <strong>{current.name}</strong>{#if current.aka}<span class="aka"> ({current.aka})</span>{/if} — {current.lookFor}
        {#if current.visibility}<span class="visibility">{current.visibility}</span>{/if}
      {:else}
        Tap a part, or a name below.
      {/if}
    </p>
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
    <p>Our own simplified drawing of an {diagram.model.age} {diagram.model.species}, {diagram.model.pose}. Reference photos were used only for proportions.</p>
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
  .selection,
  .inset,
  .inset-label {
    pointer-events: none;
  }
  /* Dashed, fixed-width outline so a selection never depends on colour alone, even on tiny parts. */
  .selection {
    fill: none;
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
