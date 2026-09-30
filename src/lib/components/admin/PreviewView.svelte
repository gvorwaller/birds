<script lang="ts">
  /**
   * A proposal's Preview (td-894144 B5, plan §3d): what these rules WOULD do
   * to every species, compared with the tags shown today. Descriptive only —
   * never a pass/fail; the blind test is the judge.
   */
  import AdminBadge from "./AdminBadge.svelte";

  type Rule = { ruleId: string; rank: string; value: string };
  type Example = {
    code: string;
    name: string;
    side: "rules-only" | "legacy-only" | "named";
    order: string | null;
    family: string | null;
    expect?: "yes" | "no";
    gating?: boolean;
    rulesStatus: string;
    rulesReason: string | null;
    legacy: boolean;
    evidence:
      | { kind: "taxon"; rules: Rule[] }
      | { kind: "text"; ruleId: string; section: string; sentence: string }
      | null;
    cueSentence?: { section: string; sentence: string } | null;
  };
  type Tally = { both: number; rulesOnly: number; legacyOnly: number };
  type Body = {
    counts: {
      universe: number;
      assigned: number;
      notAssigned: number;
      unevaluated: number;
      assignedByTaxon: number;
      assignedByPhrase: number;
      legacy: number;
      both: number;
      rulesOnly: number;
      legacyOnly: number;
    };
    byOrder: (Tally & { order: string })[];
    byFamily: (Tally & { family: string; order: string })[];
    examples: Example[];
    taxonCheck: { problems: string[]; overlapCount: number; truncated: boolean };
  };

  let {
    preview,
  }: {
    preview: { id: string; at: string; current: boolean; body: unknown };
  } = $props();
  const b = $derived(preview.body as Body);
  const nf = (n: number) => n.toLocaleString();
  const when = (iso: string) =>
    new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  const named = $derived(b.examples.filter((e) => e.side === "named"));
  const adds = $derived(b.examples.filter((e) => e.side === "rules-only"));
  const drops = $derived(b.examples.filter((e) => e.side === "legacy-only"));
  const rankWord = (r: string) =>
    r === "order" ? "order" : r === "family" ? "family" : "genus";
  const outcome = (e: Example) =>
    e.rulesStatus === "assigned"
      ? "would tag"
      : e.rulesStatus === "unevaluated"
        ? "can't decide"
        : "would not tag";
</script>

