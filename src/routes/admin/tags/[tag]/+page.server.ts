import { error, fail } from "@sveltejs/kit";
import type { Actions, PageServerLoad } from "./$types";
import { ALL_TAGS } from "$lib/species-tags";
import { query } from "$lib/db";
import {
  activationReadiness,
  approveProposal,
  enqueueEvalJob,
  enqueueFamilyRefs,
  enqueuePreview,
  enqueueTagDraft,
  enqueueTagOp,
  evalSetsFor,
  latestDesigns,
  rejectProposal,
  tagDetail,
  tagWhy,
} from "$server/tag-admin";
import { dedupKeys } from "$server/job-policy";
import { DEFAULT_MODEL_IDS, resolveModel } from "$server/ai-models";
import { CONFIG_KEYS, getConfig } from "$server/app-config";
import { draftableTag } from "$server/tag-draft-job";
import { familyReferenceStatus } from "$server/tag-family-refs";
import { PROPOSED_GATES } from "$server/tag-engine/eval-stats";
import {
  OUTDATED_SET_MESSAGE,
  designHash,
  evalTextOutdated,
  tagEvalDesign,
} from "$server/tag-engine/eval-design";
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
  const [evalSets, designs, draftCfg, familyRefs] = await Promise.all([
    evalSetsFor(tag),
    latestDesigns(tag),
    getConfig(CONFIG_KEYS.tagDraftModel, {
      provider: "anthropic",
      model: DEFAULT_MODEL_IDS.tagDraft,
    }),
    familyReferenceStatus(),
  ]);
  return {
    detail,
    readiness,
    whyQuery: why ?? "",
    why: why ? await tagWhy(tag, why) : null,
    draftable: draftableTag(tag),
    // Shown next to the Draft button; chosen in Admin → Model choice → Tag rules.
    draftModel: resolveModel(draftCfg, DEFAULT_MODEL_IDS.tagDraft).label,
    evalSets,
    designs,
    // A design report made under another question or page format can't start
    // a blind test (the job refuses it); the page offers "Design" again instead.
    currentDesignHash: tagEvalDesign(tag) ? designHash(tag) : null,
    familyRefs,
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
    : `Queued the ${what} (job #${r.jobId}). Its progress shows under Recent work; this page updates itself.`,
});

const setOf = async (tag: string, raw: FormDataEntryValue | null) => {
  const id = String(raw ?? "");
  if (!/^[1-9][0-9]{0,18}$/.test(id)) return null;
  const r = await query<{
    status: string;
    revision_id: string;
    text_version: string | null;
  }>(
    "SELECT status, revision_id::text, design->>'evalTextVersion' AS text_version FROM tag_eval_set WHERE id = $1 AND tag = $2",
    [id, tag],
  );
  const row = r.rows[0];
  return row
    ? {
        id,
        status: row.status,
        revision_id: row.revision_id,
        // Its pages were rendered by an older text version: no more answers.
        outdated: row.status === "labelling" && evalTextOutdated(row.text_version),
      }
    : null;
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
    if (design.body.designHash !== (tagEvalDesign(g.tag) ? designHash(g.tag) : null))
      return bad(
        "op",
        409,
        "The blind-test question or page format changed since the latest design. Press Design blind test again first.",
      );
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
        // tag rides along only so the job shows in the page's Recent work.
        { setId: set.id, tag: g.tag },
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
        // tag rides along only so the job shows in the page's Recent work.
        { setId: set.id, tag: g.tag },
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

  // Whole-taxon confirmation (0075): answer Yes, once, for every unanswered
  // page of a labelling set from taxa the revision lists whole.
  confirmTaxa: async ({ locals, params, request }) => {
    const g = await guard(locals, params, "op");
    if ("err" in g) return g.err;
    const form = await request.formData();
    const set = await setOf(g.tag, form.get("setId"));
    if (!set) return bad("op", 404, "Unknown blind-test set.");
    if (set.outdated) return bad("op", 409, OUTDATED_SET_MESSAGE);
    if (!confirmed(form, g.tag))
      return bad("op", 400, `Type ${g.tag} to confirm.`);
    const picked = [...new Set(form.getAll("taxon").map(String))];
    if (
      picked.length === 0 ||
      picked.length > 50 ||
      !picked.every((t) => /^(order|family|genus):[A-Za-z]+$/.test(t))
    )
      return bad("op", 400, "Tick at least one family or genus.");
    const taxa = picked.map((t) => {
      const [rank, value] = t.split(":");
      return { rank, value };
    });
    try {
      const n =
        (
          await query<{ n: number }>(
            "SELECT public.confirm_tag_eval_taxa($1, $2, $3::jsonb) AS n",
            [set.id, g.user.id, JSON.stringify(taxa)],
          )
        ).rows[0]?.n ?? 0;
      return {
        kind: "op" as const,
        ok: true as const,
        message: `Answered Yes for ${n} page${n === 1 ? "" : "s"} from your family confirmation.`,
      };
    } catch (e) {
      return bad(
        "op",
        409,
        e instanceof Error
          ? e.message.replace(/^confirm: /, "Not recorded: ")
          : "Not recorded.",
      );
    }
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
    if (!ready.benchmarkReportId)
      return bad("op", 409, "This revision needs a passing switch benchmark first.");
    // Rules below the blind-test mark can still be used if the owner says so
    // (0078), unless it tags a must-not bird; the definer re-checks.
    let gateReportId = ready.gateReportId;
    let acceptFailedGate = false;
    if (!gateReportId) {
      if (!ready.acceptableGate)
        return bad("op", 409, "This revision needs a passing gate report first.");
      if (form.get("acceptFailedGate") !== "yes")
        return bad(
          "op",
          400,
          "These rules are below the blind-test mark. Tick the box to use them anyway.",
        );
      gateReportId = ready.acceptableGate.reportId;
      acceptFailedGate = true;
    }
    return queued(
      "activation",
      await enqueueTagOp(
        "tag_activate",
        {
          tag: g.tag,
          revisionId,
          gateReportId,
          benchmarkReportId: ready.benchmarkReportId,
          ...(acceptFailedGate ? { acceptFailedGate: true as const } : {}),
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

  preview: async ({ locals, params, request }) => {
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
    return queued(
      "preview",
      await enqueuePreview(g.tag, proposalId, g.user.id),
    );
  },

  familyRefs: async ({ locals, params }) => {
    const g = await guard(locals, params, "op");
    if ("err" in g) return g.err;
    return queued("family-article fetch", await enqueueFamilyRefs(g.user.id));
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
