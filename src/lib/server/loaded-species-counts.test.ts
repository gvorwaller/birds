import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import pg from "pg";
import { env } from "$env/dynamic/private";

/**
 * td-de2150: the species-count snapshot against real PostgreSQL. Every table
 * the module reads or writes is a pg_temp table on ONE connection (temp tables
 * shadow the restored production-sized tables for that connection only), so
 * nothing here touches shared frequency/taxonomy data or the real published
 * snapshot row. The stale-claim suite uses the real `jobs` table with its own
 * fixture user and job, deleted by id.
 */
const mocked = vi.hoisted(() => ({
  active: null as unknown as import("pg").Client,
  calls: [] as string[],
  /** Throw from the next aggregate statement (a failed build). */
  failAggregate: null as Error | null,
  /**
   * Runs once, right after the build's read snapshot commits and before the
   * refresh publishes: a source commit "during the build". One session cannot
   * commit inside its own open REPEATABLE READ transaction, and a second
   * session cannot see these pg_temp tables (birds_app may not create a
   * schema of its own), so the commit is injected at the first point after
   * the snapshot where this session can make it. For the publish step that is
   * the same moment: after the snapshot, before the publish.
   */
  afterSnapshot: null as null | (() => Promise<unknown>),
}));
vi.mock("$lib/db", () => {
  const run = async (text: string, params?: unknown[]) => {
    mocked.calls.push(text);
    if (mocked.failAggregate && text.includes("GROUPING SETS")) {
      const err = mocked.failAggregate;
      mocked.failAggregate = null;
      throw err;
    }
    return mocked.active.query(text, params as never[]);
  };
  const tx =
    (begin: string) => async (fn: (c: unknown) => Promise<unknown>) => {
      await run(begin);
      try {
        const out = await fn({ query: run });
        await run("COMMIT");
        const hook = begin.includes("READ ONLY") ? mocked.afterSnapshot : null;
        mocked.afterSnapshot = null;
        if (hook) await hook();
        return out;
      } catch (err) {
        // stale-safe: test transaction wrapper, rethrows
        await mocked.active.query("ROLLBACK");
        throw err;
      }
    };
  return {
    query: run,
    withTransaction: tx("BEGIN"),
    withReadSnapshot: tx("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"),
  };
});

import {
  aggregateSpeciesCounts,
  buildSpeciesCountSnapshot,
  failureBackoffMs,
  publishSpeciesCountSnapshot,
  readSpeciesCountSnapshot,
  refreshDecision,
  refreshSpeciesCountSnapshot,
  SPECIES_COUNT_CHECK_MS,
  SPECIES_COUNT_DEFER_MAX_MS,
  SPECIES_COUNT_DEFER_MIN_MS,
  SPECIES_COUNT_FAILURE_BASE_MS,
  SPECIES_COUNT_FAILURE_MAX_MS,
  SPECIES_COUNT_MAX_AGE_MS,
  SPECIES_COUNT_QUIET_MS,
  type RefreshState,
} from "./loaded-species-counts";
import { speciesCountStatus } from "$lib/species-count-status";
import { isStaleClaim, runWithClaim } from "./job-claim";

function requireTestDb() {
  if (
    env.PGHOST !== "127.0.0.1" ||
    env.PGPORT !== "15436" ||
    env.PGDATABASE !== "birds_test"
  ) {
    throw new Error("Requires the dedicated local test database");
  }
}

async function connect(): Promise<pg.Client> {
  const client = new pg.Client({
    host: env.PGHOST,
    port: Number(env.PGPORT),
    database: env.PGDATABASE,
    user: env.PGUSER,
    password: env.PGPASSWORD,
  });
  await client.connect();
  return client;
}

