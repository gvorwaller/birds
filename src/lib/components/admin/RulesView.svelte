<script lang="ts">
  /**
   * A rule set shown readably, not as raw JSON (td-894144 plan "Admin Tags
   * tab" §2). Display only: it reads the stored artifact defensively and
   * never decides anything — the server-side loader is the only parser that
   * matters.
   */
  let { artifact }: { artifact: unknown } = $props();

  type Match = { type?: string; phrase?: string };
  type Scope = { rank?: string; values?: string[] };
  type Support = {
    id?: string;
    group?: string;
    match?: Match;
    note?: string;
    taxa?: Scope[];
  };
  type Exclude = {
    id?: string;
    binds?: string[];
    match?: Match;
    scope?: { unit?: string; before?: number; after?: number };
    note?: string;
  };
  type Taxon = {
    id?: string;
    rank?: string;
    values?: string[];
    action?: string;
    note?: string;
  };

  const record = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === "object" && !Array.isArray(v);
  const exactKeys = (v: Record<string, unknown>, keys: string[]) =>
    Object.keys(v).length === keys.length &&
    Object.keys(v).every((key) => keys.includes(key));
  const strings = (v: unknown): v is string[] =>
    Array.isArray(v) && v.every((item) => typeof item === "string");
  const match = (v: unknown) =>
    record(v) &&
    exactKeys(v, ["type", "phrase"]) &&
    (v.type === "literal" || v.type === "stem") &&
    typeof v.phrase === "string";
  const scopeShape = (v: unknown) => {
    if (!record(v)) return false;
    if (v.unit === "clause" || v.unit === "sentence")
      return exactKeys(v, ["unit"]);
    return (
      v.unit === "window" &&
      exactKeys(v, ["unit", "before", "after"]) &&
      Number.isInteger(v.before) &&
      Number.isInteger(v.after)
    );
  };
  const RANKS = ["order", "family", "genus"];
  const scopeList = (v: unknown) =>
    Array.isArray(v) &&
    v.length >= 1 &&
    v.length <= 3 &&
    v.every(
      (e) =>
        record(e) &&
        exactKeys(e, ["rank", "values"]) &&
        RANKS.includes(e.rank as string) &&
        strings(e.values),
    );
  const displayable = (v: unknown): v is Record<string, unknown> => {
    if (
      !record(v) ||
      !exactKeys(v, [
        "schema",
        "tag",
        "rev",
        "denySections",
        "comparisonMarkers",
        "support",
        "exclude",
        "taxon",
      ])
    )
      return false;
    const v2 = v.schema === 2;
    if (
      (v.schema !== 1 && !v2) ||
      typeof v.tag !== "string" ||
      typeof v.rev !== "string" ||
      !strings(v.denySections) ||
      !strings(v.comparisonMarkers)
    )
      return false;
    if (
      !Array.isArray(v.support) ||
      (v.support.length === 0 && !v2) ||
      !Array.isArray(v.exclude) ||
      !Array.isArray(v.taxon)
    )
      return false;
    if (
      !v.support.every(
        (item) =>
          record(item) &&
          (exactKeys(item, ["id", "group", "match", "note"]) ||
            (v2 &&
              exactKeys(item, ["id", "group", "match", "note", "taxa"]) &&
              scopeList(item.taxa))) &&
          typeof item.id === "string" &&
          typeof item.group === "string" &&
          match(item.match) &&
          typeof item.note === "string",
      )
    )
      return false;
    if (
      !v.exclude.every(
        (item) =>
          record(item) &&
          exactKeys(item, ["id", "binds", "match", "scope", "note"]) &&
          typeof item.id === "string" &&
          strings(item.binds) &&
          match(item.match) &&
          scopeShape(item.scope) &&
          typeof item.note === "string",
      )
    )
      return false;
    return v.taxon.every(
      (item) =>
        record(item) &&
        exactKeys(item, ["id", "rank", "values", "action", "note"]) &&
        typeof item.id === "string" &&
        (item.rank === "order" ||
          item.rank === "family" ||
          (v2 && item.rank === "genus")) &&
        strings(item.values) &&
        (item.action === "require_one_of" ||
          item.action === "forbid" ||
          (v2 && item.action === "assign")) &&
        typeof item.note === "string",
    );
  };
  const valid = $derived(displayable(artifact));
  const a = $derived((valid ? artifact : {}) as Record<string, unknown>);
  const list = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
  const support = $derived(list<Support>(a.support));
  const exclude = $derived(list<Exclude>(a.exclude));
  const taxon = $derived(list<Taxon>(a.taxon));
  const assigns = $derived(taxon.filter((t) => t.action === "assign"));
  const gates = $derived(taxon.filter((t) => t.action !== "assign"));
  const scoped = (s: Support) =>
    s.taxa?.length
      ? ` — only for ${s.taxa
          .map((e) => `${e.rank} ${(e.values ?? []).join(" or ")}`)
          .join(" and ")}`
      : "";
  const deny = $derived(list<string>(a.denySections));
  const markers = $derived(list<string>(a.comparisonMarkers));
  const groups = $derived([...new Set(support.map((s) => s.group ?? "—"))]);

  const phrase = (m?: Match) =>
    `“${m?.phrase ?? "?"}”${m?.type === "stem" ? " (and its word forms)" : ""}`;
  function scope(x: Exclude): string {
    const u = x.scope?.unit;
    if (u === "window")
      return `within ${x.scope?.before ?? 0} words before${x.scope?.after ? ` or ${x.scope.after} after` : ""}`;
    if (u === "clause") return "in the same clause";
    if (u === "sentence") return "in the same sentence";
    return u ?? "anywhere";
  }
  const action = (t: Taxon) =>
    t.action === "require_one_of"
      ? "must be one of"
      : t.action === "forbid"
        ? "must not be"
        : (t.action ?? "?");
