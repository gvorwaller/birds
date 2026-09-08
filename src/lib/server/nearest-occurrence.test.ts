import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { env } from "$env/dynamic/private";

const mocked = vi.hoisted(() => ({ queryTimed: vi.fn() }));
vi.mock("$lib/db", () => mocked);
import {
  nearestOccurrencePriorities,
  reportMonths,
} from "./nearest-occurrence";

describe("recent report months", () => {
  it("includes month and year boundaries, in UTC", () => {
    expect(reportMonths(Date.UTC(2026, 8, 20), 14)).toEqual([9]);
    expect(reportMonths(Date.UTC(2026, 8, 7), 14)).toEqual([8, 9]);
    expect(reportMonths(Date.UTC(2026, 0, 5), 14)).toEqual([12, 1]);
    expect(reportMonths(Date.UTC(2026, 2, 1), 30)).toEqual([1, 2, 3]);
  });
});

describe("occurrence evidence (real SQL, isolated temporary tables)", () => {
  let client: pg.Client;
  beforeAll(async () => {
    if (
      env.PGHOST !== "127.0.0.1" ||
      env.PGPORT !== "15436" ||
      env.PGDATABASE !== "birds_test"
    )
      throw new Error("Requires the dedicated local test database");
    client = new pg.Client({
      host: env.PGHOST,
      port: Number(env.PGPORT),
      database: env.PGDATABASE,
      user: env.PGUSER,
      password: env.PGPASSWORD,
    });
    await client.connect();
    mocked.queryTimed.mockImplementation((sql, params) =>
      client.query(sql, params),
    );
    // Session-local fixtures cannot change the restored dataset or other tests.
    await client.query(`
      CREATE TEMP TABLE frequency_fetch (loc_code text PRIMARY KEY, loc_kind text, n_unmatched int);
      CREATE TEMP TABLE species_month_freq (loc_code text, species_code text, month smallint, num float8,
        PRIMARY KEY (loc_code, species_code, month));
      CREATE TEMP TABLE loc_month_samples (loc_code text, month smallint, n float8, PRIMARY KEY (loc_code, month));
      INSERT INTO frequency_fetch VALUES
        ('season','region',0),('winter','region',0),('zero','region',0),
        ('unmatched','region',1),('partial','region',0),('no-samples','region',0),
        ('child-only-001','region',0),('hotspot','hotspot',0),('zero-numerator','region',0);
      INSERT INTO loc_month_samples
        SELECT loc_code, month, CASE WHEN loc_code='no-samples' OR (loc_code='partial' AND month=2) THEN 0 ELSE 100 END
        FROM frequency_fetch CROSS JOIN generate_series(1,12) month;
      INSERT INTO species_month_freq VALUES
        ('season','bird',9,0.001),('winter','bird',1,4),('zero','different-bird',9,5),
        ('child-only-001','bird',9,1),('hotspot','bird',9,1),('zero-numerator','bird',9,0);
    `);
  });
  afterAll(async () => {
    await client?.end();
  });

  it("distinguishes seasonal and annual positives from zero and unknown coverage", async () => {
    const codes = [
      "season",
      "winter",
      "zero",
      "unmatched",
      "partial",
      "no-samples",
      "missing",
      "zero-numerator",
    ];
    const result = await nearestOccurrencePriorities(
      codes,
      "bird",
      [8, 9],
      1000,
    );
    expect(Object.fromEntries(result)).toEqual({
      season: 0,
      winter: 1,
      zero: 3,
      unmatched: 2,
      partial: 2,
      "no-samples": 2,
      missing: 2,
      "zero-numerator": 3,
    });
    expect(mocked.queryTimed.mock.calls.at(-1)?.[2]).toBe(1000);
  });

  it("updates seasonal priority with the month and reads refreshed data without a stale cache", async () => {
    expect(
      (await nearestOccurrencePriorities(["winter"], "bird", [1], 1000)).get(
        "winter",
      ),
    ).toBe(0);
    await client.query(
      "INSERT INTO species_month_freq VALUES ('winter','bird',9,1)",
    );
    expect(
      (await nearestOccurrencePriorities(["winter"], "bird", [9], 1000)).get(
        "winter",
      ),
    ).toBe(0);
  });

  it("does not substitute a county, hotspot, or other species for a region's evidence", async () => {
    expect(
      Object.fromEntries(
        await nearestOccurrencePriorities(
          ["child-only", "hotspot", "zero"],
          "bird",
          [9],
          1000,
        ),
      ),
    ).toEqual({ "child-only": 2, hotspot: 2, zero: 3 });
  });

  it("does not query when there are no candidates", async () => {
    mocked.queryTimed.mockClear();
    expect(
      (await nearestOccurrencePriorities([], "bird", [9], 1000)).size,
    ).toBe(0);
    expect(mocked.queryTimed).not.toHaveBeenCalled();
  });
});