/** The source tables (shadowed) and the snapshot table (same constraints as the migration). */
const TEMP_TABLES = `
  CREATE TEMP TABLE frequency_fetch (loc_code text, loc_kind text, region_code text,
    fetched_at timestamptz DEFAULT now() - interval '1 hour', n_species int DEFAULT 0);
  CREATE TEMP TABLE taxonomy_cache (species_code text, category text);
  CREATE TEMP TABLE species_month_freq (loc_code text, species_code text, month int, num float8);
  CREATE TEMP TABLE species_count_snapshot (LIKE public.species_count_snapshot INCLUDING ALL);
`;

const FIXTURE = `
  INSERT INTO taxonomy_cache VALUES
    ('a','species'),('b','species'),('c','species'),('d','species'),('e','species'),('slash','slash');
  INSERT INTO frequency_fetch (loc_code,loc_kind,region_code) VALUES
    ('US','region',NULL),('US-FL','region',NULL),('US-TX','region',NULL),
    ('US-FL-001','region',NULL),('L1','hotspot','US-FL-001'),
    ('L2','hotspot','US-FL'),('L3','hotspot','CA'),
    ('L4','hotspot','FR-IDF'),('L5','hotspot',NULL),
    ('AQ','region',NULL),('ZZ','region',NULL);
  INSERT INTO species_month_freq VALUES
    ('US','a',1,1),('US-FL','a',1,1),('US-FL','a',12,1),
    ('US-FL-001','b',6,1),('L1','a',3,1),('L2','c',12,1),
    ('US-TX','b',4,1),('US-TX','d',6,0),('L3','d',1,1),
    ('L4','a',1,1),('L5','d',1,1),('L5','e',12,1),('US-FL','slash',1,1),('ZZ','b',1,1);
`;

const published = async () =>
  (
    await mocked.active.query<{
      counts: unknown;
      source_revision: string | null;
      built_at: Date | null;
      build_ms: number | null;
      last_error: string | null;
      consecutive_failures: number;
      source_changed_at: Date | null;
    }>("SELECT * FROM species_count_snapshot WHERE id = 1")
  ).rows[0];

