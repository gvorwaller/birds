<script lang="ts">
  /**
   * Admin → Tags → one tag (td-894144 Release B3; plan "Admin Tags tab"
   * §2–§6). Rules, history, proposals, reports and the owner actions. Long
   * or lock-holding work runs as a worker job; refresh to see its result.
   */
  import { enhance } from "$app/forms";
  import { tick } from "svelte";
  import AdminBadge from "$components/admin/AdminBadge.svelte";
  import RulesView from "$components/admin/RulesView.svelte";
  import type { ActionData, PageData } from "./$types";

  let { data, form }: { data: PageData; form: ActionData } = $props();
  const d = $derived(data.detail);

  type Confirm = {
    action: "activate" | "rollback" | "retire" | "approve";
    title: string;
    body: string;
    revisionId?: string;
    proposalId?: string;
  };
  let confirming = $state<Confirm | null>(null);
  let typed = $state("");
  let busy = $state(false);
  let confirmInput = $state<HTMLInputElement | null>(null);
  let confirmModal = $state<HTMLDivElement | null>(null);
  let returnFocus: HTMLElement | null = null;

  async function openConfirm(c: Confirm, trigger: HTMLElement) {
    returnFocus = trigger;
    confirming = c;
    typed = "";
    await tick();
    confirmInput?.focus();
  }
  async function closeConfirm() {
    confirming = null;
    await tick();
    if (returnFocus?.isConnected) returnFocus.focus();
    else document.querySelector<HTMLElement>(".back a")?.focus();
    returnFocus = null;
  }
  function onModalKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      void closeConfirm();
      return;
    }
    if (e.key !== "Tab" || !confirmModal) return;
    const controls = [
      ...confirmModal.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]):not([type="hidden"])',
      ),
    ];
    if (controls.length === 0) return;
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  const fmtWhen = (iso: string) =>
    new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  const nf = (n: unknown) => (typeof n === "number" ? n.toLocaleString() : "—");
  const readiness = (rev: string) =>
    data.readiness.find((r) => r.revisionId === rev);
  const jobActive = $derived(
    d.jobs.some((j) => j.status === "pending" || j.status === "running"),
  );

  const ACTION_LABEL: Record<string, string> = {
    activate: "Activated",
    rollback: "Rolled back",
    to_legacy: "Retired to legacy",
  };
  const JOB_LABEL: Record<string, string> = {
    tag_stage: "Stage report",
    tag_benchmark: "Switch benchmark",
    tag_activate: "Activate",
    tag_retire: "Retire to legacy",
    tag_rollback: "Roll back",
  };
  const jobTone = (s: string) =>
    s === "succeeded"
      ? "ok"
      : s === "failed"
        ? "error"
        : s === "cancelled"
          ? "neutral"
          : "warn";

  const submitting = () => {
    busy = true;
    return async ({ update }: { update: () => Promise<void> }) => {
      await update();
      busy = false;
      await closeConfirm();
    };
  };
</script>

<svelte:head><title>{d.tag} · Tags · Admin</title></svelte:head>

