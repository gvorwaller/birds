import { error, fail } from "@sveltejs/kit";
import type { Actions, PageServerLoad } from "./$types";
import { ALL_TAGS } from "$lib/species-tags";
import { query } from "$lib/db";
import {
  activationReadiness,
  approveProposal,
  enqueueEvalJob,
  enqueueTagDraft,
  enqueueTagOp,
  evalSetsFor,
  latestDesigns,
  rejectProposal,
  tagDetail,
  tagWhy,
} from "$server/tag-admin";
import { dedupKeys } from "$server/job-policy";
import { draftableTag } from "$server/tag-draft-job";
import { PROPOSED_GATES } from "$server/tag-engine/eval-stats";
import { OWNER_LABEL_BUDGET } from "$server/tag-eval-jobs";

/**
 * One tag in the admin Tags tab (td-894144 Release B3; plan "Admin Tags tab"
 * §2–§6). 404 for non-admins, like /admin. Every action re-checks the role,
 * re-derives preconditions on the server (never trusts ids the page sent for
 * reports), and requires the typed tag name for anything that changes what
 * users see.
 */
export const load: PageServerLoad = async ({ locals, params, url }) => {
  if (locals.user?.role !== "admin") throw error(404, "Not found");
  const tag = params.tag;
  const detail = await tagDetail(tag);
  if (!detail) throw error(404, "Not found");
  const why = url.searchParams.get("why");
  const readiness = await Promise.all(
    detail.revisions.map(async (r) => ({
      revisionId: r.id,
      ...(await activationReadiness(tag, r.id)),
    })),
  );
  const [evalSets, designs] = await Promise.all([
    evalSetsFor(tag),
    latestDesigns(tag),
  ]);
  return {
    detail,
    readiness,
    whyQuery: why ?? "",
    why: why ? await tagWhy(tag, why) : null,
    draftable: draftableTag(tag),
    evalSets,
    designs,
    proposedGates: PROPOSED_GATES,
    labelBudget: OWNER_LABEL_BUDGET,
  };
};

type Kind = "op" | "proposal";
const bad = (kind: Kind, status: number, message: string) =>
  fail(status, { kind, ok: false as const, message });

async function guard(locals: App.Locals, params: { tag: string }, kind: Kind) {
  if (locals.user?.role !== "admin" || !locals.user)
    return { err: bad(kind, 403, "Admins only.") };
  if (!ALL_TAGS.has(params.tag)) return { err: bad(kind, 404, "Unknown tag.") };
  return { user: locals.user, tag: params.tag };
}

async function revisionOf(
  tag: string,
  raw: FormDataEntryValue | null,
): Promise<string | null> {
  const id = String(raw ?? "");
  if (!/^[1-9][0-9]{0,18}$/.test(id)) return null;
  const r = await query(
    "SELECT 1 FROM tag_revision WHERE id = $1 AND tag = $2",
    [id, tag],
  );
  return r.rows.length ? id : null;
}

const confirmed = (form: FormData, tag: string) =>
  String(form.get("confirm") ?? "").trim() === tag;
const isUuid = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );

const queued = (what: string, r: { jobId: number; deduped: boolean }) => ({
  kind: "op" as const,
  ok: true as const,
  message: r.deduped
    ? `The ${what} is already queued (job #${r.jobId}).`
    : `Queued the ${what} (job #${r.jobId}). Refresh to see the result.`,
});

const setOf = async (tag: string, raw: FormDataEntryValue | null) => {
  const id = String(raw ?? "");
  if (!/^[1-9][0-9]{0,18}$/.test(id)) return null;
  const r = await query<{ status: string; revision_id: string }>(
    "SELECT status, revision_id::text FROM tag_eval_set WHERE id = $1 AND tag = $2",
    [id, tag],
  );
  return r.rows[0] ? { id, ...r.rows[0] } : null;
};