describe("species-count snapshot (real SQL, isolated temporary tables)", () => {
  let client: pg.Client;
  beforeAll(async () => {
    requireTestDb();
    client = await connect();
    mocked.active = client;
    // `jobs` is shadowed too, so the "loads queued" check and the page's
    // refresh-active probe read only rows this suite writes.
    await client.query(`${TEMP_TABLES}
      CREATE TEMP TABLE jobs (id serial, type text, status text, dedup_key text,
        cancel_requested boolean DEFAULT false, next_retry_at timestamptz);
      ${FIXTURE}`);
  });
  afterAll(async () => {
    await client?.end();
  });
  beforeEach(() => {
    mocked.active = client;
    mocked.calls.length = 0;
    mocked.failAggregate = null;
    mocked.afterSnapshot = null;
  });

  /** The published counts equal the existing aggregate on the same data. */
  async function expectParity() {
    const view = await readSpeciesCountSnapshot();
    expect(view.counts).toEqual(await aggregateSpeciesCounts());
    return view.counts!;
  }
  /** Force the next refresh past the max age, so it builds regardless of activity. */
  const ageSnapshot = () =>
    client.query(
      "UPDATE species_count_snapshot SET built_at = built_at - interval '2 hours'",
    );

  it("no snapshot: the page sees no counts (never zero) and no refresh is assumed", async () => {
    const view = await readSpeciesCountSnapshot();
    expect(view).toMatchObject({
      counts: null,
      builtAt: null,
      failing: false,
      sourceChanged: false,
      refreshActive: false,
    });
    expect(mocked.calls).toHaveLength(1);
  });

  it("first refresh builds and publishes the exact aggregate: overlap, child-only evidence, other, unassigned world-only", async () => {
    const outcome = await refreshSpeciesCountSnapshot();
    expect(outcome).toMatchObject({
      outcome: "published",
      reason: "first",
      current: true,
      delayMs: SPECIES_COUNT_CHECK_MS,
    });
    const row = await published();
    expect(row.source_revision).toBe(
      (outcome as { revision: string }).revision,
    );
    expect(row.build_ms).toBeGreaterThanOrEqual(0);
    expect(row).toMatchObject({
      consecutive_failures: 0,
      last_error: null,
      source_changed_at: null,
    });
    const totals = await expectParity();
    expect(totals.regions["US-FL"]).toBe(3);
    expect(totals.regions["US-TX"]).toBe(1);
    expect(totals.regions.US).toBe(3);
    expect(totals.regions.CA).toBe(1);
    expect(totals.regions["FR-IDF"]).toBe(1);
    expect(totals.areas["north-america"]).toBe(4);
    expect(totals.areas.europe).toBe(1);
    expect(totals.areas.other).toBe(1);
    // 'a' occurs in both North America and Europe; 'e' exists only at an
    // unassigned hotspot. Count each worldwide, without inventing geography.
    expect(totals.world).toBe(5);
    expect(Object.values(totals.areas).reduce((a, b) => a + b, 0)).toBe(6);
    // A loaded region with no species is a counted zero; an unloaded one is absent.
    expect(totals.regions.AQ).toBe(0);
    expect(totals.areas.antarctica).toBe(0);
    expect(totals.regions.NO).toBeUndefined();
    expect(totals.regions.L5).toBeUndefined();
  });

  it("unchanged revision: no rebuild — the run reads its state and nothing else", async () => {
    const outcome = await refreshSpeciesCountSnapshot();
    expect(outcome).toMatchObject({
      outcome: "unchanged",
      delayMs: SPECIES_COUNT_CHECK_MS,
    });
    expect(mocked.calls).toHaveLength(1);
    expect(mocked.calls.some((t) => t.includes("GROUPING SETS"))).toBe(false);
  });

  it("changed + quiet: rebuilds (a new species at a loaded state)", async () => {
    await client.query(`INSERT INTO species_month_freq VALUES ('US-FL','d',1,1);
      UPDATE frequency_fetch SET fetched_at = now() - interval '10 minutes' WHERE loc_code = 'US-FL'`);
    expect(await refreshSpeciesCountSnapshot()).toMatchObject({
      outcome: "published",
      reason: "quiet",
    });
    expect((await expectParity()).regions["US-FL"]).toBe(4);
  });

  it("changed + recent write + young snapshot: defers, says the source changed, keeps the counts", async () => {
    const before = await published();
    await client.query(`DELETE FROM frequency_fetch WHERE loc_code = 'L2';
      UPDATE frequency_fetch SET fetched_at = now() - interval '2 minutes' WHERE loc_code = 'US-FL'`);
    const outcome = await refreshSpeciesCountSnapshot();
    expect(outcome.outcome).toBe("deferred");
    // Look again when the 5-minute quiet period ends (~3 min), within bounds.
    const delay = (outcome as { delayMs: number }).delayMs;
    expect(delay).toBeGreaterThan(2 * 60_000);
    expect(delay).toBeLessThanOrEqual(3 * 60_000);
    expect(mocked.calls.some((t) => t.includes("GROUPING SETS"))).toBe(false);
    const row = await published();
    expect(row.source_changed_at).not.toBeNull();
    expect(row.counts).toEqual(before.counts);
    expect(row.source_revision).toBe(before.source_revision);
    const view = await readSpeciesCountSnapshot();
    expect(view.sourceChanged).toBe(true);
    expect(view.refreshActive).toBe(false);
  });

  it("changed + old snapshot: rebuilds despite activity (location deletion)", async () => {
    await ageSnapshot();
    expect(await refreshSpeciesCountSnapshot()).toMatchObject({
      outcome: "published",
      reason: "max_age",
    });
    expect((await published()).source_changed_at).toBeNull();
    expect((await expectParity()).regions["US-FL"]).toBe(3);
  });

  it("a queued frequency load goes first: quiet data still defers until the max age", async () => {
    await client.query(`UPDATE frequency_fetch SET region_code = 'US-TX' WHERE loc_code = 'L3';
      UPDATE frequency_fetch SET fetched_at = now() - interval '30 minutes'`);
    const job = await client.query<{ id: number }>(
      `INSERT INTO jobs (type, status) VALUES ('load_region', 'pending') RETURNING id`,
    );
    expect(await refreshSpeciesCountSnapshot()).toMatchObject({
      outcome: "deferred",
      loadsQueued: true,
    });
    await ageSnapshot();
    expect(await refreshSpeciesCountSnapshot()).toMatchObject({
      outcome: "published",
      reason: "max_age",
    });
    await client.query("DELETE FROM jobs WHERE id = $1", [job.rows[0].id]);
    // Geography repair: the hotspot's species moves from Canada to Texas.
    const moved = await expectParity();
    expect(moved.regions["US-TX"]).toBe(2);
    expect(moved.regions.CA).toBeUndefined();
  });

  it("taxonomy reclassification and a monthly numerator becoming zero", async () => {
    await client.query(`UPDATE taxonomy_cache SET category = 'slash' WHERE species_code = 'd';
      UPDATE species_month_freq SET num = 0 WHERE loc_code = 'ZZ';
      UPDATE frequency_fetch SET fetched_at = now() - interval '20 minutes' WHERE loc_code = 'ZZ'`);
    expect(await refreshSpeciesCountSnapshot()).toMatchObject({
      outcome: "published",
      reason: "quiet",
    });
    const totals = await expectParity();
    expect(totals.regions["US-FL"]).toBe(2);
    expect(totals.regions.ZZ).toBe(0);
  });

  it("a failed build keeps the last good counts, records the error and backs off; success clears it", async () => {
    const good = await published();
    await client.query(
      `UPDATE frequency_fetch SET fetched_at = now() - interval '15 minutes' WHERE loc_code = 'US'`,
    );
    mocked.failAggregate = new Error(
      "canceling statement due to statement timeout",
    );
    const first = await refreshSpeciesCountSnapshot();
    expect(first).toEqual({
      outcome: "failed",
      error: "canceling statement due to statement timeout",
      consecutiveFailures: 1,
      delayMs: SPECIES_COUNT_FAILURE_BASE_MS,
    });
    let row = await published();
    expect(row.counts).toEqual(good.counts);
    expect(row.source_revision).toBe(good.source_revision);
    expect(row.built_at).toEqual(good.built_at);
    expect(row.last_error).toBe("canceling statement due to statement timeout");
    const view = await readSpeciesCountSnapshot();
    expect(view.failing).toBe(true);
    expect(view.counts).toEqual(good.counts);

    mocked.failAggregate = new Error("second failure");
    expect(await refreshSpeciesCountSnapshot()).toMatchObject({
      outcome: "failed",
      consecutiveFailures: 2,
      delayMs: 2 * SPECIES_COUNT_FAILURE_BASE_MS,
    });

    expect(await refreshSpeciesCountSnapshot()).toMatchObject({
      outcome: "published",
    });
    row = await published();
    expect(row).toMatchObject({ consecutive_failures: 0, last_error: null });
    await expectParity();
  });

  it("a write committed after the build's snapshot leaves the published revision stale; the next run rebuilds", async () => {
    const build = await buildSpeciesCountSnapshot();
    // Commits after the build read its snapshot, before it publishes.
    await client.query(`INSERT INTO species_month_freq VALUES ('L4','b',2,1);
      UPDATE frequency_fetch SET fetched_at = now() - interval '6 minutes' WHERE loc_code = 'L4'`);
    expect(await publishSpeciesCountSnapshot(build)).toEqual({
      written: true,
      current: false,
    });
    const row = await published();
    expect(row.source_revision).toBe(build.revision);
    // The newer counts are published, but never labelled current.
    expect(row.source_changed_at).not.toBeNull();
    expect(
      (row.counts as { regions: Record<string, number> }).regions["FR-IDF"],
    ).toBe(1);
    expect(await refreshSpeciesCountSnapshot()).toMatchObject({
      outcome: "published",
      reason: "quiet",
    });
    expect((await expectParity()).regions["FR-IDF"]).toBe(2);
  });

  it("CODEX1 P2: a load that began before the build and commits during it (fetched_at <= built_at) is never labelled current", async () => {
    await client.query(`INSERT INTO jobs (type, status, dedup_key)
      VALUES ('refresh_species_counts', 'running', 'refresh_species_counts:global')`);
    // A change to trigger a build, forced past the max age so it runs now.
    await client.query(
      "UPDATE frequency_fetch SET fetched_at = now() - interval '20 minutes' WHERE loc_code = 'US'",
    );
    await ageSnapshot();
    const before = await readSpeciesCountSnapshot();
    expect(before.counts!.regions["FR-IDF"]).toBe(2);
    let commitStamp = "";
    mocked.afterSnapshot = async () => {
      // storeFrequencies stamps fetched_at with its transaction's start time:
      // earlier than the build's snapshot, committed after it.
      const r = await client.query<{ t: string }>(`
        INSERT INTO species_month_freq VALUES ('L4','c',5,1);
        UPDATE frequency_fetch SET fetched_at = now() - interval '10 minutes'
         WHERE loc_code = 'L4' RETURNING fetched_at::text AS t`);
      commitStamp = (r as unknown as { rows: { t: string }[] }[])[1].rows[0].t;
    };
    const outcome = await refreshSpeciesCountSnapshot();
    expect(outcome).toMatchObject({
      outcome: "published",
      reason: "max_age",
      current: false,
      delayMs: SPECIES_COUNT_QUIET_MS,
    });
    const row = await published();
    expect(new Date(commitStamp).getTime()).toBeLessThan(
      new Date(row.built_at!).getTime(),
    );
    // The probe cannot see it (fetched_at <= built_at); the kept flag does.
    expect(
      (
        await client.query(
          "SELECT 1 FROM frequency_fetch WHERE fetched_at > $1",
          [row.built_at],
        )
      ).rowCount,
    ).toBe(0);
    expect(row.source_changed_at).not.toBeNull();
    const view = await readSpeciesCountSnapshot();
    expect(view.counts!.regions["FR-IDF"]).toBe(2); // 'c' missing: built before it
    expect(view.sourceChanged).toBe(true);
    expect(
      speciesCountStatus({ ...view, hasCounts: view.counts != null }).state,
    ).toBe("updating");
    // The next run (quiet: the write is 10 minutes old) rebuilds and is current.
    expect(await refreshSpeciesCountSnapshot()).toMatchObject({
      outcome: "published",
      reason: "quiet",
      current: true,
    });
    expect((await published()).source_changed_at).toBeNull();
    expect((await expectParity()).regions["FR-IDF"]).toBe(3);
    await client.query(
      "DELETE FROM jobs WHERE type = 'refresh_species_counts'",
    );
  });

  it("CODEX1 P2: a taxonomy-only change during the build is detected the same way", async () => {
    await client.query(
      "UPDATE frequency_fetch SET fetched_at = now() - interval '25 minutes' WHERE loc_code = 'US'",
    );
    await ageSnapshot();
    mocked.afterSnapshot = () =>
      client.query(
        "UPDATE taxonomy_cache SET category = 'species' WHERE species_code = 'slash'",
      );
    expect(await refreshSpeciesCountSnapshot()).toMatchObject({
      outcome: "published",
      current: false,
    });
    expect((await published()).source_changed_at).not.toBeNull();
    expect((await readSpeciesCountSnapshot()).sourceChanged).toBe(true);
    expect(await refreshSpeciesCountSnapshot()).toMatchObject({
      outcome: "published",
      current: true,
    });
    expect((await expectParity()).regions["US-FL"]).toBe(3);
    await client.query(
      "UPDATE taxonomy_cache SET category = 'slash' WHERE species_code = 'slash'",
    );
    await refreshSpeciesCountSnapshot();
  });

  it("never replaces a newer published build with an older one", async () => {
    const older = await buildSpeciesCountSnapshot();
    const newer = await buildSpeciesCountSnapshot();
    expect(await publishSpeciesCountSnapshot(newer)).toEqual({
      written: true,
      current: true,
    });
    expect((await publishSpeciesCountSnapshot(older)).written).toBe(false);
    expect(new Date((await published()).built_at!).toISOString()).toBe(
      newer.builtAt,
    );
  });

  it("the page's read: counts, build time, and whether the refresh job is queued", async () => {
    await client.query(`INSERT INTO jobs (type, status, dedup_key)
      VALUES ('refresh_species_counts', 'pending', 'refresh_species_counts:global')`);
    mocked.calls.length = 0;
    const view = await readSpeciesCountSnapshot();
    expect(mocked.calls).toHaveLength(1);
    expect(mocked.calls[0]).not.toMatch(/GROUPING SETS|md5|species_month_freq/);
    expect(view.refreshActive).toBe(true);
    expect(view.builtAt).toBe(
      new Date((await published()).built_at!).toISOString(),
    );
    expect(view.failing).toBe(false);
    expect(view.sourceChanged).toBe(false);
    // A load stamped after the build: the page says so without computing anything.
    await client.query(
      "UPDATE frequency_fetch SET fetched_at = now() WHERE loc_code = 'US'",
    );
    expect((await readSpeciesCountSnapshot()).sourceChanged).toBe(true);
    await client.query(
      "DELETE FROM jobs WHERE type = 'refresh_species_counts'",
    );
  });

  it("an empty inventory publishes a worldwide zero, not a missing count", async () => {
    await client.query("DELETE FROM frequency_fetch");
    expect(await refreshSpeciesCountSnapshot()).toMatchObject({
      outcome: "published",
      reason: "quiet",
    });
    expect(await expectParity()).toEqual({ areas: {}, regions: {}, world: 0 });
  });
});

