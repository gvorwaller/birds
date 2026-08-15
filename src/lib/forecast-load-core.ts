/**
 * Pure decision logic for the app-level bulk load loop (td follow-up to
 * td-8a6f97: the loop survives in-app navigation). Kept rune-free so it's
 * unit-testable; the driver lives in forecast-load.svelte.ts.
 */

export interface BulkFailure {
  code: string;
  error: string;
}

export interface EnsureShape {
  refreshed: string[];
  failed: BulkFailure[];
  notAttempted: string[];
  credentialProblem: string | null;
  busy: boolean;
  capExhausted?: boolean;
}

export type LoopVerdict =
  | { next: "continue" }
  | { next: "done" }
  | { next: "stop"; reason: "credential" | "busy" | "cap" | "stalled" };

/**
 * Decide what the loop does after one batch. Mirrors the page-bound loop's
 * rules: stop hard on credential problems or a competing batch; finish when
 * nothing remains; stop (rather than spin) when a round made no progress —
 * every remaining location must have been skipped for a reason that won't
 * change by retrying immediately.
 */
export function loopVerdict(ensure: EnsureShape): LoopVerdict {
  if (ensure.credentialProblem) return { next: "stop", reason: "credential" };
  if (ensure.busy) return { next: "stop", reason: "busy" };
  if (ensure.notAttempted.length === 0) return { next: "done" };
  if (ensure.refreshed.length + ensure.failed.length === 0) {
    // The daily ceiling gets its own reason — the silent prod pop-back of
    // 2026-08-15 was a capped round with no UI for it.
    return {
      next: "stop",
      reason: ensure.capExhausted ? "cap" : "stalled",
    };
  }
  // Progress was made this round; if the cap ALSO closed mid-round, the next
  // round would attempt nothing — stop now with the honest reason.
  if (ensure.capExhausted) return { next: "stop", reason: "cap" };
  return { next: "continue" };
}

/** Accumulate failures across rounds, keeping the LAST error per location. */
export function mergeFailures(
  prior: readonly BulkFailure[],
  round: readonly BulkFailure[],
): BulkFailure[] {
  const byCode = new Map(prior.map((f) => [f.code, f]));
  for (const f of round) byCode.set(f.code, f);
  return [...byCode.values()];
}
