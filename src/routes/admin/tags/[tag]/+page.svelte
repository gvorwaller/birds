<script lang="ts">
  /**
   * Admin → Tags → one tag (td-894144 Release B3; plan "Admin Tags tab"
   * §2–§6). Rules, history, proposals, reports and the owner actions. Long
   * or lock-holding work runs as a worker job; while one is pending or
   * running the page reloads its data every few seconds.
   */
  import { enhance } from "$app/forms";
  import { invalidateAll } from "$app/navigation";
  import { tick } from "svelte";
  import AdminBadge from "$components/admin/AdminBadge.svelte";
  import PreviewView from "$components/admin/PreviewView.svelte";
  import RulesView from "$components/admin/RulesView.svelte";
  import type { ActionData, PageData } from "./$types";

  let { data, form }: { data: PageData; form: ActionData } = $props();
  /** A stored evidence item: text (sentence/section, maybe scopes) or taxon (plan §3e). */
  type EvidenceItem = {
    kind?: "taxon";
    sentence?: string;
    section?: string;
    scopes?: { rank: string; value: string }[];
    matchedRules?: { ruleId: string; rank: string; value: string }[];
  };
  const d = $derived(data.detail);

  type Confirm = {
    action: "activate" | "rollback" | "retire" | "approve" | "evalCreate" | "freeze" | "abandon" | "confirmTaxa";
    title: string;
    body: string;
    revisionId?: string;
    proposalId?: string;
    setId?: string;
    /** Plain-language gate lines the owner confirms (blind test start). */
    gates?: string[];
    /** Set when the design is over the owner's label budget: an explicit tick is required. */
    overBudget?: number;
    /** Whole-taxon confirmation: "rank:value" keys sent, and the lines shown. */
    taxa?: { key: string; line: string }[];
    /** Activate with a blind test that did not pass (0078): the line the owner ticks to accept it. */
    acceptGate?: string;
  };
  type Taxon = { rank: string; value: string; name: string | null; pages: number; unanswered: number };
  const taxonKey = (x: Taxon) => `${x.rank}:${x.value}`;
  const taxonLine = (x: Taxon) =>
    `${x.value}${x.name ? ` (${x.name})` : x.rank === "genus" ? " (genus)" : ""}: ${x.unanswered} page${x.unanswered === 1 ? "" : "s"}`;
  // Ticked taxa per blind test; only those that still have unanswered pages count.
  let picked = $state<Record<string, string[]>>({});
  const livePicks = (setId: string, taxa: Taxon[]) =>
    taxa.filter((x) => x.unanswered > 0 && (picked[setId] ?? []).includes(taxonKey(x)));
  function togglePick(setId: string, key: string, on: boolean) {
    const cur = picked[setId] ?? [];
    picked[setId] = on ? [...cur, key] : cur.filter((k) => k !== key);
  }
  let acceptOver = $state(false);
  let acceptGate = $state(false);
  const pct1 = (x: number | null | undefined) => (typeof x === "number" ? `${(x * 100).toFixed(1)}%` : "—");
  const pctOf = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0);
  const gateLines = (g: { precision: { point_min: number; lower_min: number }; retention: { lower_min: number }; named_cases_must_not: string[] }) => [
    `Of the birds the rules tag, at least ${Math.round(g.precision.point_min * 100)}% must be right, and even at the pessimistic end of the margin of error at least ${Math.round(g.precision.lower_min * 100)}%.`,
    `Of the birds the old AI tagged correctly, the rules must keep at least ${Math.round(g.retention.lower_min * 100)}% (pessimistic end of the margin of error).`,
    ...(g.named_cases_must_not.length ? [`These birds must NOT be tagged: ${g.named_cases_must_not.join(", ")}.`] : []),
    "“Unsure” answers count against the rules.",
  ];
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
    acceptOver = false;
    acceptGate = false;
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
  const draftActive = $derived(
    d.jobs.some(
      (j) =>
        j.type === "tag_draft_rules" &&
        (j.status === "pending" || j.status === "running"),
    ),
  );
  // Poll while work is in flight so the owner never has to refresh (the
  // buttons that start jobs sit far below the job list on a phone).
  $effect(() => {
    if (!jobActive || confirming) return;
    const t = setInterval(() => void invalidateAll(), 5000);
    return () => clearInterval(t);
  });
  let notice = $state<HTMLParagraphElement | null>(null);

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
    tag_draft_rules: "AI draft",
    tag_design_simulation: "Design blind test",
    tag_eval_create: "Start blind test",
    tag_gate_report: "Gate report",
    tag_preview: "Preview",
    tag_family_refs: "Family articles",
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
      // The result notice sits at the top of the page; bring it into view so
      // an action pressed far down the page visibly did something.
      await tick();
      if (notice) {
        notice.scrollIntoView({ behavior: "smooth", block: "start" });
        notice.focus({ preventScroll: true });
      }
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
    <p
      bind:this={notice}
      tabindex="-1"
      class={form.ok ? "notice" : "error"}
      role={form.ok ? "status" : "alert"}
    >
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
      {@const design = data.designs[r.id]}
        {@const db = design?.body as { total: number; needsOwnerDecision: boolean; designHash: string; N: Record<string, number>; n: Record<string, number> } | undefined}
        {@const designStale = !!db && db.designHash !== data.currentDesignHash}
        {@const liveSet = data.evalSets.find((s) => s.revisionId === r.id && s.status === "labelling")}
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
                !ready?.benchmarkReportId ||
                (!ready?.gateReportId && !ready?.acceptableGate)}
              onclick={(event) =>
                openConfirm(
                  {
                    action: "activate",
                    revisionId: r.id,
                    title: `Activate revision ${r.id}?`,
                    body: "Rules will decide this tag for every species from now on. Species the rules do not assign lose the tag.",
                    acceptGate:
                      !ready?.gateReportId && ready?.acceptableGate
                        ? `I accept that its blind test did not pass (the rules were right for ${pct1(ready.acceptableGate.precision.point)} of the birds they tag; the bar was ${Math.round(data.proposedGates.precision.point_min * 100)}%) and want them to decide this tag anyway.`
                        : undefined,
                  },
                  event.currentTarget,
                )}>Activate…</button
            >
          {/if}
        </div>
        <div class="buttons">
          <form method="POST" action="?/design" use:enhance={submitting}>
            <input type="hidden" name="revisionId" value={r.id} />
            <button type="submit" class="secondary" disabled={busy}>Design blind test</button>
          </form>
          {#if db && !liveSet && !designStale}
            <button
              type="button"
              disabled={busy}
              onclick={(event) =>
                openConfirm(
                  {
                    action: "evalCreate",
                    revisionId: r.id,
                    title: `Start a blind test of ${db.total} birds?`,
                    body: "A random sample is drawn and frozen. Each page names the bird and shows its article and its family's article; you answer one question per bird. Nothing on the page says what the rules or the old tags answered. These pass/fail rules are fixed for this test:",
                    gates: gateLines(data.proposedGates),
                    overBudget: db.needsOwnerDecision ? db.total : undefined,
                  },
                  event.currentTarget,
                )}>Start blind test…</button
            >
          {/if}
        </div>
        {#if db}
          <p class="muted">
            {#if designStale}
              The latest design was made before the blind-test question or page format changed. Press “Design blind
              test” again before starting a blind test.
            {:else}
              Latest design: {db.total} birds to label{db.needsOwnerDecision ? ` — more than your ${data.labelBudget}-label budget` : ""}.
            {/if}
            {#if liveSet}A blind test for this revision is already open below.{/if}
          </p>
        {/if}
        {#if d.owned?.revisionId !== r.id}
          {@const needs = [
            !ready?.gateReportId && !ready?.acceptableGate && "a passing gate report (the blind test)",
            !ready?.benchmarkReportId && "a passing switch benchmark",
          ].filter(Boolean)}
          {#if needs.length}
            <p class="muted">Activate needs {needs.join(" and ")}.</p>
          {/if}
          {#if !ready?.gateReportId && ready?.acceptableGate}
            <p class="muted">
              Its blind test did not pass: the rules were right for {pct1(ready.acceptableGate.precision.point)} of the
              birds they tag (the bar was {Math.round(data.proposedGates.precision.point_min * 100)}%), and none of the must-not birds is tagged. You can still activate it:
              the Activate dialog asks you to accept that result.
            </p>
          {/if}
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
      {#if jobActive}<p class="muted">This page updates itself every few seconds while work is running.</p>{/if}
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
              {@const ev = w.state.evidence as EvidenceItem[]}
              {#if ev[0]?.kind === "taxon"}
                Rules result: <strong>assigned</strong>, because its
                {ev[0].matchedRules
                  ?.map((r) => `${r.rank} ${r.value}`)
                  .join(" and ")} is listed.
              {:else}
                Rules result: <strong>assigned</strong>, because the article says:
                {#each ev as e, i (i)}<blockquote>
                    {e.sentence ?? ""}{#if e.section}<cite>
                        — {e.section}</cite
                      >{/if}{#if e.scopes?.length}<cite>
                        (counted for {e.scopes
                          .map((x) => `${x.rank} ${x.value}`)
                          .join(", ")})</cite
                      >{/if}
                  </blockquote>{/each}
              {/if}
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
            >{#if (s.evidence as EvidenceItem | null)?.kind === "taxon"}<br /><span
                class="muted"
                >Listed {(s.evidence as EvidenceItem).matchedRules
                  ?.map((r) => `${r.rank} ${r.value}`)
                  .join(", ")}</span
              >{:else if s.evidence?.sentence}<br /><span class="muted"
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

  <section class="card" aria-labelledby="blind-heading">
    <h2 id="blind-heading">Blind tests</h2>
    <div class="familyrefs">
      <p>
        Family articles: <strong>{data.familyRefs.ok}</strong> of
        {data.familyRefs.families} families have one.
        <span class="muted"
          >Each blind-test page shows the opening of the bird's family article
          from Wikipedia, so you can judge from both.</span
        >
      </p>
      {#if data.familyRefs.problems.length}
        <details>
          <summary
            >{data.familyRefs.problems.length} famil{data.familyRefs.problems
              .length === 1
              ? "y has"
              : "ies have"} none yet</summary
          >
          <ul class="plain">
            {#each data.familyRefs.problems as f (f.familyCode)}
              <li>
                {f.family} <span class="muted">— {f.status}{f.error ? `: ${f.error}` : ""}</span>
              </li>
            {/each}
          </ul>
        </details>
        <form method="POST" action="?/familyRefs" use:enhance={submitting}>
          <button type="submit" class="secondary" disabled={busy}
            >Fetch family articles</button
          >
        </form>
      {/if}
    </div>
    {#each data.evalSets as t (t.id)}
      <div class="revision">
        <h3>
          Blind test {t.id} · revision {t.revisionId}
          <AdminBadge
            tone={t.status === "frozen" ? "ok" : t.status === "abandoned" ? "neutral" : "warn"}
            label={t.status === "labelling" ? "Labelling" : t.status === "frozen" ? "Frozen" : "Abandoned"}
          />
          {#if t.lastGate}<AdminBadge tone={t.lastGate.passed ? "ok" : "error"} label={t.lastGate.passed ? "Gate passed" : "Gate failed"} />{/if}
        </h3>
        <p>
          {t.labelled} of {t.total} answered ({pctOf(t.labelled, t.total)}%){t.fromTaxa
            ? `, ${t.fromTaxa} of them by family confirmation`
            : ""}.
        </p>
        <p class="muted">
          By group: {Object.entries(t.perStratum).map(([h, v]) => `${h} ${v.labelled}/${v.n}`).join(" · ")}
        </p>
        {#if t.status === "labelling" && t.listedTaxa.some((x) => x.unanswered > 0)}
          {@const live = livePicks(t.id, t.listedTaxa)}
          <fieldset class="taxa">
            <legend>Confirm whole families</legend>
            <p class="muted">
              The rules tag these families and genera whole. Tick only the ones where every species is a bird of
              the open ocean by this test's question: each of their unanswered pages in this blind test is then
              answered Yes by that confirmation (the gate report counts these separately) and skipped when you
              label. Leave a family unticked if some of its species might not fit; you answer those pages one by
              one.
            </p>
            <ul>
              {#each t.listedTaxa.filter((x) => x.pages > 0) as x (taxonKey(x))}
                <li>
                  <label>
                    <input
                      type="checkbox"
                      value={taxonKey(x)}
                      disabled={busy || x.unanswered === 0}
                      checked={x.unanswered > 0 && (picked[t.id] ?? []).includes(taxonKey(x))}
                      onchange={(e) => togglePick(t.id, taxonKey(x), e.currentTarget.checked)}
                    />
                    <span>
                      {x.value}
                      <span class="muted"
                        >{x.name ? `(${x.name})` : x.rank === "genus" ? "(genus)" : ""} · {x.unanswered === 0
                          ? "all answered"
                          : `${x.unanswered} unanswered of ${x.pages}`}</span
                      >
                    </span>
                  </label>
                </li>
              {/each}
            </ul>
            <button
              type="button"
              disabled={busy || live.length === 0}
              onclick={(event) =>
                openConfirm(
                  {
                    action: "confirmTaxa",
                    setId: t.id,
                    title: "Answer Yes for these families?",
                    body: "Every unanswered page from these families in this blind test is answered Yes by this confirmation. It applies to this blind test only and can't be undone.",
                    taxa: live.map((x) => ({ key: taxonKey(x), line: taxonLine(x) })),
                  },
                  event.currentTarget,
                )}
              >Answer Yes for {live.length || "ticked"} famil{live.length === 1 ? "y" : "ies"}…</button
            >
          </fieldset>
        {/if}
        {#if t.status === "labelling" && t.outdated && t.labelled < t.total}
          <p class="notice" role="note">
            Made before the pages named the bird, so it takes no more answers. Abandon it, then press “Design blind
            test” and “Start blind test…” for a new one. Confirming whole families there takes one click again.
          </p>
        {/if}
        <div class="buttons">
          {#if t.status === "labelling"}
            {#if t.labelled < t.total && !t.outdated}
              <a class="button-link" href="/admin/tags/{encodeURIComponent(d.tag)}/label/{t.id}">Label ({t.total - t.labelled} left)</a>
            {:else if t.labelled < t.total}
              <!-- Outdated: only Abandon (the note above says why). -->
            {:else}
              <button
                type="button"
                disabled={busy}
                onclick={(event) =>
                  openConfirm(
                    {
                      action: "freeze",
                      setId: t.id,
                      title: "Freeze this blind test?",
                      body: "Answers are locked and the gate report is computed. You can't add or change answers afterwards.",
                    },
                    event.currentTarget,
                  )}>Freeze and compute gate…</button
              >
            {/if}
            <button
              type="button"
              class="secondary"
              disabled={busy}
              onclick={(event) =>
                openConfirm(
                  {
                    action: "abandon",
                    setId: t.id,
                    title: "Abandon this blind test?",
                    body: t.outdated
                      ? "It stays in the history but can never gate an activation. Its pages hid the bird's name, so a new blind test asks about every bird again."
                      : "It stays in the history but can never gate an activation. A later blind test reuses your answer for any page it shows unchanged; family confirmations count for this blind test only.",
                  },
                  event.currentTarget,
                )}>Abandon…</button
            >
          {:else if t.status === "frozen"}
            <form method="POST" action="?/gate" use:enhance={submitting}>
              <input type="hidden" name="setId" value={t.id} />
              <button type="submit" class="secondary" disabled={busy}>Recompute gate report</button>
            </form>
          {/if}
        </div>
      </div>
    {:else}
      <p class="muted">No blind tests yet. Approve a revision, run its stage report, then "Design blind test".</p>
    {/each}
  </section>

  <section class="card" aria-labelledby="proposals-heading">
    <h2 id="proposals-heading">Proposals</h2>
    {#if data.draftable}
      <form method="POST" action="?/draft" use:enhance={submitting}>
        <button type="submit" disabled={busy || draftActive}>{draftActive ? "Drafting…" : "Draft rules with AI"}</button>
        <span class="muted">
          {#if draftActive}
            {data.draftModel} is drafting. It can take several minutes; the new proposal appears below when it's done.
          {:else}
            Uses {data.draftModel} (change it in Admin → Model choice → Tag rules). The draft is only a proposal; a cross-check and your approval come next.
          {/if}
        </span>
      </form>
    {/if}
    <p class="muted">
      Drafts of rules, from AI or by hand. A draft can only be approved after an
      independent cross-check approved exactly this text.
    </p>
    {#each d.proposals as p (p.id)}
      {@const open = p.status === "proposed" || p.status === "crosschecked"}
      {@const approvable =
        open &&
        p.crosscheck?.verdict === "approve" &&
        p.crosscheck.matches &&
        (p.schemaVersion === 1 || p.crosscheck.previewCurrent)}
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
          {#if p.schemaVersion === 2}<AdminBadge label="Family lists" />{/if}
        </h3>
        <details>
          <summary>Show rules</summary>
          <RulesView artifact={p.artifact} />
        </details>
        {#if p.preview}
          <PreviewView preview={p.preview} />
        {:else if open}
          <p class="muted">
            No Preview yet. Preview shows what these rules would do to every
            species before anyone reviews them{p.schemaVersion === 2
              ? " — required before the cross-check"
              : ""}.
          </p>
        {/if}
        {#if open}
          <form method="POST" action="?/preview" use:enhance={submitting}>
            <input type="hidden" name="proposalId" value={p.id} />
            <button type="submit" class="secondary" disabled={busy}
              >{p.preview?.current ? "Preview again" : "Preview"}</button
            >
            <span class="muted">Takes about a minute; no AI, no cost.</span>
          </form>
        {/if}
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
              />{:else if p.schemaVersion === 2 && !p.crosscheck.previewCurrent}<AdminBadge
                tone="warn"
                label="Reviewed an older Preview"
              />{/if}
          </p>
          <p class="crosscheck">{p.crosscheck.text}</p>
        {:else}
          <p class="muted">Not cross-checked yet.</p>
        {/if}
        {#if open && !approvable && p.crosscheck?.verdict === "approve" && p.schemaVersion === 2 && !p.crosscheck.previewCurrent}
          <p class="muted">
            The species data changed after the cross-check. Run Preview again;
            a new cross-check of the new Preview is needed before you can
            approve.
          </p>
        {/if}
        {#if open}
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
                    {s.name ?? s.code}{#if (s.evidence as EvidenceItem | null)?.kind === "taxon"}<br /><span
                        class="muted"
                        >Listed {(s.evidence as EvidenceItem).matchedRules
                          ?.map((r) => `${r.rank} ${r.value}`)
                          .join(", ")}</span
                      >{:else if s.evidence?.sentence}<br /><span
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
        {:else if r.kind === "simulation"}
          <p>
            {b.total} birds to label{b.needsOwnerDecision ? ` (over the ${data.labelBudget}-label budget — needs your confirmation)` : ""},
            from {Object.values((b.N ?? {}) as Record<string, number>).reduce((a, x) => a + x, 0)} birds the rules or the old AI tag.
          </p>
          <p class="muted">
            By group (sampled / total): {Object.keys((b.N ?? {}) as object).map((h) => `${h} ${(b.n as Record<string, number>)[h]}/${(b.N as Record<string, number>)[h]}`).join(" · ")}
          </p>
        {:else if r.kind === "gate"}
          {@const pr = b.precision as { point: number | null; lower: number | null }}
          {@const rt = b.retention as { point: number | null; lower: number | null; note: string | null }}
          <p>
            Precision {pr.point != null ? `${(pr.point * 100).toFixed(1)}%` : "—"} (at least {pr.lower != null ? `${(pr.lower * 100).toFixed(1)}%` : "—"}).
            {#if rt.lower != null}
              Keeps {rt.point != null ? `${(rt.point * 100).toFixed(1)}%` : "all"} of the old AI's correct tags (at least {(rt.lower * 100).toFixed(1)}%).
            {:else}
              The old AI had no correct tags among these birds, so there is nothing to keep.
            {/if}
          </p>
          {#if b.labelBasis}
            {@const basis = Object.entries(b.labelBasis as Record<string, number>)}
            {@const byTaxa = basis.filter(([k]) => k.startsWith("taxon:"))}
            <p class="muted">
              Answers: {nf((b.labelBasis as Record<string, number>).page ?? 0)} on their pages{byTaxa.length
                ? `; ${nf(byTaxa.reduce((a, [, n]) => a + n, 0))} by family confirmation (${byTaxa
                    .map(([k, n]) => `${k.split(":").at(-1)} ${n}`)
                    .join(", ")})`
                : ""}.
            </p>
          {/if}
          {#if (b.namedCases as unknown[])?.length}
            <ul class="plain">
              {#each b.namedCases as { code: string; name: string; expect: string; assigned: boolean; gating: boolean }[] as c (c.code)}
                <li>
                  {c.name}: rules {c.assigned ? "tag it" : "don't tag it"}
                  {#if c.gating}<AdminBadge tone={c.assigned ? "error" : "ok"} label={c.assigned ? "Must not — fails" : "Must not — ok"} />{:else}<span class="muted">(expected {c.expect})</span>{/if}
                </li>
              {/each}
            </ul>
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
        {#if confirming.setId}<input type="hidden" name="setId" value={confirming.setId} />{/if}
        {#if confirming.gates}
          <ul class="gates">
            {#each confirming.gates as line, i (i)}<li>{line}</li>{/each}
          </ul>
        {/if}
        {#if confirming.taxa}
          {#each confirming.taxa as x (x.key)}<input type="hidden" name="taxon" value={x.key} />{/each}
          <ul class="gates">
            {#each confirming.taxa as x (x.key)}<li>{x.line}</li>{/each}
          </ul>
        {/if}
        {#if confirming.overBudget}
          <label class="accept">
            <input type="checkbox" name="acceptOverBudget" value="yes" bind:checked={acceptOver} />
            I accept labelling {confirming.overBudget} birds (more than {data.labelBudget}).
          </label>
        {/if}
        {#if confirming.acceptGate}
          <label class="accept">
            <input type="checkbox" name="acceptFailedGate" value="yes" bind:checked={acceptGate} />
            {confirming.acceptGate}
          </label>
        {/if}
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
          <button type="submit" disabled={busy || typed.trim() !== d.tag || (!!confirming.overBudget && !acceptOver) || (!!confirming.acceptGate && !acceptGate)}
            >{busy ? "Working…" : "Confirm"}</button
          >
        </div>
      </form>
    </div>
  </div>
{/if}

<style>
  .button-link {
    display: inline-flex;
    align-items: center;
    min-height: 48px;
    padding: 10px 16px;
    font-size: 1rem;
    font-weight: 600;
    border-radius: 8px;
    background: var(--accent);
    color: var(--on-accent);
    text-decoration: none;
  }
  .gates {
    margin: 0.5rem 0;
    padding-left: 1.2rem;
    line-height: 1.5;
  }
  .accept {
    display: flex;
    gap: 10px;
    align-items: center;
    min-height: 48px;
    margin: 0.4rem 0;
  }
  .accept input {
    width: 24px;
    height: 24px;
    min-height: 0;
    flex: none;
  }
  .taxa {
    margin: 0.6rem 0;
    padding: 0.6rem 0.8rem;
    border: 1px solid var(--border);
    border-radius: 8px;
  }
  .taxa legend {
    font-weight: 600;
    padding: 0 0.3rem;
  }
  .taxa ul {
    list-style: none;
    margin: 0.4rem 0 0.6rem;
    padding: 0;
  }
  .taxa label {
    display: flex;
    gap: 10px;
    align-items: center;
    min-height: 48px;
    overflow-wrap: anywhere;
  }
  .taxa input {
    width: 24px;
    height: 24px;
    min-height: 0;
    flex: none;
  }
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
  .familyrefs {
    margin-bottom: 0.75rem;
  }
  .familyrefs details {
    margin-block: 0.4rem;
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
