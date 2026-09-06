<script lang="ts">
  import { enhance } from "$app/forms";
  import { untrack } from "svelte";
  import { THEMES, themeStyle } from "$lib/themes";
  import type { ActionData, PageData } from "./$types";
  let { data, form }: { data: PageData; form: ActionData } = $props();
  let selected = $state(untrack(() => data.theme));
  let saving = $state(false);
  $effect(() => {
    selected = data.theme;
  });
</script>

<svelte:head><title>Appearance — birds</title></svelte:head>
<div class="page">
  <h1>Settings · Appearance</h1>
  <p>
    Your theme follows your account across devices. It does not change anyone
    else’s view or bird data.
  </p>
  {#if form && "message" in form}<p class="feedback" role="status">
      {form.message}
    </p>{/if}
  {#if form && "error" in form}<p class="error" role="alert">
      {form.error}
    </p>{/if}
  <form
    method="POST"
    action="?/save_theme"
    use:enhance={() => {
      saving = true;
      return async ({ update }) => {
        try {
          await update();
        } finally {
          saving = false;
        }
      };
    }}
  >
    <fieldset disabled={saving}>
      <legend>Choose a theme</legend>
      <div class="choices">
        {#each THEMES as theme}
          <label class="choice">
            <input
              type="radio"
              name="theme"
              value={theme.id}
              bind:group={selected}
            />
            <span class="description"
              ><strong>{theme.name}</strong><span>{theme.description}</span
              ></span
            >
            <span
              class="preview"
              style={themeStyle(theme.id)}
              aria-hidden="true"
            >
              <span>birds</span><span class="sample-button">Aa</span>
            </span>
          </label>
        {/each}
      </div>
    </fieldset>
    <button type="submit" disabled={saving}
      >{saving ? "Saving…" : "Save theme"}</button
    >
  </form>
  {#if data.user?.role !== "viewer"}<a href="/settings">← All settings</a>{/if}
</div>

<style>
  .page {
    max-width: 780px;
    margin: 0 auto;
    padding: 24px 16px;
  }
  h1 {
    margin-bottom: 8px;
  }
  p {
    margin-bottom: 20px;
  }
  fieldset {
    border: 0;
    min-width: 0;
  }
  legend {
    font-weight: 700;
    margin-bottom: 12px;
  }
  .choices {
    display: grid;
    gap: 12px;
  }
  .choice {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 16px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--card);
    cursor: pointer;
  }
  input {
    width: 22px;
    height: 22px;
    flex-shrink: 0;
    accent-color: var(--accent);
  }
  .description {
    display: grid;
    gap: 4px;
    flex: 1;
  }
  .description > span {
    font-size: 0.9rem;
    color: var(--muted);
  }
  .preview {
    display: flex;
    gap: 10px;
    align-items: center;
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--border);
    padding: 10px;
    border-radius: 8px;
  }
  .sample-button {
    background: var(--accent);
    color: var(--on-accent);
    padding: 3px 6px;
    border-radius: 4px;
  }
  button {
    margin: 20px 0;
    min-height: 48px;
    padding: 10px 20px;
    border: 0;
    border-radius: 8px;
    background: var(--accent);
    color: var(--on-accent);
    font-weight: 700;
  }
  .feedback {
    color: var(--seen-text);
    background: var(--seen-bg);
    padding: 12px;
    border-radius: 8px;
  }
  .error {
    color: var(--notable-text);
    background: var(--notable-bg);
    padding: 12px;
  }
  @media (max-width: 639px) {
    .choice {
      flex-wrap: wrap;
    }
    .description {
      min-width: 190px;
    }
    .preview {
      margin-left: 34px;
    }
  }
</style>
