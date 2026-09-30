<script lang="ts">
  /**
   * Blind labelling (td-894144 Release B4, plan rev 26 §B4h): one masked
   * article, one fixed question, three answers. Nothing the rules or the old
   * AI tags said is shown. After an answer is saved the bird is named, for
   * context only, and the next page appears.
   */
  import { enhance } from "$app/forms";
  import type { ActionData, PageData } from "./$types";

  let { data, form }: { data: PageData; form: ActionData } = $props();
  let busy = $state(false);
  const pct = $derived(
    data.item && data.item.total > 0 ? Math.round((data.item.labelled / data.item.total) * 100) : 0,
  );
</script>

<svelte:head><title>Blind test · {data.tag} · Admin</title></svelte:head>

<div class="page">
  <p class="back"><a href="/admin/tags/{encodeURIComponent(data.tag)}">← {data.tag}</a></p>

  {#if form && "revealed" in form && form.revealed}
    <p class="reveal" role="status">Saved “{form.answered}”. That was <strong>{form.revealed}</strong>.</p>
  {:else if form && !form.ok}
    <p class="error" role="alert">{form.message}</p>
  {/if}

  {#if data.closed}
    <section class="card">
      <h1>Blind test closed</h1>
      <p>This blind test is {data.closed}. There is nothing left to label here.</p>
    </section>
  {:else if data.item?.done}
    <section class="card">
      <h1>All pages answered</h1>
      <p>Every page in this blind test has an answer ({data.item.total} of {data.item.total}).</p>
      <p>Go back to the tag page to freeze the blind test and compute its gate report.</p>
    </section>
  {:else if data.item}
    {@const item = data.item}
    <div class="progress" role="group" aria-label="Progress">
      <span>{item.labelled} of {item.total} answered</span>
      <progress max={item.total} value={item.labelled} aria-label={`${pct}% answered`}></progress>
    </div>

    <section class="card question-card" aria-labelledby="question">
      <h1 id="question">{data.question}</h1>
      <p class="muted">
        Judge only what the two texts say: the bird's own article, and below it the opening of its family's
        Wikipedia article. The bird's names are hidden as “[this bird]”. Sea and ocean words are underlined on every
        page as a reading aid; they are not an answer. <a href="#answer">Jump to the answer buttons</a>.
      </p>
    </section>

    <article class="card text" aria-label="Article text">
      {#each item.sections as s, i (i)}
        {#if s.title}<h2>{s.title}</h2>{/if}
        <p>
          {#each s.runs as r, j (j)}{#if r.cue}<u>{r.text}</u>{:else}{r.text}{/if}{/each}
        </p>
      {/each}
    </article>

    {#if item.family}
      <article class="card text family" aria-label="The bird's family, from Wikipedia">
        <p class="eyebrow">Its family, from Wikipedia</p>
        <h2>{item.family.title}</h2>
        <p>
          {#each item.family.runs as r, j (j)}{#if r.cue}<u>{r.text}</u>{:else}{r.text}{/if}{/each}
        </p>
      </article>
    {/if}

    <form
      id="answer"
      class="card answers"
      method="POST"
      action="?/answer"
      use:enhance={() => {
        busy = true;
        return async ({ update }) => {
          await update({ reset: true });
          busy = false;
          window.scrollTo({ top: 0 });
        };
      }}
    >
      <input type="hidden" name="itemId" value={item.itemId} />
      <p class="q">{data.question}</p>
      <div class="buttons">
        <button type="submit" name="label" value="yes" disabled={busy}>Yes</button>
        <button type="submit" name="label" value="no" disabled={busy}>No</button>
        <button type="submit" name="label" value="unsure" class="secondary" disabled={busy}>Unsure</button>
      </div>
      <p class="muted">Answers can't be changed once saved. “Unsure” is fine; it counts against the rules.</p>
    </form>
  {/if}
</div>

<style>
  .page {
    max-width: 760px;
    margin: 0 auto;
    padding: 16px;
  }
  .back a {
    display: inline-flex;
    align-items: center;
    min-height: 48px;
    color: var(--accent);
    overflow-wrap: anywhere;
  }
  .card {
    padding: 1rem;
    margin-block: 0.9rem;
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 8px;
  }
  h1 {
    font-size: 1.15rem;
    margin: 0 0 0.5rem;
    line-height: 1.4;
  }
  .text h2 {
    font-size: 1rem;
    margin: 1rem 0 0.3rem;
  }
  .text p {
    line-height: 1.65;
    margin: 0.4rem 0;
    white-space: pre-line;
    overflow-wrap: anywhere;
  }
  .family {
    border-style: dashed;
  }
  .eyebrow {
    margin: 0;
    font-size: 0.8rem;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--muted);
  }
  .family h2 {
    margin-top: 0.3rem;
  }
  .text u {
    text-decoration-thickness: 2px;
    text-underline-offset: 3px;
  }
  .progress {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
  }
  .progress progress {
    flex: 1 1 160px;
    height: 12px;
  }
  .q {
    font-weight: 600;
    margin: 0 0 0.6rem;
    line-height: 1.4;
  }
  .buttons {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 10px;
  }
  button {
    min-height: 56px;
    font-size: 1.05rem;
    font-weight: 700;
    border: 1px solid var(--accent);
    border-radius: 8px;
    background: var(--accent);
    color: var(--on-accent);
    cursor: pointer;
  }
  button.secondary {
    background: var(--card);
    color: var(--accent);
  }
  button:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .muted {
    color: var(--muted);
    line-height: 1.5;
  }
  .muted a {
    color: var(--accent);
  }
  .reveal {
    padding: 10px 12px;
    border-radius: 8px;
    background: var(--accent-soft);
    color: var(--accent);
  }
  .error {
    padding: 10px 12px;
    border-radius: 8px;
    background: var(--danger-soft);
    color: var(--danger);
  }
</style>