<div class="page" inert={confirming !== null}>
  <p class="back"><a href="/admin?tab=tags">← Admin: Tags</a></p>
  <h1>
    {d.tag}
    {#if d.owned}<AdminBadge
        tone="ok"
        label={`Rules r${d.owned.revisionId}`}
      />{:else}<AdminBadge label="Legacy" />{/if}
  </h1>

  {#if form?.message}
    <p class={form.ok ? "notice" : "error"} role={form.ok ? "status" : "alert"}>
      {form.message}
    </p>
  {/if}

  <section class="card" aria-labelledby="rules-heading">
    <h2 id="rules-heading">Current source</h2>
    {#if d.owned}
      {@const rev = d.revisions.find((r) => r.id === d.owned?.revisionId)}
      <p>
        Assigned by approved rules, revision {d.owned.revisionId}{rev
          ? `, approved ${fmtWhen(rev.approvedAt)}${rev.by ? ` by ${rev.by}` : ""}`
          : ""}.
      </p>
      {#if rev}<RulesView artifact={rev.artifact} />{/if}
    {:else}
      <p>
        This tag still comes from the earlier AI annotations (legacy). No rules
        own it.
      </p>
    {/if}
  </section>

  <section class="card" aria-labelledby="actions-heading">
    <h2 id="actions-heading">Revisions and actions</h2>
    {#if d.revisions.length === 0}
      <p class="muted">
        No approved revision yet. Approve a cross-checked proposal below first.
      </p>
    {/if}
    {#each d.revisions as r (r.id)}
      {@const ready = readiness(r.id)}
      <div class="revision">
        <h3>
          Revision {r.id}
          {#if d.owned?.revisionId === r.id}<AdminBadge
              tone="ok"
              label="Active"
            />{/if}
        </h3>
        <p class="muted">
          Approved {fmtWhen(r.approvedAt)}{r.by ? ` by ${r.by}` : ""}.
        </p>
        <details>
          <summary>Show rules</summary>
          <RulesView artifact={r.artifact} />
        </details>
        <div class="buttons">
          <form method="POST" action="?/stage" use:enhance={submitting}>
            <input type="hidden" name="revisionId" value={r.id} />
            <button type="submit" class="secondary" disabled={busy}
              >Stage report</button
            >
          </form>
          <form method="POST" action="?/benchmark" use:enhance={submitting}>
            <input type="hidden" name="revisionId" value={r.id} />
            <button type="submit" class="secondary" disabled={busy}
              >Switch benchmark</button
            >
          </form>
          {#if d.owned?.revisionId !== r.id}
            <button
              type="button"
              disabled={busy ||
                !ready?.gateReportId ||
                !ready?.benchmarkReportId}
              onclick={(event) =>
                openConfirm(
                  {
                    action: "activate",
                    revisionId: r.id,
                    title: `Activate revision ${r.id}?`,
                    body: "Rules will decide this tag for every species from now on. Species the rules do not assign lose the tag.",
                  },
                  event.currentTarget,
                )}>Activate…</button
            >
          {/if}
        </div>
        {#if d.owned?.revisionId !== r.id && (!ready?.gateReportId || !ready?.benchmarkReportId)}
          <p class="muted">
            Activate needs {[
              !ready?.gateReportId && "a passing gate report (the blind test)",
              !ready?.benchmarkReportId && "a passing switch benchmark",
            ]
              .filter(Boolean)
              .join(" and ")}.
          </p>
        {/if}
      </div>
    {/each}
    {#if d.owned}
      <div class="buttons danger-zone">
        <button
          type="button"
          class="secondary"
          disabled={busy}
          onclick={(event) =>
            openConfirm(
              {
                action: "rollback",
                title: "Roll back one step?",
                body: "Returns this tag to its previous revision, or to legacy if there was none. Refused while a taxonomy repair is running.",
              },
              event.currentTarget,
            )}>Roll back…</button
        >
        <button
          type="button"
          class="secondary"
          disabled={busy}
          onclick={(event) =>
            openConfirm(
              {
                action: "retire",
                title: "Retire to legacy?",
                body: "Every species goes back to its earlier AI-annotated value for this tag. Always available.",
              },
              event.currentTarget,
            )}>Retire to legacy…</button
        >
      </div>
    {/if}
    {#if d.jobs.length}
      <h3>
        Recent work {#if jobActive}<AdminBadge
            tone="warn"
            label="In progress"
          />{/if}
      </h3>
      <ul class="plain">
        {#each d.jobs as j (j.id)}
          <li>
            <AdminBadge tone={jobTone(j.status)} label={j.status} />
            {JOB_LABEL[j.type] ?? j.type} · #{j.id} · {fmtWhen(j.enqueuedAt)}
            {#if j.error}<br /><span class="fail">{j.error}</span>{/if}
          </li>
        {/each}
      </ul>
      {#if jobActive}<p class="muted">Refresh the page to see progress.</p>{/if}
    {/if}
  </section>

  <section class="card" aria-labelledby="why-heading">
    <h2 id="why-heading">Why does a species have or lack this tag?</h2>
    <form method="GET" class="why">
      <label for="why-q">Species name or code</label>
      <div class="row">
        <input
          id="why-q"
          name="why"
          type="search"
          value={data.whyQuery}
          autocomplete="off"
          required
          minlength="2"
          maxlength="80"
        />
        <button type="submit">Explain</button>
      </div>
    </form>
    {#if data.whyQuery && !data.why}
      <p class="muted">No species matches “{data.whyQuery}”.</p>
    {:else if data.why}
      {@const w = data.why}
      <h3>{w.name ?? w.code} <span class="muted">({w.code})</span></h3>
      <ul class="plain">
        <li>
          Shown with this tag now: <strong>{w.carries ? "yes" : "no"}</strong>
        </li>
        <li>
          Earlier AI annotation (legacy): {w.legacy === "no_baseline"
            ? "none recorded"
            : w.legacy === "has"
              ? "had it"
              : "did not have it"}
        </li>
        {#if d.owned}
          <li>
            {#if !w.member}
              Rules cannot evaluate it: no stored Wikipedia article or no
              current species taxonomy.
            {:else if !w.state}
              Rules result: not computed yet for its current article (it shows
              as unknown).
            {:else if w.state.status === "assigned"}
              Rules result: <strong>assigned</strong>, because the article says:
              {#each w.state.evidence as e, i (i)}<blockquote>
                  {e.sentence ?? ""}{#if e.section}<cite>
                      — {e.section}</cite
                    >{/if}
                </blockquote>{/each}
            {:else}
              Rules result: <strong
                >{w.state.status === "unevaluated"
                  ? "not evaluated"
                  : "not assigned"}</strong
              >
              ({w.state.reason ?? "no reason"}).
            {/if}
          </li>
        {/if}
        {#if w.articleRevId}<li class="muted">
            Wikipedia revision {w.articleRevId}
          </li>{/if}
      </ul>
      {#if w.matches.length}
        <p class="muted">
          Other matches:
          {#each w.matches as m, i (m.code)}{i > 0 ? ", " : ""}<a
              href="?why={encodeURIComponent(m.code)}">{m.name}</a
            >{/each}
        </p>
      {/if}
    {/if}
  </section>

  {#if d.samples.assigned.length || d.samples.notAssigned.length}
    <section class="card" aria-labelledby="samples-heading">
      <h2 id="samples-heading">
        Samples ({d.owned ? "active revision" : "latest revision"})
      </h2>
      <h3>Assigned</h3>
      <ul class="plain">
        {#each d.samples.assigned as s (s.code)}
          <li>
            <a href="?why={encodeURIComponent(s.code)}">{s.name ?? s.code}</a
            >{#if s.evidence?.sentence}<br /><span class="muted"
                >“{s.evidence.sentence}”</span
              >{/if}
          </li>
        {:else}<li class="muted">None.</li>{/each}
      </ul>
      <h3>Not assigned</h3>
      <ul class="plain">
        {#each d.samples.notAssigned as s (s.code)}
          <li>
            <a href="?why={encodeURIComponent(s.code)}">{s.name ?? s.code}</a>
            <span class="muted">— {s.reason ?? "—"}</span>
          </li>
        {:else}<li class="muted">None.</li>{/each}
      </ul>
    </section>
  {/if}

  <section class="card" aria-labelledby="proposals-heading">
    <h2 id="proposals-heading">Proposals</h2>
    <p class="muted">
      Drafts of rules, from AI or by hand. A draft can only be approved after an
      independent cross-check approved exactly this text.
    </p>
    {#each d.proposals as p (p.id)}
      {@const approvable =
        (p.status === "proposed" || p.status === "crosschecked") &&
        p.crosscheck?.verdict === "approve" &&
        p.crosscheck.matches}
      <div class="revision">
        <h3>
          {p.source === "ai" ? "AI draft" : "Hand-written draft"} · {fmtWhen(
            p.createdAt,
          )}
          <AdminBadge
            tone={p.status === "approved"
              ? "ok"
              : p.status === "rejected"
                ? "error"
                : "neutral"}
            label={p.status}
          />
        </h3>
        <details>
          <summary>Show rules</summary>
          <RulesView artifact={p.artifact} />
        </details>
        {#if p.crosscheck}
          <p>
            Cross-check by {p.crosscheck.reviewer}:
            <AdminBadge
              tone={p.crosscheck.verdict === "approve" ? "ok" : "error"}
              label={p.crosscheck.verdict}
            />
            {#if !p.crosscheck.matches}<AdminBadge
                tone="error"
                label="Reviewed a different version"
              />{/if}
          </p>
          <p class="crosscheck">{p.crosscheck.text}</p>
        {:else}
          <p class="muted">Not cross-checked yet.</p>
        {/if}
        {#if p.status === "proposed" || p.status === "crosschecked"}
          <div class="buttons">
            <button
              type="button"
              disabled={busy || !approvable}
              onclick={(event) =>
                openConfirm(
                  {
                    action: "approve",
                    proposalId: p.id,
                    title: "Approve these rules?",
                    body: "They become an immutable revision. Nothing changes for users until you stage, benchmark and activate it.",
                  },
                  event.currentTarget,
                )}>Approve…</button
            >
            <form method="POST" action="?/reject" use:enhance={submitting}>
              <input type="hidden" name="proposalId" value={p.id} />
              <button type="submit" class="secondary" disabled={busy}
                >Reject</button
              >
            </form>
          </div>
        {/if}
      </div>
    {:else}
      <p class="muted">No proposals yet.</p>
    {/each}
  </section>

  <section class="card" aria-labelledby="reports-heading">
    <h2 id="reports-heading">Reports</h2>
    {#each d.reports as r (r.id)}
      {@const b = r.body as Record<string, any>}
      <div class="revision">
        <h3>
          {r.kind === "stage"
            ? "Stage report"
            : r.kind === "benchmark"
              ? "Switch benchmark"
              : r.kind === "gate"
                ? "Gate report"
                : r.kind}
          {#if r.revisionId}· revision {r.revisionId}{/if}
          {#if "passed" in b}<AdminBadge
              tone={b.passed ? "ok" : "error"}
              label={b.passed ? "Passed" : "Did not pass"}
            />{/if}
        </h3>
        <p class="muted">{fmtWhen(r.at)}</p>
        {#if r.kind === "stage" && b.counts}
          <p>
            Would assign {nf(b.counts.assigned)} species · {nf(
              b.counts.would_add,
            )} gain the tag ·
            {nf(b.counts.would_remove)} lose it · {nf(b.counts.carrying_now)} carry
            it now.
          </p>
          {#if b.reasons?.length}
            <p class="muted">
              Not assigned because: {b.reasons
                .map(
                  (x: { reason: string; n: number }) =>
                    `${x.reason} (${nf(x.n)})`,
                )
                .join(", ")}
            </p>
          {/if}
          {#if b.samples?.adds?.length}
            <details>
              <summary>Examples that would gain it</summary>
              <ul class="plain">
                {#each b.samples.adds as s (s.code)}<li>
                    {s.name ?? s.code}{#if s.evidence?.sentence}<br /><span
                        class="muted">“{s.evidence.sentence}”</span
                      >{/if}
                  </li>{/each}
              </ul>
            </details>
          {/if}
          {#if b.samples?.removes?.length}
            <details>
              <summary>Examples that would lose it</summary>
              <ul class="plain">
                {#each b.samples.removes as s (s.code)}<li>
                    {s.name ?? s.code} <span class="muted">— {s.reason}</span>
                  </li>{/each}
              </ul>
            </details>
          {/if}
        {:else if r.kind === "benchmark"}
          <p>
            Switch took {b.totalMs != null
              ? `${(b.totalMs / 1000).toFixed(2)} s`
              : "—"} (budget
            {b.budgetMs != null ? `${b.budgetMs / 1000} s` : "—"}) · {nf(
              b.driftStates,
            )} results recomputed ·
            {b.walBytes != null
              ? `${(b.walBytes / 1_048_576).toFixed(1)} MB`
              : "—"} written to the log. Dry run: nothing changed.
          </p>
        {/if}
      </div>
    {:else}
      <p class="muted">No reports yet.</p>
    {/each}
  </section>

  <section class="card" aria-labelledby="history-heading">
    <h2 id="history-heading">History</h2>
    <ul class="plain">
      {#each d.history as h (h.id)}
        <li>
          {ACTION_LABEL[h.action] ?? h.action}{h.revisionId
            ? ` revision ${h.revisionId}`
            : ""} · {fmtWhen(h.at)}{h.by ? ` · ${h.by}` : ""}
        </li>
      {:else}
        <li class="muted">
          Never activated. This tag has always come from the earlier AI
          annotations.
        </li>
      {/each}
    </ul>
  </section>
</div>

{#if confirming}
  <div
    class="modal-overlay"
    role="dialog"
    aria-modal="true"
    aria-labelledby="confirm-title"
    tabindex="-1"
    onkeydown={onModalKey}
  >
    <div class="modal" bind:this={confirmModal}>
      <h3 id="confirm-title">{confirming.title}</h3>
      <p>{confirming.body}</p>
      <form
        method="POST"
        action="?/{confirming.action}"
        use:enhance={submitting}
      >
        {#if confirming.revisionId}<input
            type="hidden"
            name="revisionId"
            value={confirming.revisionId}
          />{/if}
        {#if confirming.proposalId}<input
            type="hidden"
            name="proposalId"
            value={confirming.proposalId}
          />{/if}
        <label for="confirm-input"
          >Type <strong>{d.tag}</strong> to confirm</label
        >
        <input
          id="confirm-input"
          name="confirm"
          bind:this={confirmInput}
          bind:value={typed}
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
        />
        <div class="buttons">
          <button type="button" class="secondary" onclick={closeConfirm}
            >Cancel</button
          >
          <button type="submit" disabled={busy || typed.trim() !== d.tag}
            >{busy ? "Working…" : "Confirm"}</button
          >
        </div>
      </form>
    </div>
  </div>
{/if}

<style>
  .page {
    max-width: 960px;
    margin: 0 auto;
    padding: 16px;
  }
  .back a {
    display: inline-flex;
    align-items: center;
    min-height: 48px;
    color: var(--accent);
  }
  h1 {
    font-size: 1.35rem;
    margin: 0 0 8px;
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    align-items: center;
    overflow-wrap: anywhere;
  }
  .card {
    padding: 1rem;
    margin-block: 1rem;
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 8px;
  }
  .card h2 {
    font-size: 1.1rem;
    margin: 0 0 0.75rem;
  }
  .card h3 {
    font-size: 0.95rem;
    margin: 0.9rem 0 0.3rem;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  }
  .card p {
    margin: 0.5rem 0;
    line-height: 1.5;
  }
  .revision {
    border-top: 1px solid var(--border);
    padding-top: 0.4rem;
    margin-top: 0.6rem;
  }
  .revision:first-of-type {
    border-top: none;
  }
  details summary {
    min-height: 48px;
    display: flex;
    align-items: center;
    cursor: pointer;
    color: var(--accent);
  }
  .buttons {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    margin: 0.6rem 0;
  }
  .danger-zone {
    border-top: 1px solid var(--border);
    padding-top: 0.8rem;
  }
  button {
    min-height: 48px;
    padding: 10px 16px;
    font-size: 1rem;
    font-weight: 600;
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
  }
  .fail {
    color: var(--danger);
  }
  .plain {
    list-style: none;
    padding: 0;
    margin: 0;
  }
  .plain li {
    padding: 8px 0;
    border-bottom: 1px solid var(--border);
    overflow-wrap: anywhere;
    line-height: 1.5;
  }
  .plain li a {
    color: var(--accent);
  }
  .crosscheck {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    background: var(--bg);
    border-radius: 6px;
    padding: 8px 10px;
  }
  blockquote {
    margin: 6px 0;
    padding-left: 10px;
    border-left: 3px solid var(--border);
  }
  cite {
    color: var(--muted);
    font-style: normal;
  }
  .why label {
    display: block;
    margin-bottom: 4px;
  }
  .why .row {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .why input,
  .modal input {
    min-height: 48px;
    font-size: 16px;
    flex: 1 1 220px;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--card);
    color: var(--text);
    width: 100%;
    box-sizing: border-box;
  }
  .notice {
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
  .modal-overlay {
    position: fixed;
    inset: 0;
    z-index: 2000;
    background: rgba(33, 37, 41, 0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
  }
  .modal {
    background: var(--card);
    border-radius: 8px;
    padding: 24px;
    max-width: 460px;
    width: 100%;
  }
  .modal label {
    display: block;
    margin: 0.8rem 0 4px;
    overflow-wrap: anywhere;
  }
</style>