<div class="preview">
  <p class="head">
    <strong>Preview</strong> · {when(preview.at)}
    {#if preview.current}
      <AdminBadge tone="ok" label="Current" />
    {:else}
      <AdminBadge tone="warn" label="Out of date" />
    {/if}
  </p>
  {#if !preview.current}
    <p class="muted">
      Species data changed since this Preview ran. Run Preview again before the
      cross-check or approval.
    </p>
  {/if}

  <p>
    These rules would tag <strong>{nf(b.counts.assigned)}</strong> of
    {nf(b.counts.universe)} species — {nf(b.counts.assignedByTaxon)} because
    their family or genus is listed, {nf(b.counts.assignedByPhrase)} because of
    what their article says.
  </p>
  <ul class="tally">
    <li>
      <strong>{nf(b.counts.both)}</strong> of the {nf(b.counts.legacy)} species
      shown with this tag today keep it
    </li>
    <li><strong>{nf(b.counts.legacyOnly)}</strong> would lose it</li>
    <li><strong>{nf(b.counts.rulesOnly)}</strong> would gain it</li>
    {#if b.counts.unevaluated}
      <li>
        {nf(b.counts.unevaluated)} can't be decided (a missing order, family or
        genus)
      </li>
    {/if}
  </ul>

  {#if b.taxonCheck.problems.length}
    <div class="warn" role="alert">
      <p><strong>These rules don't fit the current taxonomy:</strong></p>
      <ul>
        {#each b.taxonCheck.problems as p, i (i)}<li>{p}</li>{/each}
      </ul>
    </div>
  {/if}

  {#snippet row(e: Example)}
    <li>
      <span class="name">{e.name}</span>
      <span class="muted">· {e.family ?? "?"} ({e.order ?? "?"})</span>
      {#if e.side === "named"}
        <br /><span class="muted"
          >Expected: {e.expect === "yes" ? "tagged" : "not tagged"}
          {#if e.gating}(must hold){/if} · Rules: {outcome(e)}</span
        >
        {#if (e.expect === "no") === (e.rulesStatus === "assigned") && e.gating}
          <AdminBadge tone="error" label="Wrong" />
        {/if}
      {/if}
      {#if e.evidence?.kind === "taxon"}
        <br /><span class="why"
          >Listed: {e.evidence.rules
            .map((r) => `${rankWord(r.rank)} ${r.value}`)
            .join(", ")}</span
        >
      {:else if e.evidence?.kind === "text"}
        <blockquote>
          “{e.evidence.sentence}”{#if e.evidence.section}<cite>
              — {e.evidence.section}</cite
            >{/if}
        </blockquote>
      {:else if e.side !== "rules-only" && e.rulesStatus !== "assigned"}
        {#if e.cueSentence}
          <blockquote class="drop">
            “{e.cueSentence.sentence}”{#if e.cueSentence.section}<cite>
                — {e.cueSentence.section}</cite
              >{/if}
          </blockquote>
        {:else if e.legacy}
          <br /><span class="muted">No sea or ocean wording in the scanned text.</span>
        {/if}
      {/if}
    </li>
  {/snippet}

  {#if named.length}
    <h4>Named birds</h4>
    <ul class="plain examples">
      {#each named as e (e.code)}{@render row(e)}{/each}
    </ul>
  {/if}
  {#if adds.length}
    <h4>Would gain the tag (examples)</h4>
    <ul class="plain examples">
      {#each adds as e (e.code)}{@render row(e)}{/each}
    </ul>
  {/if}
  {#if drops.length}
    <h4>Would lose the tag (examples)</h4>
    <ul class="plain examples">
      {#each drops as e (e.code)}{@render row(e)}{/each}
    </ul>
  {/if}

  <details>
    <summary>By order</summary>
    <div class="table-wrap">
      <table>
        <thead
          ><tr><th>Order</th><th>Keep</th><th>Lose</th><th>Gain</th></tr></thead
        >
        <tbody>
          {#each b.byOrder as o (o.order)}
            <tr
              ><td>{o.order}</td><td>{o.both}</td><td>{o.legacyOnly}</td><td
                >{o.rulesOnly}</td
              ></tr
            >
          {/each}
        </tbody>
      </table>
    </div>
  </details>
  <details>
    <summary>By family</summary>
    <div class="table-wrap">
      <table>
        <thead
          ><tr><th>Family</th><th>Keep</th><th>Lose</th><th>Gain</th></tr
          ></thead
        >
        <tbody>
          {#each b.byFamily as f (f.family)}
            <tr
              ><td>{f.family} <span class="muted">({f.order})</span></td><td
                >{f.both}</td
              ><td>{f.legacyOnly}</td><td>{f.rulesOnly}</td></tr
            >
          {/each}
        </tbody>
      </table>
    </div>
  </details>
</div>

<style>
  .preview {
    margin-block: 0.75rem;
    padding: 0.75rem;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg);
  }
  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin: 0 0 0.5rem;
  }
  .tally {
    margin: 0.25rem 0 0.75rem;
    padding-left: 1.2rem;
  }
  h4 {
    margin: 0.9rem 0 0.3rem;
    font-size: 0.95rem;
  }
  .examples li {
    padding-block: 0.35rem;
    border-bottom: 1px solid var(--border);
    overflow-wrap: anywhere;
  }
  .name {
    font-weight: 600;
  }
  .why {
    font-size: 0.92rem;
  }
  blockquote {
    margin: 0.3rem 0 0;
    padding-left: 0.6rem;
    border-left: 3px solid var(--accent);
    font-size: 0.92rem;
  }
  blockquote.drop {
    border-left-color: var(--muted);
  }
  cite {
    color: var(--muted);
    font-style: normal;
  }
  .warn {
    padding: 0.5rem 0.75rem;
    border-radius: 8px;
    background: var(--danger-soft);
    color: var(--danger);
  }
  .warn ul {
    margin: 0.25rem 0 0;
    padding-left: 1.2rem;
    overflow-wrap: anywhere;
  }
  .table-wrap {
    overflow-x: auto;
  }
  table {
    border-collapse: collapse;
    font-size: 0.9rem;
    font-variant-numeric: tabular-nums;
  }
  th,
  td {
    padding: 4px 10px 4px 0;
    text-align: left;
    border-bottom: 1px solid var(--border);
  }
  details {
    margin-top: 0.5rem;
  }
  summary {
    cursor: pointer;
    min-height: 44px;
    display: flex;
    align-items: center;
  }
  .muted {
    color: var(--muted);
  }
  ul.plain {
    list-style: none;
    padding: 0;
    margin: 0;
  }
</style>
