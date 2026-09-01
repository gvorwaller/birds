/**
 * "How far away is the nearest current report of this species?" — answered
 * without eBird's `/data/nearest/geo/recent`, which cannot answer it
 * (td-73e6f9, plan docs/2026-09-01-nearest-region-ladder-plan.md).
 *
 * THE PROBLEM. That endpoint does a radial scan whose cost grows with the
 * species' record volume, so it is fast exactly when the answer is easy and
 * dies exactly when the feature is interesting. Measured 2026-09-01 from a
 * Jacksonville home: Streak-backed Oriole (rare) answered from HONDURAS in
 * 3.6 s and Gyrfalcon in 0.4 s, while Black-capped Chickadee and European
 * Robin — common birds whose nearest report is far — held the connection for
 * 60 s and then returned HTTP 500, reproducibly, at any hour. Not an outage;
 * a property of the endpoint.
 *
 * THE REPLACEMENT. eBird's per-region species query is region-indexed and
 * answers in a fraction of a second regardless (2,071 rows for all of New
 * York: 0.45 s). We already own a global index of regions with verified
 * bounding boxes, so we can walk regions outward from home and stop early:
 * a branch-and-bound nearest-neighbour search where each region's
 * distance-to-box is a lower bound on any observation inside it.
 *
 * WHAT IT DOES NOT CLAIM. Our seeded coverage is not the globe — 301 eBird
 * codes have no usable geography, and antimeridian regions have no usable
 * bound. The result therefore describes "the closest report in the regions we
 * searched", and carries the metadata (`capped`, `proven`, `searched`) callers
 * need to say so honestly. It must never be rendered as "no reports anywhere".
 */
import {
  EbirdError,
  nearestObsOfSpecies,
  recentSpeciesInRegion,
  REGION_PROBE_MAX_RESULTS,
  type EbirdObs,
} from "$server/ebird";
import { mapWithConcurrency } from "$server/concurrency";
import { obsKey } from "$server/observations";
import { allProximityRegions, type Region } from "$server/regions";
import { distanceToBoxKm, haversineKm } from "$lib/geo";

/** How many observations the callers render. The stop rule is built on it. */
export const LADDER_TOP_N = 5;

/**
 * Subtracted from every box bound before pruning.
 *
 * A region's bounding box is asserted to contain its observations, but that
 * invariant is eBird's, not ours: obscured or sensitive locations can be
 * reported at jittered coordinates. Shaving the bound makes the search
 * strictly more conservative — it can only cause extra probing, never a
 * missed closer report. Reducing it requires the live audit in the plan's
 * verification section, not an argument.
 */
export const BOUND_MARGIN_KM = 25;

/** Probes running at once. Whole waves are awaited before the stop check. */
export const LADDER_WAVE = 3;

export interface NearestLadderResult {
  /** Raw observations, nearest first, at most LADDER_TOP_N. */
  rows: EbirdObs[];
  stale: boolean;
  /** Which strategy produced `rows` — drives honest UI copy. */
  via: "nearest" | "ladder";
  searched: {
    /** Regions actually probed. */
    regions: number;
    /**
     * Lower bound of the first region we did NOT probe. NOT a covered
     * radius: coverage is a set of boxes with holes in it. UI must not
     * render this as "everything within X was searched".
     */
    boundKm: number | null;
  };
  /** Stopped on budget/deadline/breaker rather than on the bound. */
  capped: boolean;
  /** At least one probe failed, or a saturated payload was truncated. */
  partial: boolean;
  /**
   * False when something closer than the worst returned row might exist and
   * was not checked — a failed rung, or an unprobed candidate whose bound
   * was smaller. True only when the search actually settled the question
   * within its coverage.
   */
  proven: boolean;
}

export interface NearestLadderOpts {
  /**
   * How long the direct endpoint gets alone before the region search starts
   * running ALONGSIDE it.
   *
   * Not a deadline — nothing is abandoned when it elapses. It exists only so
   * the common case costs nothing extra: the direct endpoint answers a rare
   * species in well under a second, so a short head start means those
   * lookups never probe a single region. Past it, both strategies run and
   * the first real answer wins.
   */
  headStartMs: number;
  /** Maximum region probes for this species. */
  probeBudget: number;
  /** Wall-clock ceiling for the ladder phase, checked between waves. */
  ladderDeadlineMs: number;
  /**
   * Caller cancellation. Stops SCHEDULING further waves; never cancels an
   * in-flight probe, whose result may already be shared with another request
   * through the eBird cache's single-flight.
   */
  signal?: AbortSignal;
  /**
   * Shared limiter for pages that run several species at once (/nearest runs
   * six). Without it each species would get its own concurrency and the page
   * would open `species × LADDER_WAVE` sockets.
   */
  gate?: ProbeGate;
  /** Injectable clock so deadline tests need no real timers. */
  now?: () => number;
}