export const actions: Actions = {
  draft: async ({ locals, params }) => {
    const g = await guard(locals, params, "op");
    if ("err" in g) return g.err;
    if (!draftableTag(g.tag))
      return bad(
        "op",
        409,
        "This tag has no definition or evaluation design yet.",
      );
    return queued("AI draft", await enqueueTagDraft(g.tag, g.user.id));
  },

  design: async ({ locals, params, request }) => {
    const g = await guard(locals, params, "op");
    if ("err" in g) return g.err;
    const revisionId = await revisionOf(
      g.tag,
      (await request.formData()).get("revisionId"),
    );
    if (!revisionId)
      return bad("op", 400, "Choose an approved revision of this tag.");
    return queued(
      "blind-test design",
      await enqueueEvalJob(
        "tag_design_simulation",
        { tag: g.tag, revisionId },
        dedupKeys.tagDesign(g.tag, revisionId),
        `${g.tag} — blind-test design`,
        g.user.id,
      ),
    );
  },

  evalCreate: async ({ locals, params, request }) => {
    const g = await guard(locals, params, "op");
    if ("err" in g) return g.err;
    const form = await request.formData();
    const revisionId = await revisionOf(g.tag, form.get("revisionId"));
    if (!revisionId)
      return bad("op", 400, "Choose an approved revision of this tag.");
    if (!confirmed(form, g.tag))
      return bad("op", 400, `Type ${g.tag} to confirm.`);
    const design = (await latestDesigns(g.tag))[revisionId];
    if (!design) return bad("op", 409, "Run the blind-test design first.");
    const over = design.body.needsOwnerDecision === true;
    if (over && form.get("acceptOverBudget") !== "yes")
      return bad(
        "op",
        400,
        `This design needs ${design.body.total} labels. Tick the box to accept.`,
      );
    return queued(
      "blind-test sample",
      await enqueueEvalJob(
        "tag_eval_create",
        {
          tag: g.tag,
          revisionId,
          simulationReportId: design.reportId,
          // The owner confirms exactly the proposed gates shown on the page.
          gates: PROPOSED_GATES,
          acceptOverBudget: over,
        },
        dedupKeys.tagEvalCreate(g.tag, revisionId),
        `${g.tag} — blind-test sample`,
        g.user.id,
      ),
    );
  },

  freeze: async ({ locals, params, request }) => {
    const g = await guard(locals, params, "op");
    if ("err" in g) return g.err;
    const form = await request.formData();
    const set = await setOf(g.tag, form.get("setId"));
    if (!set) return bad("op", 404, "Unknown blind-test set.");
    if (!confirmed(form, g.tag))
      return bad("op", 400, `Type ${g.tag} to confirm.`);
    try {
      await query("SELECT public.freeze_tag_eval_set($1, $2)", [
        set.id,
        g.user.id,
      ]);
    } catch (e) {
      return bad(
        "op",
        409,
        e instanceof Error
          ? e.message.replace(/^freeze: /, "Not frozen: ")
          : "Not frozen.",
      );
    }
    return queued(
      "gate report",
      await enqueueEvalJob(
        "tag_gate_report",
        { setId: set.id },
        dedupKeys.tagGate(set.id),
        `${g.tag} — gate report`,
        g.user.id,
      ),
    );
  },

  gate: async ({ locals, params, request }) => {
    const g = await guard(locals, params, "op");
    if ("err" in g) return g.err;
    const set = await setOf(g.tag, (await request.formData()).get("setId"));
    if (!set || set.status !== "frozen")
      return bad("op", 409, "Only a frozen blind test has a gate report.");
    return queued(
      "gate report",
      await enqueueEvalJob(
        "tag_gate_report",
        { setId: set.id },
        dedupKeys.tagGate(set.id),
        `${g.tag} — gate report`,
        g.user.id,
      ),
    );
  },

  abandon: async ({ locals, params, request }) => {
    const g = await guard(locals, params, "op");
    if ("err" in g) return g.err;
    const form = await request.formData();
    const set = await setOf(g.tag, form.get("setId"));
    if (!set) return bad("op", 404, "Unknown blind-test set.");
    if (!confirmed(form, g.tag))
      return bad("op", 400, `Type ${g.tag} to confirm.`);
    try {
      await query("SELECT public.abandon_tag_eval_set($1, $2)", [
        set.id,
        g.user.id,
      ]);
    } catch (e) {
      return bad("op", 409, e instanceof Error ? e.message : "Not abandoned.");
    }
    return {
      kind: "op" as const,
      ok: true as const,
      message: "Blind test abandoned.",
    };
  },

  stage: async ({ locals, params, request }) => {
    const g = await guard(locals, params, "op");
    if ("err" in g) return g.err;
    const revisionId = await revisionOf(
      g.tag,
      (await request.formData()).get("revisionId"),
    );
    if (!revisionId)
      return bad("op", 400, "Choose an approved revision of this tag.");
    return queued(
      "stage report",
      await enqueueTagOp("tag_stage", { tag: g.tag, revisionId }, g.user.id),
    );
  },

  benchmark: async ({ locals, params, request }) => {
    const g = await guard(locals, params, "op");
    if ("err" in g) return g.err;
    const revisionId = await revisionOf(
      g.tag,
      (await request.formData()).get("revisionId"),
    );
    if (!revisionId)
      return bad("op", 400, "Choose an approved revision of this tag.");
    return queued(
      "switch benchmark",
      await enqueueTagOp(
        "tag_benchmark",
        { tag: g.tag, revisionId },
        g.user.id,
      ),
    );
  },

  activate: async ({ locals, params, request }) => {
    const g = await guard(locals, params, "op");
    if ("err" in g) return g.err;
    const form = await request.formData();
    const revisionId = await revisionOf(g.tag, form.get("revisionId"));
    if (!revisionId)
      return bad("op", 400, "Choose an approved revision of this tag.");
    if (!confirmed(form, g.tag))
      return bad("op", 400, `Type ${g.tag} to confirm.`);
    const ready = await activationReadiness(g.tag, revisionId);
    if (!ready.gateReportId || !ready.benchmarkReportId)
      return bad(
        "op",
        409,
        "This revision needs a passing gate report and a passing benchmark first.",
      );
    return queued(
      "activation",
      await enqueueTagOp(
        "tag_activate",
        {
          tag: g.tag,
          revisionId,
          gateReportId: ready.gateReportId,
          benchmarkReportId: ready.benchmarkReportId,
        },
        g.user.id,
      ),
    );
  },

  rollback: async ({ locals, params, request }) => {
    const g = await guard(locals, params, "op");
    if ("err" in g) return g.err;
    if (!confirmed(await request.formData(), g.tag))
      return bad("op", 400, `Type ${g.tag} to confirm.`);
    return queued(
      "rollback",
      await enqueueTagOp("tag_rollback", { tag: g.tag }, g.user.id),
    );
  },

  retire: async ({ locals, params, request }) => {
    const g = await guard(locals, params, "op");
    if ("err" in g) return g.err;
    if (!confirmed(await request.formData(), g.tag))
      return bad("op", 400, `Type ${g.tag} to confirm.`);
    return queued(
      "retire to legacy",
      await enqueueTagOp("tag_retire", { tag: g.tag }, g.user.id),
    );
  },

  approve: async ({ locals, params, request }) => {
    const g = await guard(locals, params, "proposal");
    if ("err" in g) return g.err;
    const form = await request.formData();
    const proposalId = String(form.get("proposalId") ?? "");
    if (!isUuid(proposalId)) return bad("proposal", 400, "Unknown proposal.");
    if (!confirmed(form, g.tag))
      return bad("proposal", 400, `Type ${g.tag} to confirm.`);
    const owns = await query(
      "SELECT 1 FROM tag_rule_proposal WHERE id = $1 AND tag = $2",
      [proposalId, g.tag],
    );
    if (!owns.rows.length)
      return bad("proposal", 404, "That proposal is not for this tag.");
    try {
      const revisionId = await approveProposal(proposalId, g.user.id);
      return {
        kind: "proposal" as const,
        ok: true as const,
        message: `Approved as revision ${revisionId}.`,
      };
    } catch (e) {
      return bad(
        "proposal",
        409,
        e instanceof Error
          ? e.message.replace(/^approve: /, "Not approved: ")
          : "Not approved.",
      );
    }
  },

  reject: async ({ locals, params, request }) => {
    const g = await guard(locals, params, "proposal");
    if ("err" in g) return g.err;
    const proposalId = String(
      (await request.formData()).get("proposalId") ?? "",
    );
    if (!isUuid(proposalId)) return bad("proposal", 400, "Unknown proposal.");
    const owns = await query(
      "SELECT 1 FROM tag_rule_proposal WHERE id = $1 AND tag = $2",
      [proposalId, g.tag],
    );
    if (!owns.rows.length)
      return bad("proposal", 404, "That proposal is not for this tag.");
    try {
      await rejectProposal(proposalId, g.user.id);
      return {
        kind: "proposal" as const,
        ok: true as const,
        message: "Proposal rejected.",
      };
    } catch (e) {
      return bad(
        "proposal",
        409,
        e instanceof Error
          ? e.message.replace(/^reject: /, "Not rejected: ")
          : "Not rejected.",
      );
    }
  },
};