describe("refreshDecision (pure cadence)", () => {
  const now = Date.parse("2026-10-10T15:00:00Z");
  const base: RefreshState = {
    nowMs: now,
    newestWriteMs: now - 60 * 60_000,
    revision: "r2",
    loadsQueued: false,
    published: { revision: "r1", builtAtMs: now - 20 * 60_000 },
  };
  it("first build, unchanged, quiet, max age, loads queued", () => {
    expect(refreshDecision({ ...base, published: null })).toEqual({
      action: "build",
      reason: "first",
    });
    expect(refreshDecision({ ...base, revision: "r1" })).toEqual({
      action: "unchanged",
      delayMs: SPECIES_COUNT_CHECK_MS,
    });
    expect(refreshDecision(base)).toEqual({ action: "build", reason: "quiet" });
    expect(refreshDecision({ ...base, newestWriteMs: null })).toEqual({
      action: "build",
      reason: "quiet",
    });
    expect(
      refreshDecision({
        ...base,
        newestWriteMs: now,
        published: {
          revision: "r1",
          builtAtMs: now - SPECIES_COUNT_MAX_AGE_MS,
        },
      }),
    ).toEqual({ action: "build", reason: "max_age" });
    expect(refreshDecision({ ...base, loadsQueued: true })).toEqual({
      action: "defer",
      delayMs: SPECIES_COUNT_DEFER_MAX_MS,
    });
  });
  it("defers until the quiet period ends, bounded, and never past the max age", () => {
    expect(refreshDecision({ ...base, newestWriteMs: now - 60_000 })).toEqual({
      action: "defer",
      delayMs: SPECIES_COUNT_QUIET_MS - 60_000,
    });
    expect(
      refreshDecision({
        ...base,
        newestWriteMs: now - SPECIES_COUNT_QUIET_MS + 5_000,
      }),
    ).toEqual({
      action: "defer",
      delayMs: SPECIES_COUNT_DEFER_MIN_MS,
    });
    expect(
      refreshDecision({
        ...base,
        newestWriteMs: now,
        published: {
          revision: "r1",
          builtAtMs: now - SPECIES_COUNT_MAX_AGE_MS + 90_000,
        },
      }),
    ).toEqual({ action: "defer", delayMs: 90_000 });
  });
  it("failure backoff doubles from 5 minutes and stops at an hour", () => {
    expect([1, 2, 3, 4, 5, 6, 50].map(failureBackoffMs)).toEqual(
      [5, 10, 20, 40, 60, 60, 60].map((m) => m * 60_000),
    );
    expect(failureBackoffMs(99)).toBe(SPECIES_COUNT_FAILURE_MAX_MS);
  });
});

