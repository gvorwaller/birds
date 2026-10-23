import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listJobs: vi.fn(),
  workerHealth: vi.fn(),
  familyControl: vi.fn(),
  externalLoadsForUser: vi.fn(),
}));

vi.mock("$server/jobs", () => ({
  listJobs: mocks.listJobs,
  workerHealth: mocks.workerHealth,
}));
vi.mock("$server/family-enrichment", () => ({ familyControl: mocks.familyControl }));
vi.mock("$server/external-sources/jobs", () => ({ externalLoadsForUser: mocks.externalLoadsForUser }));

import { GET } from "./+server";

const job = (overrides: Record<string, unknown> = {}) => ({
  id: 12,
  type: "enrich_families",
  status: "pending",
  payload: {},
  label: "Family descriptions",
  attempts: 1,
  max_attempts: 4,
  next_retry_at: null,
  cancel_requested: false,
  progress: {},
  result: null,
  error: null,
  requested_by: 1,
  requested_by_name: "Owner",
  enqueued_at: "2026-09-19T11:00:00.000Z",
  started_at: null,
  finished_at: null,
  heartbeat_at: "2026-09-19T11:59:00.000Z",
  ...overrides,
});

beforeEach(() => {
  mocks.externalLoadsForUser.mockReset().mockResolvedValue([]);
  mocks.workerHealth.mockReset().mockResolvedValue({
    alive: true,
    state: "idle",
    pid: 7,
    version: "test",
    startedAt: new Date("2026-09-19T10:00:00.000Z"),
    heartbeatAt: new Date("2026-09-19T11:59:00.000Z"),
    currentJobId: null,
    pauseRequested: false,
  });
  mocks.listJobs.mockReset().mockResolvedValue([job()]);
  mocks.familyControl.mockReset().mockResolvedValue({
    paused: true,
    blocked_until: null,
    reason: "test-only private reason",
  });
});

describe("GET /api/jobs", () => {
  it("reads category control once for the entire snapshot and requests the disclosed history window", async () => {
    mocks.listJobs.mockResolvedValue([job(), job({ id: 13, type: "load_hotspots" })]);
    await GET({ locals: {} } as never);
    expect(mocks.familyControl).toHaveBeenCalledTimes(1);
    expect(mocks.listJobs).toHaveBeenCalledWith(15);
  });

  it("fails the snapshot if category state is unavailable instead of claiming queued work", async () => {
    mocks.familyControl.mockRejectedValue(new Error("category state unavailable"));
    await expect(GET({ locals: {} } as never)).rejects.toThrow("category state unavailable");
  });

  it("returns safe worker pause state and category-aware presentation", async () => {
    const response = await GET({ locals: {} } as never);
    const body = await response.json();
    expect(body.snapshotAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(body.worker).toMatchObject({ alive: true, state: "idle", pauseRequested: false });
    expect(body.jobs[0]).toMatchObject({
      displayName: "Family descriptions",
      presentation: {
        state: "paused",
        label: "Family descriptions",
        explanation: "Family descriptions are paused; other loads continue normally.",
      },
    });
    expect(JSON.stringify(body)).not.toContain("test-only private reason");
  });

  it("does not let family pause relabel frequency loads", async () => {
    mocks.listJobs.mockResolvedValue([job({ type: "load_hotspots", label: "1 hotspot — Celery Fields" })]);
    const body = await (await GET({ locals: {} } as never)).json();
    expect(body.jobs[0].presentation.state).toBe("queued");
  });

  it("lists the signed-in user's external-source loads separately from eBird jobs (td-eec7db)", async () => {
    mocks.listJobs.mockResolvedValue([]);
    const load = { id: "0b6f1f9e-4c1b-4c55-9a3e-7d2b1c0a9e11", status: "queued", presentation: { state: "queued" } };
    mocks.externalLoadsForUser.mockResolvedValue([load]);
    const body = await (await GET({ locals: { user: { id: 42 } } } as never)).json();
    expect(mocks.externalLoadsForUser).toHaveBeenCalledWith(42);
    expect(body.external).toEqual([load]);
    expect(body.jobs).toEqual([]);
    mocks.externalLoadsForUser.mockClear();
    const anon = await (await GET({ locals: {} } as never)).json();
    expect(mocks.externalLoadsForUser).not.toHaveBeenCalled();
    expect(anon.external).toEqual([]);
  });
});
