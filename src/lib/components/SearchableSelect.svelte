<script lang="ts">
  /**
   * Searchable Place field for the Field Guide (td-daff98 §3b): a WAI-ARIA 1.2
   * editable combobox with a listbox popup. Typing filters; only activating an
   * option (or the clear button) changes the committed choice, and every other
   * way of leaving puts the committed label back, so the visible text and the
   * submitted code never disagree. The page renders a native <select> until
   * hydration; this component replaces it afterwards.
   */
  import {
    matchPlaceChoices,
    placePage,
    PLACE_PAGE_SIZE,
    type PlaceChoice,
  } from "$lib/place-filter";

  let {
    id,
    name,
    label,
    choices,
    value,
    anywhereLabel,
    disabled = false,
    disabledText = "",
    loading = false,
    emptyText = "",
    onCommit,
  }: {
    id: string;
    name: string;
    label: string;
    choices: PlaceChoice[];
    value: string;
    anywhereLabel: string;
    disabled?: boolean;
    disabledText?: string;
    loading?: boolean;
    emptyText?: string;
    onCommit: (code: string) => void;
  } = $props();

  const committedLabel = $derived(
    value ? (choices.find((c) => c.code === value)?.name ?? value) : "",
  );

  let text = $state("");
  let typed = $state(false);
  let open = $state(false);
  let active = $state(-1);
  let pages = $state(1);
  let input = $state<HTMLInputElement | undefined>();

  // Outside an edit, the field always shows the committed choice.
  $effect(() => {
    const labelNow = committedLabel;
    if (!open) text = labelNow;
  });

  const matches = $derived(typed ? matchPlaceChoices(choices, text) : choices);
  const page = $derived(placePage(matches, pages));
  /** Rows in the popup: "anywhere" first, the visible matches, then "show next". */
  const rows = $derived([
    ...(typed && text.trim()
      ? []
      : [{ kind: "anywhere" as const, code: "", name: anywhereLabel }]),
    ...page.shown.map((c) => ({ kind: "choice" as const, code: c.code, name: c.name })),
    ...(page.remaining > 0 ? [{ kind: "more" as const, code: "", name: "" }] : []),
  ]);
  const listId = $derived(`${id}-list`);
  const optionId = (i: number) => {
    const row = rows[i];
    if (!row) return undefined;
    if (row.kind === "anywhere") return `${id}-opt-any`;
    if (row.kind === "more") return `${id}-more`;
    return `${id}-opt-${row.code.replace(/[^A-Za-z0-9_-]/g, "_")}`;
  };
  const activeId = $derived(open && active >= 0 ? optionId(active) : undefined);
  const countText = $derived(
    !open
      ? ""
      : matches.length === 0
        ? "No matches"
        : page.remaining > 0
          ? `Showing ${page.shown.length} of ${matches.length.toLocaleString()} matches${typed ? ", best matches first" : ""}`
          : `${matches.length.toLocaleString()} ${matches.length === 1 ? "match" : "matches"}${typed && text.trim() ? ", best matches first" : ""}`,
  );

  // Keep the active option visible while arrows move (focus stays in the input).
  $effect(() => {
    const target = activeId;
    if (target) document.getElementById(target)?.scrollIntoView({ block: "nearest" });
  });

  function openPopup() {
    if (disabled || loading) return;
    open = true;
    const current = rows.findIndex((r) => r.kind !== "more" && r.code === value);
    active = current >= 0 ? current : 0;
  }

  function dismiss() {
    open = false;
    typed = false;
    pages = 1;
    active = -1;
    text = committedLabel;
  }

  // Option presses. A MOUSE press is cancelled so the input keeps focus and
  // doesn't dismiss the list before the click commits. A TOUCH press must not
  // be cancelled: iOS Safari derives pointer events from touch events, so
  // cancelling pointerdown also cancels the tap and no click ever fires (seen
  // on the owner's iPhone, 2026-09-25). Instead a touch press marks the list
  // as being tapped, so a blur during the tap doesn't dismiss it.
  let touchPress = false;
  let touchTimer: ReturnType<typeof setTimeout> | undefined;
  function optionPointerDown(event: PointerEvent) {
    if (event.pointerType === "mouse") {
      event.preventDefault();
      return;
    }
    touchPress = true;
    clearTimeout(touchTimer);
  }
  /** A touch that ends without a click (a scroll, a drag away) releases the
   * list; if focus has already left the field, close it like any dismissal. */
  function optionPointerEnd() {
    if (!touchPress) return;
    clearTimeout(touchTimer);
    touchTimer = setTimeout(() => {
      touchPress = false;
      if (open && document.activeElement !== input) dismiss();
    }, 400);
  }

  function activate(i: number) {
    const row = rows[i];
    if (!row) return;
    if (row.kind === "more") {
      pages += 1;
      active = i;
      return;
    }
    const byTouch = touchPress;
    touchPress = false;
    clearTimeout(touchTimer);
    open = false;
    typed = false;
    pages = 1;
    active = -1;
    onCommit(row.code);
    text = row.kind === "anywhere" ? "" : row.name;
    // Put the on-screen keyboard away so the next field is visible.
    if (byTouch) input?.blur();
  }

  function onInput(event: Event) {
    text = (event.currentTarget as HTMLInputElement).value;
    typed = true;
    pages = 1;
    if (!open) open = true;
    // A typed query starts on its best matching choice. An unmatched query has
    // no active option, so Enter cannot silently clear the committed value.
    active = rows.findIndex((row) => row.kind === "choice");
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.isComposing) return;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        if (!open) openPopup();
        else active = Math.min(rows.length - 1, active + 1);
        break;
      case "ArrowUp":
        event.preventDefault();
        if (!open) openPopup();
        else active = Math.max(0, active - 1);
        break;
      case "Home":
        if (open) { event.preventDefault(); active = 0; }
        break;
      case "End":
        if (open) { event.preventDefault(); active = rows.length - 1; }
        break;
      case "Enter":
        // Enter never submits the form from a Place field: only Apply does.
        event.preventDefault();
        if (open && active >= 0) activate(active);
        // Nothing matches: leave the choice as it was and show its label again.
        else if (open) dismiss();
        else openPopup();
        break;
      case "Escape":
        if (open) { event.preventDefault(); dismiss(); }
        break;
      case "Tab":
        if (open) dismiss();
        break;
    }
  }

  function clear() {
    onCommit("");
    text = "";
    dismiss();
    input?.focus();
  }