/**
 * A page-global probe allowance. Counts probes rather than time so several
 * species searches share one budget; `take()` returns false once spent.
 */
export interface ProbeGate {
  take(): boolean;
  remaining(): number;
  /**
   * Run one reserved probe under the page-global socket ceiling. A probe that
   * was queued but whose species search has since stopped is skipped before it
   * reaches eBird.
   */
  run<T>(
    probe: () => Promise<T>,
    shouldStart?: () => boolean,
  ): Promise<T | undefined>;
}

export function createProbeGate(
  total: number,
  concurrency = LADDER_WAVE,
): ProbeGate {
  let left = Math.max(0, total);
  let active = 0;
  const limit = Math.max(1, Math.trunc(concurrency));
  const queued: Array<() => void> = [];

  const pump = () => {
    while (active < limit && queued.length > 0) queued.shift()!();
  };

  return {
    take: () => (left > 0 ? (left--, true) : false),
    remaining: () => left,
    run: <T>(probe: () => Promise<T>, shouldStart?: () => boolean) =>
      new Promise<T | undefined>((resolve, reject) => {
        queued.push(() => {
          if (shouldStart && !shouldStart()) {
            resolve(undefined);
            queueMicrotask(pump);
            return;
          }
          active++;
          probe()
            .then(resolve, reject)
            .finally(() => {
              active--;
              pump();
            });
        });
        pump();
      }),
  };
}

/**
 * Lower bound on the distance from `home` to ANY observation inside `region`.
 *
 * Must never exceed the true distance, or branch-and-bound would prune a
 * region that holds a closer report. A region with no box has no such bound,
 * so it gets zero: it can then never justify stopping (see `sortKeyKm`, which
 * keeps it from also dominating the probe order).
 */
export function pruneBoundKm(
  home: { lat: number; lon: number },
  region: Region,
): number {
  if (!region.box) return 0;
  return Math.max(
    0,
    distanceToBoxKm(home.lat, home.lon, region.box) - BOUND_MARGIN_KM,
  );
}

/**
 * Probe ORDER, which is deliberately not the prune bound.
 *
 * A box-less region's bound is 0, and using that as the sort key would put
 * every such region first from everywhere on earth — consuming a small
 * budget before the home state is ever probed. Ordering by centroid keeps the
 * search sensible while `pruneBoundKm` stays sound.
 */
export function sortKeyKm(
  home: { lat: number; lon: number },
  region: Region,
): number {
  if (!region.box)
    return haversineKm(home.lat, home.lon, region.lat, region.lon);
  return pruneBoundKm(home, region);
}

/** eBird 401/403/429 — retrying across dozens of regions cannot help. */
function isFatalUpstream(err: unknown): boolean {
  return (
    err instanceof EbirdError &&
    (err.status === 401 || err.status === 403 || err.status === 429)
  );
}

function distanceOf(home: { lat: number; lon: number }, o: EbirdObs): number {
  return haversineKm(home.lat, home.lon, o.lat, o.lng);
}

