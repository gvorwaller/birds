/**
 * td-894144 (CODEX1 re-review): the worker's dispatcher must hand the LIVE
 * WorkerContext to the AI draft job — without it the job cannot see a drain
 * and a deploy would kill a minutes-long Opus call mid-flight.
 */
import { describe, expect, it, vi } from "vitest";

const seen = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock("$server/tag-draft-job", () => ({
  runTagDraftJob: async (...args: unknown[]) => {
    seen.calls.push(args);
  },
}));

import { runJob, type WorkerContext } from "./job-handlers";
import type { JobRow } from "./job-policy";

describe("runJob → tag_draft_rules", () => {
  it("forwards the worker context itself", async () => {
    const ctx: WorkerContext = { isDraining: () => false };
    const job = { id: 1, type: "tag_draft_rules", payload: {} } as JobRow;
    await runJob(job, ctx);
    expect(seen.calls).toHaveLength(1);
    expect(seen.calls[0][0]).toBe(job);
    expect(seen.calls[0][1]).toBe(ctx);
  });
});
