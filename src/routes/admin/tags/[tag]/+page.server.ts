import { error, fail } from "@sveltejs/kit";
import type { Actions, PageServerLoad } from "./$types";
import { ALL_TAGS } from "$lib/species-tags";
import { query } from "$lib/db";
import {
  activationReadiness,
  approveProposal,
  enqueueTagOp,
  rejectProposal,
  tagDetail,
  tagWhy,
} from "$server/tag-admin";

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
  return {
    detail,
    readiness,
    whyQuery: why ?? "",
    why: why ? await tagWhy(tag, why) : null,
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

export const actions: Actions = {
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