</script>

{#if !valid}
  <p class="artifact-error" role="alert">
    This stored artifact does not match the supported rules format, so it cannot
    be shown safely.
  </p>
{:else}
  <div class="rules">
    {#if assigns.length}
      <h4>Tag every species in these groups (no article wording needed)</h4>
      <ul>
        {#each assigns as t, i (t.id ?? i)}
          <li>
            {t.rank === "genus" ? "Genus" : t.rank === "family" ? "Family" : "Order"}:
            {(t.values ?? []).join(", ")}
            {#if t.note}<span class="muted">— {t.note}</span>{/if}
          </li>
        {/each}
      </ul>
    {/if}
    {#if support.length}
    <h4>{assigns.length ? "Otherwise, tag" : "Assign"} when the article says (any group)</h4>
    <ul>
      {#each groups as gname (gname)}
        <li>
          <strong>{gname}</strong>:
          {#each support.filter((s) => (s.group ?? "—") === gname) as s, i (s.id ?? i)}
            {i > 0 ? " or " : ""}{phrase(s.match)}{scoped(s)}{#if s.note}<span
                class="muted"
              >
                ({s.note})</span
              >{/if}{/each}
        </li>
      {/each}
    </ul>
    {/if}
    {#if exclude.length}
      <h4>But not when</h4>
      <ul>
        {#each exclude as x, i (x.id ?? i)}
          <li>
            {phrase(x.match)} appears {scope(x)}{x.binds &&
            !x.binds.includes("*")
              ? ` (only for: ${x.binds.join(", ")})`
              : ""}
            {#if x.note}<span class="muted">— {x.note}</span>{/if}
          </li>
        {/each}
      </ul>
    {/if}
    {#if gates.length}
      <h4>Taxonomy (checked first)</h4>
      <ul>
        {#each gates as t, i (t.id ?? i)}
          <li>
            The {t.rank ?? "?"}
            {action(t)}: {(t.values ?? []).join(", ")}
            {#if t.note}<span class="muted">— {t.note}</span>{/if}
          </li>
        {/each}
      </ul>
    {/if}
    {#if deny.length}
      <p class="muted">
        Sections never read: headings containing {deny
          .map((d) => `“${d}”`)
          .join(", ")}.
      </p>
    {/if}
    {#if markers.length}
      <p class="muted">
        Comparison phrases that cancel a match nearby: {markers
          .map((m) => `“${m}”`)
          .join(", ")}.
      </p>
    {/if}
  </div>
{/if}

<style>
  .rules h4 {
    font-size: 0.9rem;
    margin: 0.8rem 0 0.3rem;
  }
  .rules ul {
    margin: 0;
    padding-left: 1.2rem;
    line-height: 1.5;
  }
  .rules p {
    margin: 0.5rem 0;
    line-height: 1.5;
  }
  .muted {
    color: var(--muted);
  }
  .artifact-error {
    padding: 10px 12px;
    border-radius: 8px;
    background: var(--danger-soft);
    color: var(--danger);
  }
</style>