</script>

<div class="searchable">
  <label for={id}>{label}</label>
  <div class="field">
    <input
      bind:this={input}
      {id}
      type="text"
      role="combobox"
      aria-autocomplete="list"
      aria-expanded={open}
      aria-controls={listId}
      aria-activedescendant={activeId}
      aria-describedby={`${id}-count`}
      autocomplete="off"
      autocorrect="off"
      autocapitalize="off"
      spellcheck="false"
      disabled={disabled || loading}
      placeholder={loading ? "Loading…" : disabled ? disabledText : choices.length === 0 && emptyText ? emptyText : anywhereLabel}
      value={text}
      oninput={onInput}
      onkeydown={onKeydown}
      onfocus={() => input?.select()}
      onclick={() => (open ? null : openPopup())}
      onblur={() => { if (open && !touchPress) dismiss(); }}
    />
    {#if value && !disabled && !loading}
      <button type="button" class="clear" aria-label={`Clear ${label.toLowerCase()}`} onclick={clear}>✕</button>
    {/if}
  </div>
  <input type="hidden" {name} {value} />
  <p id={`${id}-count`} class="count" aria-live="polite">{countText}</p>
  {#if open}
    <ul id={listId} role="listbox" aria-label={label} class="list">
      {#each rows as row, i (optionId(i))}
        {#if row.kind === "more"}
          <!-- Keyboard use lives on the combobox input (aria-activedescendant),
               per the WAI-ARIA combobox pattern; options are never focused. -->
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <li
            id={optionId(i)}
            role="option"
            aria-selected="false"
            class="more"
            class:active={i === active}
            onpointerdown={optionPointerDown}
            onpointerup={optionPointerEnd}
            onpointercancel={optionPointerEnd}
            onclick={() => activate(i)}
          >Show next {Math.min(PLACE_PAGE_SIZE, page.remaining)} of {page.remaining.toLocaleString()} more</li>
        {:else}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <li
            id={optionId(i)}
            role="option"
            aria-selected={row.code === value}
            class:active={i === active}
            class:anywhere={row.kind === "anywhere"}
            onpointerdown={optionPointerDown}
            onpointerup={optionPointerEnd}
            onpointercancel={optionPointerEnd}
            onclick={() => activate(i)}
          >{row.name}</li>
        {/if}
      {/each}
    </ul>
  {/if}
</div>

<style>
  .searchable {
    position: relative;
    min-width: 0;
  }
  label {
    display: block;
    font-size: 0.89rem;
    font-weight: 600;
    margin-bottom: 4px;
  }
  .field {
    position: relative;
  }
  input[type="text"] {
    width: 100%;
    box-sizing: border-box;
    min-height: 48px;
    padding: 10px 44px 10px 12px;
    /* 16px or more keeps iOS Safari from zooming on focus. */
    font-size: max(1rem, 16px);
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
  }
  input[type="text"]:disabled {
    opacity: 0.7;
  }
  input[type="text"]:focus-visible {
    outline: 3px solid var(--accent);
    outline-offset: 2px;
  }
  .clear {
    position: absolute;
    right: 2px;
    top: 50%;
    transform: translateY(-50%);
    min-width: 48px;
    min-height: 48px;
    background: none;
    border: 0;
    color: var(--muted);
    font-size: 1rem;
    cursor: pointer;
  }
  .count {
    margin: 2px 0 0;
    min-height: 0;
    font-size: 0.85rem;
    color: var(--muted);
  }
  .count:empty {
    display: none;
  }
  .list {
    position: absolute;
    z-index: 20;
    left: 0;
    right: 0;
    max-height: min(60vh, 360px);
    overflow-y: auto;
    overscroll-behavior: contain;
    margin: 4px 0 0;
    padding: 4px 0;
    list-style: none;
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: 0 8px 24px rgb(0 0 0 / 0.35);
  }
  .list li {
    display: flex;
    align-items: center;
    min-height: 48px;
    padding: 8px 12px;
    cursor: pointer;
    overflow-wrap: anywhere;
  }
  .list li.active {
    background: var(--accent);
    color: var(--on-accent);
  }
  .list li[aria-selected="true"]:not(.active) {
    font-weight: 700;
  }
  .list li.anywhere,
  .list li.more {
    color: var(--muted);
    font-style: italic;
  }
  .list li.active.anywhere,
  .list li.active.more {
    color: var(--on-accent);
  }
</style>
