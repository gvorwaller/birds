/**
 * /admin/tags/[tag] B4 actions (plan rev 26): draft, design, start blind test
 * (typed name + explicit over-budget acceptance + the proposed gates only),
 * freeze → gate, abandon. Read models and the queue are mocked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EVAL_TEXT_VERSION, designHash } from "$server/tag-engine/eval-design";

const CURRENT = { status: "labelling", revision_id: "3", text_version: EVAL_TEXT_VERSION };
let setRow: unknown[] = [CURRENT];
const sqlCalls: string[] = [];
const sqlParams: unknown[][] = [];
vi.mock("$lib/db", () => ({
  query: async (text: string, params: unknown[] = []) => {
    sqlCalls.push(text);
    sqlParams.push(params);
    if (text.includes("confirm_tag_eval_taxa")) return { rows: [{ n: 61 }] };
    if (text.includes("FROM tag_revision")) return { rows: [{ ok: 1 }] };
    if (text.includes("FROM tag_eval_set")) return { rows: setRow };
    return { rows: [] };
  },
}));
const m = vi.hoisted(() => ({
  tagDetail: vi.fn(),
  tagWhy: vi.fn(),
  activationReadiness: vi.fn(),
  enqueueTagOp: vi.fn(),
  approveProposal: vi.fn(),
  rejectProposal: vi.fn(),
  enqueueEvalJob: vi.fn(),
  enqueueTagDraft: vi.fn(),
  evalSetsFor: vi.fn(),
  latestDesigns: vi.fn(),
}));
vi.mock("$server/tag-admin", () => m);
const draft = vi.hoisted(() => ({ draftable: true }));
vi.mock("$server/tag-draft-job", () => ({
  draftableTag: () => draft.draftable,
}));

import { actions } from "./+page.server";
import { PROPOSED_GATES } from "$server/tag-engine/eval-stats";

const TAG = "habitat:open-ocean";
const ADMIN = {
  locals: { user: { id: 1, role: "admin" } },
  params: { tag: TAG },
};
const VIEWER = {
  locals: { user: { id: 2, role: "viewer" } },
  params: { tag: TAG },
};
const req = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return new Request("http://localhost/admin/tags/x", {
    method: "POST",
    body: fd,
  });
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const call = (name: string, ev: object, fields: Record<string, string>) =>
  (actions as any)[name]({ ...ev, request: req(fields) });
const fail = (r: unknown) => r as { status: number; data: { message: string } };

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset();
  m.enqueueEvalJob.mockResolvedValue({ jobId: 9, deduped: false });
  m.enqueueTagDraft.mockResolvedValue({ jobId: 8, deduped: false });
  m.latestDesigns.mockResolvedValue({
    "3": {
      reportId: "41",
      body: { total: 120, needsOwnerDecision: false, designHash: designHash(TAG) },
    },
  });
  setRow = [CURRENT];
  draft.draftable = true;
  sqlCalls.length = 0;
  sqlParams.length = 0;
});

describe("blind-test actions", () => {
  it("every new action refuses non-admins", async () => {
    for (const name of [
      "draft",
      "design",
      "evalCreate",
      "freeze",
      "gate",
      "abandon",
      "confirmTaxa",
    ])
      expect(
        fail(
          await call(name, VIEWER, {
            revisionId: "3",
            setId: "5",
            confirm: TAG,
          }),
        ).status,
      ).toBe(403);
    expect(m.enqueueEvalJob).not.toHaveBeenCalled();
  });

  it("draft needs a draftable tag", async () => {
    draft.draftable = false;
    expect(fail(await call("draft", ADMIN, {})).status).toBe(409);
    draft.draftable = true;
    expect(await call("draft", ADMIN, {})).toMatchObject({ ok: true });
    expect(m.enqueueTagDraft).toHaveBeenCalledWith(TAG, 1);
  });

  it("start blind test: typed name, a design first, and ONLY the proposed gates are sent", async () => {
    expect(
      fail(
        await call("evalCreate", ADMIN, { revisionId: "3", confirm: "nope" }),
      ).status,
    ).toBe(400);
    m.latestDesigns.mockResolvedValueOnce({});
    expect(
      fail(await call("evalCreate", ADMIN, { revisionId: "3", confirm: TAG }))
        .status,
    ).toBe(409);
    await call("evalCreate", ADMIN, {
      revisionId: "3",
      confirm: TAG,
      gates: '{"version":1,"precision":{"point_min":0}}',
    });
    const [type, payload] = m.enqueueEvalJob.mock.calls[0];
    expect(type).toBe("tag_eval_create");
    expect(payload).toEqual({
      tag: TAG,
      revisionId: "3",
      simulationReportId: "41",
      gates: PROPOSED_GATES,
      acceptOverBudget: false,
    });
  });

  it("start blind test refuses a design made under another question or page format", async () => {
    m.latestDesigns.mockResolvedValue({
      "3": { reportId: "41", body: { total: 120, needsOwnerDecision: false, designHash: "0".repeat(64) } },
    });
    const r = fail(await call("evalCreate", ADMIN, { revisionId: "3", confirm: TAG }));
    expect(r.status).toBe(409);
    expect(r.data.message).toMatch(/Design blind test again/);
    expect(m.enqueueEvalJob).not.toHaveBeenCalled();
  });

  it("over the budget needs the explicit tick", async () => {
    m.latestDesigns.mockResolvedValue({
      "3": {
        reportId: "41",
        body: { total: 420, needsOwnerDecision: true, designHash: designHash(TAG) },
      },
    });
    const r = fail(
      await call("evalCreate", ADMIN, { revisionId: "3", confirm: TAG }),
    );
    expect(r.status).toBe(400);
    expect(r.data.message).toMatch(/420 labels/);
    expect(
      await call("evalCreate", ADMIN, {
        revisionId: "3",
        confirm: TAG,
        acceptOverBudget: "yes",
      }),
    ).toMatchObject({ ok: true });
    expect(m.enqueueEvalJob.mock.calls[0][1]).toMatchObject({
      acceptOverBudget: true,
    });
  });

  it("freeze needs the typed name, calls the definer, then queues the gate report", async () => {
    expect(
      fail(await call("freeze", ADMIN, { setId: "5", confirm: "x" })).status,
    ).toBe(400);
    expect(
      await call("freeze", ADMIN, { setId: "5", confirm: TAG }),
    ).toMatchObject({ ok: true });
    expect(sqlCalls.some((q) => q.includes("freeze_tag_eval_set"))).toBe(true);
    expect(m.enqueueEvalJob).toHaveBeenCalledWith(
      "tag_gate_report",
      { setId: "5", tag: TAG },
      "tag_gate:s5",
      expect.any(String),
      1,
    );
  });

  it("confirm whole families: typed name, well-formed ticked taxa, then the definer gets exactly those", async () => {
    const send = (fields: Record<string, string>, taxa: string[]) => {
      const fd = new FormData();
      for (const [k, v] of Object.entries(fields)) fd.append(k, v);
      for (const t of taxa) fd.append("taxon", t);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (actions as any).confirmTaxa({
        ...ADMIN,
        request: new Request("http://localhost/admin/tags/x", { method: "POST", body: fd }),
      });
    };
    expect(fail(await send({ setId: "5", confirm: "x" }, ["family:Procellariidae"])).status).toBe(400);
    expect(fail(await send({ setId: "5", confirm: TAG }, [])).status).toBe(400);
    expect(fail(await send({ setId: "5", confirm: TAG }, ["family:Procellariidae; DROP"])).status).toBe(400);
    expect(fail(await send({ setId: "5", confirm: TAG }, ["species:Procellariidae"])).status).toBe(400);
    expect(sqlCalls.some((q) => q.includes("confirm_tag_eval_taxa"))).toBe(false);
    const ok = await send({ setId: "5", confirm: TAG }, [
      "family:Procellariidae",
      "family:Diomedeidae",
      "family:Procellariidae",
    ]);
    expect(ok).toMatchObject({ ok: true, message: expect.stringContaining("61 pages") });
    const i = sqlCalls.findIndex((q) => q.includes("confirm_tag_eval_taxa"));
    expect(sqlParams[i]).toEqual([
      "5",
      1,
      JSON.stringify([
        { rank: "family", value: "Procellariidae" },
        { rank: "family", value: "Diomedeidae" },
      ]),
    ]);
    setRow = [];
    expect(fail(await send({ setId: "5", confirm: TAG }, ["family:Procellariidae"])).status).toBe(404);
  });

  it("a set made before the pages named the bird refuses family confirmations before the definer", async () => {
    for (const text_version of [null, "evaltext-v2"]) {
      setRow = [{ ...CURRENT, text_version }];
      const fd = new FormData();
      fd.append("setId", "5");
      fd.append("confirm", TAG);
      fd.append("taxon", "family:Procellariidae");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r = fail(await (actions as any).confirmTaxa({
        ...ADMIN,
        request: new Request("http://localhost/admin/tags/x", { method: "POST", body: fd }),
      }));
      expect(r.status).toBe(409);
      expect(r.data.message).toMatch(/before its pages named the bird/);
    }
    expect(sqlCalls.some((q) => q.includes("confirm_tag_eval_taxa"))).toBe(false);
    // It can still be abandoned.
    expect(await call("abandon", ADMIN, { setId: "5", confirm: TAG })).toMatchObject({ ok: true });
  });

  it("a gate report only for a frozen set; unknown sets 404", async () => {
    expect(fail(await call("gate", ADMIN, { setId: "5" })).status).toBe(409);
    setRow = [{ ...CURRENT, status: "frozen" }];
    expect(await call("gate", ADMIN, { setId: "5" })).toMatchObject({
      ok: true,
    });
    setRow = [];
    expect(
      fail(await call("abandon", ADMIN, { setId: "5", confirm: TAG })).status,
    ).toBe(404);
  });
});
