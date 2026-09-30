/**
 * /admin/tags/[tag] B4 actions (plan rev 26): draft, design, start blind test
 * (typed name + explicit over-budget acceptance + the proposed gates only),
 * freeze → gate, abandon. Read models and the queue are mocked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

let setRow: unknown[] = [{ status: "labelling", revision_id: "3" }];
const sqlCalls: string[] = [];
vi.mock("$lib/db", () => ({
  query: async (text: string) => {
    sqlCalls.push(text);
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
    "3": { reportId: "41", body: { total: 120, needsOwnerDecision: false } },
  });
  setRow = [{ status: "labelling", revision_id: "3" }];
  draft.draftable = true;
  sqlCalls.length = 0;
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

  it("over the budget needs the explicit tick", async () => {
    m.latestDesigns.mockResolvedValue({
      "3": { reportId: "41", body: { total: 420, needsOwnerDecision: true } },
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
      { setId: "5" },
      "tag_gate:s5",
      expect.any(String),
      1,
    );
  });

  it("a gate report only for a frozen set; unknown sets 404", async () => {
    expect(fail(await call("gate", ADMIN, { setId: "5" })).status).toBe(409);
    setRow = [{ status: "frozen", revision_id: "3" }];
    expect(await call("gate", ADMIN, { setId: "5" })).toMatchObject({
      ok: true,
    });
    setRow = [];
    expect(
      fail(await call("abandon", ADMIN, { setId: "5", confirm: TAG })).status,
    ).toBe(404);
  });
});
