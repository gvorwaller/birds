/**
 * td-6093ae: Admin → Taxonomy actions and the progress endpoint. Admins only,
 * every result carries kind "taxonomy", and each prerequisite is checked
 * separately: the sync needs the admin's eBird API key, the reloads their
 * eBird account login. The run logic itself is tested in
 * src/lib/server/taxonomy-refresh*.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/db", () => ({ query: vi.fn(async () => ({ rows: [] })), queryTimed: vi.fn(async () => ({ rows: [] })) }));
vi.mock("$server/admin-status", () => ({ adminLiveStatus: vi.fn() }));
vi.mock("$server/gallery", () => ({ galleryHealth: vi.fn() }));
vi.mock("$server/job-handlers", () => ({ nudgeEnrichmentScan: vi.fn(), previewEnrichmentScan: vi.fn() }));

const m = vi.hoisted(() => {
  class TaxonomyRunError extends Error {}
  return {
    TaxonomyRunError,
    getEbirdApiKey: vi.fn(async () => "key" as string | null),
    hasEbirdLogin: vi.fn(async () => true),
    startOrResumeRun: vi.fn(),
    dispatchRefresh: vi.fn(),
    taxonomyLiveStatus: vi.fn(),
  };
});
vi.mock("$server/ebird", () => ({ getEbirdApiKey: m.getEbirdApiKey, latestTaxonomyVersion: vi.fn() }));
vi.mock("$server/ebird-account", () => ({ lifeListOrphans: vi.fn() }));
vi.mock("$server/taxonomy-refresh", () => ({
  TaxonomyRunError: m.TaxonomyRunError,
  hasEbirdLogin: m.hasEbirdLogin,
  startOrResumeRun: m.startOrResumeRun,
  dispatchRefresh: m.dispatchRefresh,
  taxonomyPanel: vi.fn(),
  taxonomyLiveStatus: m.taxonomyLiveStatus,
}));

import { actions } from "./+page.server";
import { GET } from "../api/admin/taxonomy/+server";

const ADMIN = { id: 1, role: "admin", username: "gaylon", display_name: "Gaylon" };
const USER = { id: 2, role: "user", username: "u", display_name: "U" };
const req = (fields: Record<string, string> = {}) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return new Request("http://localhost/admin", { method: "POST", body: fd });
};
const call = (name: string, user: object, fields?: Record<string, string>) =>
  (actions as Record<string, (e: unknown) => Promise<unknown>>)[name]({ locals: { user }, request: req(fields) });
const body = (r: unknown) => ((r as { data?: unknown }).data ?? r) as { kind: string; ok: boolean; message: string };

beforeEach(() => {
  vi.clearAllMocks();
  m.getEbirdApiKey.mockResolvedValue("key");
  m.hasEbirdLogin.mockResolvedValue(true);
});

describe("taxonomy actions", () => {
  it("refuse anyone but an admin, before doing anything", async () => {
    for (const name of ["taxonomy_sync", "taxonomy_refresh", "taxonomy_retry"]) {
      const r = await call(name, USER, { run_id: "3" });
      expect(r).toMatchObject({ status: 403, data: { kind: "taxonomy", ok: false } });
    }
    expect(m.startOrResumeRun).not.toHaveBeenCalled();
    expect(m.dispatchRefresh).not.toHaveBeenCalled();
  });

  it("the sync needs the admin's eBird API key", async () => {
    m.getEbirdApiKey.mockResolvedValueOnce(null);
    const r = await call("taxonomy_sync", ADMIN);
    expect(body(r)).toMatchObject({ kind: "taxonomy", ok: false, message: expect.stringMatching(/API key/) });
    expect(m.startOrResumeRun).not.toHaveBeenCalled();
  });

  it("starts a run as the clicking admin, and says when one is already running or is resumed", async () => {
    m.startOrResumeRun.mockResolvedValueOnce({ runId: 1, jobId: 9, resumed: false, alreadyRunning: false });
    expect(body(await call("taxonomy_sync", ADMIN))).toMatchObject({ ok: true, message: expect.stringMatching(/Backing up, syncing and comparing/) });
    expect(m.startOrResumeRun).toHaveBeenCalledWith(1, "Gaylon");
    m.startOrResumeRun.mockResolvedValueOnce({ runId: 1, jobId: 9, resumed: false, alreadyRunning: true });
    expect(body(await call("taxonomy_sync", ADMIN)).message).toMatch(/already running/);
    m.startOrResumeRun.mockResolvedValueOnce({ runId: 1, jobId: 10, resumed: true, alreadyRunning: false });
    expect(body(await call("taxonomy_sync", ADMIN)).message).toMatch(/where it left off/);
  });

  it("reloads need the admin's eBird account login, not just the key", async () => {
    m.hasEbirdLogin.mockResolvedValueOnce(false);
    const r = await call("taxonomy_refresh", ADMIN, { run_id: "3" });
    expect(body(r)).toMatchObject({ ok: false, message: expect.stringMatching(/account login/) });
    expect(m.dispatchRefresh).not.toHaveBeenCalled();
  });

  it("queues new locations, or the unfinished ones again, for the clicking admin", async () => {
    m.dispatchRefresh.mockResolvedValueOnce({ batches: 2, locations: 201 });
    expect(body(await call("taxonomy_refresh", ADMIN, { run_id: "3" })).message).toBe(
      "Queued 201 locations in 2 batches. Progress shows below.",
    );
    expect(m.dispatchRefresh).toHaveBeenCalledWith(3, 1, "new");
    m.dispatchRefresh.mockResolvedValueOnce({ batches: 0, locations: 0 });
    expect(body(await call("taxonomy_retry", ADMIN, { run_id: "3" })).message).toBe("Nothing needs retrying.");
    expect(m.dispatchRefresh).toHaveBeenLastCalledWith(3, 1, "unfinished");
  });

  it("explains a refused dispatch and rejects a missing run", async () => {
    m.dispatchRefresh.mockRejectedValueOnce(new m.TaxonomyRunError("This run has not finished comparing yet."));
    expect(body(await call("taxonomy_refresh", ADMIN, { run_id: "3" }))).toMatchObject({
      ok: false,
      message: "This run has not finished comparing yet.",
    });
    expect(body(await call("taxonomy_refresh", ADMIN, { run_id: "x" }))).toMatchObject({ ok: false, message: "Unknown taxonomy run." });
  });
});

describe("GET /api/admin/taxonomy", () => {
  it("conceals itself from non-admins", async () => {
    await expect(
      GET({ locals: { user: USER }, url: new URL("http://x/api/admin/taxonomy?run=1") } as never),
    ).rejects.toMatchObject({ status: 404 });
    expect(m.taxonomyLiveStatus).not.toHaveBeenCalled();
  });

  it("returns a run's live status, uncached", async () => {
    m.taxonomyLiveStatus.mockResolvedValueOnce({ stage: "compared", jobActive: false });
    const res = await GET({ locals: { user: ADMIN }, url: new URL("http://x/api/admin/taxonomy?run=4") } as never);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(await res.json()).toEqual({ stage: "compared", jobActive: false });
    expect(m.taxonomyLiveStatus).toHaveBeenCalledWith(4);
  });

  it("rejects a bad or unknown run", async () => {
    await expect(GET({ locals: { user: ADMIN }, url: new URL("http://x/api/admin/taxonomy?run=0") } as never)).rejects.toMatchObject({
      status: 400,
    });
    m.taxonomyLiveStatus.mockResolvedValueOnce(null);
    await expect(GET({ locals: { user: ADMIN }, url: new URL("http://x/api/admin/taxonomy?run=9") } as never)).rejects.toMatchObject({
      status: 404,
    });
  });
});
