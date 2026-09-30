/**
 * /admin/tags/[tag] (td-894144 Release B3): auth, typed confirmation, and
 * server-derived preconditions for every owner action. Read models and the
 * job queue are mocked — the SQL behind them is proven by the tag-engine DB
 * suites.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

let revisionRows: unknown[] = [{ ok: 1 }];
let proposalRows: unknown[] = [{ ok: 1 }];
vi.mock("$lib/db", () => ({
  query: async (text: string) => ({
    rows: text.includes("FROM tag_revision")
      ? revisionRows
      : text.includes("FROM tag_rule_proposal")
        ? proposalRows
        : [],
  }),
}));

const m = vi.hoisted(() => ({
  tagDetail: vi.fn(),
  tagWhy: vi.fn(),
  activationReadiness: vi.fn(),
  enqueueTagOp: vi.fn(),
  approveProposal: vi.fn(),
  rejectProposal: vi.fn(),
  enqueuePreview: vi.fn(),
  enqueueFamilyRefs: vi.fn(),
}));
vi.mock("$server/tag-admin", () => m);

import { actions, load } from "./+page.server";

const TAG = "habitat:open-ocean";
const ADMIN = {
  locals: { user: { id: 1, role: "admin" } },
  params: { tag: TAG },
};
const VIEWER = {
  locals: { user: { id: 2, role: "viewer" } },
  params: { tag: TAG },
};
const PROPOSAL = "0b8f2a4e-1c1d-4c55-9a7e-2f1f7b0d9e11";
const req = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return new Request("http://localhost/admin/tags/x", {
    method: "POST",
    body: fd,
  });
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const call = (
  name: keyof typeof actions,
  ev: object,
  fields: Record<string, string>,
) => (actions[name] as any)({ ...ev, request: req(fields) });
const failure = (r: unknown) =>
  r as { status: number; data: { ok: boolean; message: string } };

beforeEach(() => {
  revisionRows = [{ ok: 1 }];
  proposalRows = [{ ok: 1 }];
  for (const f of Object.values(m)) f.mockReset();
  m.enqueueTagOp.mockResolvedValue({ jobId: 42, deduped: false });
  m.activationReadiness.mockResolvedValue({
    gateReportId: "7",
    benchmarkReportId: "8",
  });
});

describe("load", () => {
  it("404s for non-admins and unknown tags", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(
      (load as any)({ ...VIEWER, url: new URL("http://x/") }),
    ).rejects.toMatchObject({ status: 404 });
    m.tagDetail.mockResolvedValue(null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(
      (load as any)({ ...ADMIN, url: new URL("http://x/") }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("actions", () => {
  it("every action refuses non-admins", async () => {
    for (const name of [
      "stage",
      "benchmark",
      "activate",
      "rollback",
      "retire",
      "approve",
      "reject",
    ] as const) {
      expect(
        failure(
          await call(name, VIEWER, {
            revisionId: "3",
            confirm: TAG,
            proposalId: PROPOSAL,
          }),
        ).status,
      ).toBe(403);
    }
    expect(m.enqueueTagOp).not.toHaveBeenCalled();
    expect(m.approveProposal).not.toHaveBeenCalled();
    expect(m.rejectProposal).not.toHaveBeenCalled();
  });

  it("stage and benchmark need an approved revision OF THIS TAG", async () => {
    revisionRows = [];
    expect(
      failure(await call("stage", ADMIN, { revisionId: "3" })).status,
    ).toBe(400);
    expect(
      failure(await call("benchmark", ADMIN, { revisionId: "x" })).status,
    ).toBe(400);
    revisionRows = [{ ok: 1 }];
    expect(await call("stage", ADMIN, { revisionId: "3" })).toMatchObject({
      ok: true,
    });
    expect(m.enqueueTagOp).toHaveBeenCalledWith(
      "tag_stage",
      { tag: TAG, revisionId: "3" },
      1,
    );
  });

  it("activate: typed tag name required, and report ids come from the server, never the form", async () => {
    expect(
      failure(
        await call("activate", ADMIN, {
          revisionId: "3",
          confirm: "habitat:beach",
        }),
      ).status,
    ).toBe(400);
    m.activationReadiness.mockResolvedValueOnce({
      gateReportId: null,
      benchmarkReportId: "8",
    });
    expect(
      failure(await call("activate", ADMIN, { revisionId: "3", confirm: TAG }))
        .status,
    ).toBe(409);
    expect(m.enqueueTagOp).not.toHaveBeenCalled();
    await call("activate", ADMIN, {
      revisionId: "3",
      confirm: ` ${TAG} `,
      gateReportId: "999",
      benchmarkReportId: "999",
    });
    expect(m.enqueueTagOp).toHaveBeenCalledWith(
      "tag_activate",
      { tag: TAG, revisionId: "3", gateReportId: "7", benchmarkReportId: "8" },
      1,
    );
  });

  it("rollback and retire need the typed tag name", async () => {
    expect(failure(await call("rollback", ADMIN, { confirm: "" })).status).toBe(
      400,
    );
    expect(
      failure(await call("retire", ADMIN, { confirm: "open-ocean" })).status,
    ).toBe(400);
    expect(await call("retire", ADMIN, { confirm: TAG })).toMatchObject({
      ok: true,
    });
    expect(m.enqueueTagOp).toHaveBeenCalledWith("tag_retire", { tag: TAG }, 1);
  });

  it("approve: typed name, proposal must belong to this tag, definer refusals surface as 409", async () => {
    expect(
      failure(
        await call("approve", ADMIN, { proposalId: PROPOSAL, confirm: "nope" }),
      ).status,
    ).toBe(400);
    proposalRows = [];
    expect(
      failure(
        await call("approve", ADMIN, { proposalId: PROPOSAL, confirm: TAG }),
      ).status,
    ).toBe(404);
    proposalRows = [{ ok: 1 }];
    m.approveProposal.mockRejectedValueOnce(
      new Error("approve: no approving cross-check for this exact artifact"),
    );
    const refused = failure(
      await call("approve", ADMIN, { proposalId: PROPOSAL, confirm: TAG }),
    );
    expect(refused.status).toBe(409);
    expect(refused.data.message).toMatch(
      /^Not approved: no approving cross-check/,
    );
    m.approveProposal.mockResolvedValueOnce("12");
    expect(
      await call("approve", ADMIN, { proposalId: PROPOSAL, confirm: TAG }),
    ).toMatchObject({ ok: true, message: "Approved as revision 12." });
    expect(m.approveProposal).toHaveBeenLastCalledWith(PROPOSAL, 1);
  });

  it("reject: well-formed id for this tag only", async () => {
    expect(
      failure(await call("reject", ADMIN, { proposalId: "x" })).status,
    ).toBe(400);
    expect(
      failure(
        await call("reject", ADMIN, {
          proposalId: "------------------------------------",
        }),
      ).status,
    ).toBe(400);
    expect(proposalRows).toHaveLength(1);
    proposalRows = [];
    expect(
      failure(await call("reject", ADMIN, { proposalId: PROPOSAL })).status,
    ).toBe(404);
    proposalRows = [{ ok: 1 }];
    expect(await call("reject", ADMIN, { proposalId: PROPOSAL })).toMatchObject(
      { ok: true },
    );
    expect(m.rejectProposal).toHaveBeenCalledWith(PROPOSAL, 1);
  });
});

describe("preview and family articles (td-894144 B5)", () => {
  it("Preview: admins only, a real proposal of THIS tag, queued with the tag", async () => {
    m.enqueuePreview.mockResolvedValue({ jobId: 9, deduped: false });
    expect(failure(await call("preview", VIEWER, { proposalId: PROPOSAL })).status).toBe(403);
    expect(failure(await call("preview", ADMIN, { proposalId: "nope" })).status).toBe(400);
    proposalRows = [];
    expect(failure(await call("preview", ADMIN, { proposalId: PROPOSAL })).status).toBe(404);
    expect(m.enqueuePreview).not.toHaveBeenCalled();
    proposalRows = [{ ok: 1 }];
    expect(await call("preview", ADMIN, { proposalId: PROPOSAL })).toMatchObject({
      ok: true,
      message: expect.stringMatching(/Queued the preview \(job #9\)/),
    });
    expect(m.enqueuePreview).toHaveBeenCalledWith(TAG, PROPOSAL, 1);
  });

  it("Fetch family articles: admins only", async () => {
    m.enqueueFamilyRefs.mockResolvedValue({ jobId: 10, deduped: true });
    expect(failure(await call("familyRefs", VIEWER, {})).status).toBe(403);
    expect(await call("familyRefs", ADMIN, {})).toMatchObject({
      ok: true,
      message: expect.stringMatching(/already queued \(job #10\)/),
    });
    expect(m.enqueueFamilyRefs).toHaveBeenCalledWith(1);
  });

  it("approval surfaces the taxonomy refusal text verbatim", async () => {
    m.approveProposal.mockRejectedValue(
      new Error("These rules do not fit the current taxonomy: taxon rule t1 names no known family: Phalaropidae"),
    );
    const r = failure(await call("approve", ADMIN, { proposalId: PROPOSAL, confirm: TAG }));
    expect(r.status).toBe(409);
    expect(r.data.message).toMatch(/Phalaropidae/);
  });
});
