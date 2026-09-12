<script lang="ts">
  let { active }: { active: "browse" | "viewed" | "taxonomy" | "interest" } = $props();
</script>

<nav class="tabs" aria-label="Field guide sections">
  <a
    href="/species"
    class:active={active === "browse"}
    aria-current={active === "browse" ? "page" : undefined}>Browse species</a
  >
  <a
    href="/viewed"
    class:active={active === "viewed"}
    aria-current={active === "viewed" ? "page" : undefined}>Viewed species</a
  >
  <a href="/special-interest" class:active={active === "interest"} aria-current={active === "interest" ? "page" : undefined}>Special interest</a>
  <a href="/taxonomy" class:active={active === "taxonomy"} aria-current={active === "taxonomy" ? "page" : undefined}>Taxonomy</a>
</nav>

<style>
  .tabs {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 6px;
    margin-bottom: 16px;
    border-bottom: 2px solid var(--border);
  }
  a {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
    min-height: 48px;
    padding: 12px 8px;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: center;
    text-align: center;
    text-decoration: none;
    color: var(--muted);
    font-weight: 600;
    font-size: 0.92rem;
    border-bottom: 3px solid transparent;
    margin-bottom: -2px;
  }
  a:hover {
    color: var(--text);
  }
  a.active {
    color: var(--accent);
    border-bottom-color: var(--accent);
  }
  @media (min-width: 640px) {
    .tabs { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  }
</style>
