/**
 * td-877997 (CODEX1): timing-sensitive rules of the hotspot search index, on a
 * mocked database so the test decides exactly when a build's reads happen.
 * - A search that must wait for the owner's load gets an index that has it,
 *   even when a list-only rebuild that read the data BEFORE the load was
 *   already running.
 * - When a sibling read fails, the list cursor stops and closes before the
 *   build fails, so a second build never runs a cursor beside it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  listsRev: "L0",
  freq: [] as Record<string, unknown>[],
  /** While set, the loaded-rows read captures the rows, then waits for release(). */
  hold: null as null | { release: () => void; promise: Promise<void> },
  failFreq: false,
  cursorsOpen: 0,
  maxCursors: 0,
  fetches: 0,
  endlessCursor: false,
}));

vi.mock("$lib/db", async (importOriginal) => {
  const real = await importOriginal<typeof import("$lib/db")>();
  const rows = (r: unknown[]) => ({ rows: r, rowCount: r.length });
  return {
    ...real,
    query: vi.fn(async (sql: string) => {
      if (sql.includes(") AS lists")) return rows([{ lists: db.listsRev, loaded: JSON.stringify(db.freq) }]);
      if (/^\s*SELECT loc_code, loc_kind, loc_name, region_code, begin_year, end_year, n_species\s+FROM frequency_fetch/.test(sql)) {
        const read = db.freq.map((r) => ({ ...r }));
        if (db.hold) await db.hold.promise;
        if (db.failFreq) throw new Error("frequency_fetch read failed");
        return rows(read);
      }
      return rows([]);
    }),
    withReadSnapshot: vi.fn(async (fn: (client: unknown) => Promise<unknown>) => {
      db.cursorsOpen += 1;
      db.maxCursors = Math.max(db.maxCursors, db.cursorsOpen);
      try {
        return await fn({
          query: async (sql: string) => {
            if (!sql.startsWith("FETCH")) return rows([]);
            db.fetches += 1;
            await new Promise((r) => setImmediate(r));
            return db.endlessCursor ? rows([{ ids: [], names: [], lats: [], lngs: [], s1: [], s2: [], cc: [] }]) : rows([]);
          },
        });
      } finally {
        db.cursorsOpen -= 1;
      }
    }),
  };
});

vi.mock("$server/regions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("$server/regions")>()),
  allReferenceRegions: vi.fn(async () => []),
}));

const { __hubIndexForTests, __resetDiscoveryCacheForTests, hubDiscover } = await import("$server/hub-discovery");

const county = (code: string, name: string) => ({
  loc_code: code,
  loc_kind: "region",
  loc_name: name,
  region_code: "US-FL",
  begin_year: 2015,
  end_year: 2024,
  n_species: 7,
});
const ids = async (find: string) =>
  (await hubDiscover({ mode: "typed", find, submitted: find, page: 1 } as Parameters<typeof hubDiscover>[0])).results.map((r) => r.id);

function holdLoadedReads() {
  let release!: () => void;
  const promise = new Promise<void>((r) => (release = r));
  db.hold = { release, promise };
}

describe("hotspot search index timing (td-877997)", () => {
  beforeEach(() => {
    __resetDiscoveryCacheForTests();
    Object.assign(db, { listsRev: "L0", freq: [], hold: null, failFreq: false, cursorsOpen: 0, maxCursors: 0, fetches: 0, endlessCursor: false });
  });
  afterEach(() => __resetDiscoveryCacheForTests());

  it("a search that must wait gets the owner's load even if a rebuild that read older data was running", async () => {
    db.freq = [county("US-FL-Q11111", "Qzalpha County")];
    expect(await ids("Qzalpha")).toContain("US-FL-Q11111");

    // eBird's lists change: the search answers from the current index; a rebuild starts and reads the loaded rows...
    db.listsRev = "L1";
    holdLoadedReads();
    expect(await ids("Qzalpha")).toContain("US-FL-Q11111");
    const running = __hubIndexForTests().building;
    expect(running).toBeDefined();
    await new Promise((r) => setImmediate(r));

    // ...then the owner's load lands, and a search for it must wait for an index that has it.
    db.freq = [...db.freq, county("US-FL-Q22222", "Qzbravo County")];
    const searching = ids("Qzbravo");
    const hold = db.hold!;
    db.hold = null;
    hold.release();
    expect(await searching).toContain("US-FL-Q22222");
    expect(__hubIndexForTests().builds).toBe(3);
  });

  it("stops and closes the list cursor before a build fails on a sibling read, and the next build runs alone", async () => {
    db.endlessCursor = true;
    db.failFreq = true;
    holdLoadedReads();
    const failing = ids("Qzalpha");
    // Let the cursor run a few batches, then fail the sibling read.
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    db.hold!.release();
    await expect(failing).rejects.toThrow("frequency_fetch read failed");
    expect(db.cursorsOpen).toBe(0);
    const fetchesAtFailure = db.fetches;
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    expect(db.fetches).toBe(fetchesAtFailure);

    db.failFreq = false;
    db.hold = null;
    db.endlessCursor = false;
    db.freq = [county("US-FL-Q11111", "Qzalpha County")];
    expect(await ids("Qzalpha")).toContain("US-FL-Q11111");
    expect(db.maxCursors).toBe(1);
  });
});