describe("publishing under a stale claim writes nothing (real jobs table, owned fixtures)", () => {
  const RUN = `${process.pid.toString(36)}${Date.now().toString(36).slice(-6)}`;
  let client: pg.Client;
  let userId = 0;
  let jobId = 0;
  beforeAll(async () => {
    requireTestDb();
    client = await connect();
    mocked.active = client;
    await client.query(`${TEMP_TABLES}${FIXTURE}`);
    userId = (
      await client.query<{ id: number }>(
        `INSERT INTO users (username, display_name, password_hash, role)
         VALUES ($1, 'Species count fixture', '!unset', 'admin') RETURNING id`,
        [`sctest-${RUN}`],
      )
    ).rows[0].id;
    // No dedup key: never collides with the real singleton's key.
    jobId = (
      await client.query<{ id: number }>(
        `INSERT INTO jobs (type, payload, requested_by, label, max_attempts, next_retry_at)
         VALUES ('refresh_species_counts', '{}', $1, $2, 1, now() + interval '1 day') RETURNING id`,
        [userId, `SCTEST ${RUN}`],
      )
    ).rows[0].id;
  });
  afterAll(async () => {
    try {
      if (jobId) await client.query("DELETE FROM jobs WHERE id = $1", [jobId]);
      if (userId)
        await client.query("DELETE FROM users WHERE id = $1", [userId]);
    } finally {
      await client?.end();
    }
  });
  beforeEach(() => {
    mocked.active = client;
  });

  /** Claim OUR row by id, exactly as claimNextJob does; never an unscoped claim. */
  const claim = async () =>
    (
      await client.query<{ id: number; claim_seq: string; attempts: number }>(
        `UPDATE jobs SET status = 'running', started_at = NOW(), attempts = attempts + 1,
                heartbeat_at = NOW(), claim_seq = claim_seq + 1
          WHERE id = $1 AND status = 'pending' RETURNING id, claim_seq::text, attempts`,
        [jobId],
      )
    ).rows[0];

  it("an old claim's publish and refresh are refused and leave no row; the live claim publishes", async () => {
    const a = await claim();
    expect(a).toBeDefined();
    // A startup reclaim + new claim: A is now stale.
    await client.query(
      `UPDATE jobs SET status = 'pending', next_retry_at = now() + interval '1 day' WHERE id = $1`,
      [jobId],
    );
    const b = await claim();
    const build = await buildSpeciesCountSnapshot();
    const refused = await runWithClaim(a, () =>
      publishSpeciesCountSnapshot(build),
    ).catch((e: unknown) => e);
    expect(isStaleClaim(refused)).toBe(true);
    const refusedRefresh = await runWithClaim(a, () =>
      refreshSpeciesCountSnapshot(),
    ).catch((e: unknown) => e);
    expect(isStaleClaim(refusedRefresh)).toBe(true);
    expect(
      (await client.query("SELECT 1 FROM species_count_snapshot")).rowCount,
    ).toBe(0);

    expect(
      await runWithClaim(b, () => publishSpeciesCountSnapshot(build)),
    ).toEqual({ written: true, current: true });
    expect(
      (await client.query("SELECT source_revision FROM species_count_snapshot"))
        .rows[0].source_revision,
    ).toBe(build.revision);
  });
});