export async function nearestSpeciesReports(
  apiKey: string,
  speciesCode: string,
  home: { lat: number; lon: number },
  back: number,
  opts: NearestLadderOpts,
): Promise<NearestLadderResult> {
  const now = opts.now ?? Date.now;

  // TWO STRATEGIES, RACED — not "try one, then fall back".
  //
  // The direct endpoint has better coverage (all of eBird, not just our
  // seeded regions), so it is worth asking and worth preferring. But it can
  // grind for a minute on the very lookups this feature is for, and waiting
  // out that minute before starting the search we KNOW answers in about a
  // second was a bad trade — it made the fixed page take longer than the
  // answer needed.
  //
  // So: start the direct call; give it a head start; if it has not answered
  // by then, start the region search too and take whichever finishes first.
  // A rare species pays nothing extra (answered inside the head start); a
  // stalling one gets its answer in seconds instead of after the stall.
  type FastOutcome =
    | { kind: "fast"; res: Awaited<ReturnType<typeof nearestObsOfSpecies>> }
    | { kind: "fastErr"; err: unknown };
  const fast: Promise<FastOutcome> = nearestObsOfSpecies(
    apiKey,
    speciesCode,
    home.lat,
    home.lon,
    back,
  ).then(
    (res) => ({ kind: "fast" as const, res }),
    (err) => ({ kind: "fastErr" as const, err }),
  );

  const fromFast = (res: Awaited<ReturnType<typeof nearestObsOfSpecies>>) => {
    const rows = [...res.data].sort(
      (a, b) => distanceOf(home, a) - distanceOf(home, b),
    );
    return {
      rows: rows.slice(0, LADDER_TOP_N),
      stale: res.stale,
      via: "nearest" as const,
      searched: { regions: 0, boundKm: null },
      capped: false,
      partial: false,
      proven: true,
    };
  };

  let headTimer: ReturnType<typeof setTimeout> | undefined;
  const headStart = new Promise<{ kind: "headstart" }>((resolve) => {
    headTimer = setTimeout(
      () => resolve({ kind: "headstart" }),
      opts.headStartMs,
    );
  });
  let first: FastOutcome | { kind: "headstart" };
  try {
    first = await Promise.race([fast, headStart]);
  } finally {
    clearTimeout(headTimer);
  }

  if (first.kind === "fast") return fromFast(first.res);
  if (first.kind === "fastErr") {
    // A bad key or a rate limit will fail every rung too; turning that into
    // dozens of probes is the rate-limit abuse cs.md forbids.
    if (isFatalUpstream(first.err)) throw first.err;
  }

  // Still pending (or already failed): run the region search. When the
  // direct call is still alive we race it, so its better coverage still
  // wins if it beats us to an answer.
  const stopLadder = new AbortController();
  const ladderSignal = opts.signal
    ? AbortSignal.any([opts.signal, stopLadder.signal])
    : stopLadder.signal;

  // 2. Walk our regions outward.
  const runLadder = async (): Promise<NearestLadderResult> => {
    const { candidates } = await allProximityRegions();
    const ranked = candidates
      .map((region) => ({
        region,
        bound: pruneBoundKm(home, region),
        sortKey: sortKeyKm(home, region),
      }))
      .filter((c) => Number.isFinite(c.sortKey))
      .sort((a, b) => a.sortKey - b.sortKey);

    const startedAt = now();
    const byKey = new Map<string, EbirdObs>();
    let stale = false;
    let partial = false;
    let capped = false;
    let probed = 0;
    let consecutiveFailures = 0;
    /** Smallest bound among candidates we did NOT successfully probe. */
    let unresolvedBound = Number.POSITIVE_INFINITY;
    let cursor = 0;

    const noteUnresolved = (bound: number) => {
      if (bound < unresolvedBound) unresolvedBound = bound;
    };

    /** Current top-N distances, nearest first. */
    const ranking = () =>
      [...byKey.values()].sort(
        (a, b) => distanceOf(home, a) - distanceOf(home, b),
      );

    while (cursor < ranked.length) {
      if (ladderSignal.aborted) {
        capped = true;
        break;
      }
      if (now() - startedAt >= opts.ladderDeadlineMs) {
        capped = true;
        break;
      }

      const wave: typeof ranked = [];
      while (wave.length < LADDER_WAVE && cursor < ranked.length) {
        if (probed + wave.length >= opts.probeBudget) break;
        if (opts.gate && !opts.gate.take()) break;
        wave.push(ranked[cursor++]);
      }
      if (wave.length === 0) {
        capped = true;
        break;
      }

      const outcomes = await mapWithConcurrency(
        wave,
        LADDER_WAVE,
        async (c) => {
          const probe = async () => {
            try {
              const res = await recentSpeciesInRegion(
                apiKey,
                c.region.code,
                speciesCode,
                back,
              );
              return { c, res, err: null as unknown, skipped: false as const };
            } catch (e) {
              return { c, res: null, err: e, skipped: false as const };
            }
          };
          const outcome = opts.gate
            ? await opts.gate.run(
                probe,
                () =>
                  !ladderSignal.aborted &&
                  now() - startedAt < opts.ladderDeadlineMs,
              )
            : await probe();
          return (
            outcome ?? {
              c,
              res: null,
              err: null,
              skipped: true as const,
            }
          );
        },
      );
      probed += outcomes.filter((outcome) => !outcome.skipped).length;

      let breakerTripped = false;
      for (const { c, res, err, skipped } of outcomes) {
        if (skipped) {
          capped = true;
          noteUnresolved(c.bound);
          continue;
        }
        if (!res) {
          if (isFatalUpstream(err)) {
            // Abort the whole ladder: every remaining rung would fail
            // identically, and hammering on a 429 is the opposite of
            // backing off.
            partial = true;
            capped = true;
            noteUnresolved(c.bound);
            for (let i = cursor; i < ranked.length; i++)
              noteUnresolved(ranked[i].bound);
            return finish();
          }
          partial = true;
          noteUnresolved(c.bound);
          // Counted per RUNG in probe order, not per wave: three failures
          // in a row is a systemic upstream problem, and thirty-seven
          // more probes will not fix it.
          if (++consecutiveFailures >= 3) {
            breakerTripped = true;
            break;
          }
          continue;
        }
        consecutiveFailures = 0;
        stale = stale || res.stale;
        // A saturated payload is not the region's full contents, and eBird
        // does not order rows by distance — the closest report can be the
        // one truncated away.
        if (res.data.length >= REGION_PROBE_MAX_RESULTS) {
          partial = true;
          noteUnresolved(c.bound);
        }
        for (const o of res.data) {
          if (o.speciesCode !== speciesCode) continue;
          if (!Number.isFinite(o.lat) || !Number.isFinite(o.lng)) continue;
          // Dedupe BEFORE anything counts hits: a country probe repeats
          // the observations of its own subnational1s, and five copies of
          // one report must not satisfy a five-hit stop rule.
          const key = obsKey(o);
          if (!byKey.has(key)) byKey.set(key, o);
        }
      }

      if (breakerTripped) {
        capped = true;
        for (let i = cursor; i < ranked.length; i++)
          noteUnresolved(ranked[i].bound);
        break;
      }

      const top = ranking();
      const next = ranked[cursor];
      if (top.length >= LADDER_TOP_N && next) {
        // The stop rule is TOP-N aware. Stopping at the first hit would
        // prove only the single nearest observation while four rows the UI
        // renders could still be beaten by the very next region.
        const worstShown = distanceOf(home, top[LADDER_TOP_N - 1]);
        if (next.bound > worstShown) break;
      }
      if (!next) break; // exhausted our coverage
    }

    return finish();

    function finish(): NearestLadderResult {
      const top = ranking().slice(0, LADDER_TOP_N);
      // Everything we never reached is also unresolved.
      for (let i = cursor; i < ranked.length; i++)
        noteUnresolved(ranked[i].bound);
      const worstShown =
        top.length >= LADDER_TOP_N
          ? distanceOf(home, top[LADDER_TOP_N - 1])
          : Number.POSITIVE_INFINITY;
      return {
        rows: top,
        stale,
        via: "ladder",
        searched: {
          regions: probed,
          boundKm: Number.isFinite(unresolvedBound) ? unresolvedBound : null,
        },
        capped,
        partial,
        // Honest only if nothing we skipped could have beaten what we show.
        proven: unresolvedBound > worstShown,
      };
    }
  };

  // If the direct call already failed there is nothing to race — the region
  // search IS the answer. Otherwise both run, and the first to finish wins.
  if (first.kind === "fastErr") return runLadder();

  // Started ONCE and shared by both branches below: awaiting it twice would
  // be free, but starting it twice would double the upstream calls.
  const ladderPromise = runLadder().then((res) => ({
    kind: "ladder" as const,
    res,
  }));
  // If we abandon this leg (fatal upstream error), its settlement must not
  // surface as an unhandled rejection.
  ladderPromise.catch(() => {});

  const outcome = await Promise.race([fast, ladderPromise]);
  if (outcome.kind === "fast") {
    // Better coverage, and it got here first: prefer it, and stop the
    // search from scheduling any further probes.
    stopLadder.abort();
    return fromFast(outcome.res);
  }
  if (outcome.kind === "ladder") {
    if (outcome.res.rows.length > 0) return outcome.res;
    // AN EMPTY SEARCH IS NOT AN ANSWER, so it must not win the race.
    //
    // Our coverage has holes and a budget; the direct call sees all of eBird.
    // Measured: Streak-backed Oriole's nearest report is in HONDURAS, which
    // the region search cannot reach inside its budget — it finished empty at
    // 3.5s while the direct call was about to return that report at 3.6s.
    // Racing on "first to finish" threw away a correct answer that was a
    // tenth of a second away.
    //
    // So when the search comes back with nothing, give the direct call one
    // more head start's worth of grace. That reuses a number already in play
    // rather than inventing another, and it cannot resurrect the stall this
    // design exists to dodge: a species whose direct lookup grinds for a
    // minute simply exhausts the grace and keeps the honest empty result.
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const grace = new Promise<{ kind: "grace" }>((resolve) => {
      graceTimer = setTimeout(() => resolve({ kind: "grace" }), opts.headStartMs);
    });
    let late: FastOutcome | { kind: "grace" };
    try {
      late = await Promise.race([fast, grace]);
    } finally {
      clearTimeout(graceTimer);
    }
    if (late.kind === "fast") return fromFast(late.res);
    if (late.kind === "fastErr" && isFatalUpstream(late.err)) throw late.err;
    return outcome.res;
  }
  // The direct call lost the race by failing. Wait for the search it was
  // already racing, which is well underway.
  if (isFatalUpstream(outcome.err)) {
    // Current probes may finish and populate the shared cache, but a bad key
    // or rate limit must prevent the abandoned ladder from scheduling waves in
    // the background after this request has already thrown.
    stopLadder.abort();
    throw outcome.err;
  }
  return (await ladderPromise).res;
}
