import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { env } from "$env/dynamic/private";

const mocked = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("$lib/db", () => ({ query: mocked.query }));
import { loadedSpeciesCounts } from "./loaded-species-counts";

describe("loaded species totals (real SQL, isolated temporary tables)", () => {
  let client: pg.Client;
  beforeAll(async () => {
    if (
      env.PGHOST !== "127.0.0.1" ||
      env.PGPORT !== "15436" ||
      env.PGDATABASE !== "birds_test"
    ) {
      throw new Error("Requires the dedicated local test database");
    }
    client = new pg.Client({
      host: env.PGHOST,
      port: Number(env.PGPORT),
      database: env.PGDATABASE,
      user: env.PGUSER,
      password: env.PGPASSWORD,
    });
    await client.connect();
    mocked.query.mockImplementation((sql, params) => client.query(sql, params));
    // pg_temp shadows only this connection; production-sized restored tables
    // stay untouched. Tests exercise PostgreSQL grouping, not SQL-shaped mocks.
    await client.query(`
      CREATE TEMP TABLE frequency_fetch (loc_code text, loc_kind text, region_code text,
        fetched_at timestamptz DEFAULT now(), n_species int DEFAULT 0);
      CREATE TEMP TABLE taxonomy_cache (species_code text, category text);
      CREATE TEMP TABLE species_month_freq (loc_code text, species_code text, month int, num float8);
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
    `);
  });
  afterAll(async () => {
    await client?.end();
  });

  it("deduplicates seasons, counties and hotspots; keeps child-only evidence and excludes zero/non-species", async () => {
    const totals = await loadedSpeciesCounts();
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
    expect(totals.regions.AQ).toBe(0);
    expect(totals.areas.antarctica).toBe(0);
    expect(totals.regions.NO).toBeUndefined();
    expect(totals.regions.L5).toBeUndefined();
  });

  it("reuses the aggregate when source data is unchanged", async () => {
    mocked.query.mockClear();
    const totals = await loadedSpeciesCounts();
    expect(totals.regions.US).toBe(3);
    expect(mocked.query).toHaveBeenCalledTimes(1); // revision check only
  });

  it("invalidates on refresh, deletion, geography repair, and taxonomy changes", async () => {
    await client.query(`INSERT INTO species_month_freq VALUES ('US-FL','d',1,1);
      UPDATE frequency_fetch SET fetched_at=fetched_at+interval '1 second' WHERE loc_code='US-FL'`);
    expect((await loadedSpeciesCounts()).regions["US-FL"]).toBe(4);
    await client.query("DELETE FROM frequency_fetch WHERE loc_code='L2'");
    expect((await loadedSpeciesCounts()).regions["US-FL"]).toBe(3);
    await client.query(
      "UPDATE frequency_fetch SET region_code='US-TX' WHERE loc_code='L3'",
    );
    const moved = await loadedSpeciesCounts();
    expect(moved.regions["US-TX"]).toBe(2);
    expect(moved.regions.CA).toBeUndefined();
    await client.query(
      "UPDATE taxonomy_cache SET category='slash' WHERE species_code='d'",
    );
    expect((await loadedSpeciesCounts()).regions["US-FL"]).toBe(2);
  });

  it("shares an aggregate across concurrent page loads", async () => {
    await client.query(
      "UPDATE frequency_fetch SET fetched_at=fetched_at+interval '1 second'",
    );
    mocked.query.mockClear();
    const [a, b] = await Promise.all([
      loadedSpeciesCounts(),
      loadedSpeciesCounts(),
    ]);
    expect(a).toEqual(b);
    expect(mocked.query).toHaveBeenCalledTimes(3); // two revision checks, one aggregate
  });

  it("does not cache aggregate failures as zero and retries next time", async () => {
    await client.query(
      "UPDATE frequency_fetch SET fetched_at=fetched_at+interval '1 second'",
    );
    mocked.query
      .mockImplementationOnce((sql, params) => client.query(sql, params))
      .mockRejectedValueOnce(new Error("test query failure"));
    await expect(loadedSpeciesCounts()).rejects.toThrow("test query failure");
    expect((await loadedSpeciesCounts()).regions.US).toBe(2);
  });

  it("returns a worldwide zero for an empty inventory, not a missing count", async () => {
    await client.query("DELETE FROM frequency_fetch");
    expect(await loadedSpeciesCounts()).toEqual({
      areas: {},
      regions: {},
      world: 0,
    });
  });
});
