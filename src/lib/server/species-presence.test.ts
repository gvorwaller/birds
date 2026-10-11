/**
 * td-7162f6 (CODEX1 P2-1): the Hotspots & data totals cache is keyed by the
 * database's presence version. A computation that started before a newer
 * version committed must never satisfy a request for the newer version, and
 * an older result must never overwrite a newer cached one.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  version: "1",
  /** Each withReadSnapshot call takes the next queued snapshot (version + gate). */
  snapshots: [] as { version: string; gate: Promise<void> }[],
  computes: 0,
}));

vi.mock("$lib/db", () => ({
  query: vi.fn(async () => ({ rows: [{ version: db.version }] })),
  withReadSnapshot: vi.fn(async (fn: (c: unknown) => Promise<unknown>) => {
    db.computes++;
    const snap = db.snapshots.shift() ?? { version: db.version, gate: Promise.resolve() };
    await snap.gate;
    const client = {
      query: async (text: string) => {
        if (text.includes("FROM species_presence_state")) return { rows: [{ version: snap.version }] };
        if (text.includes("NOT EXISTS (SELECT 1 FROM species_location_membership")) return { rows: [] };
        // presenceCounts: world total tagged with the snapshot's version.
        return { rows: [{ kind: "world", code: "world", n: Number(snap.version) * 100 }] };
      },
    };
    return fn(client);
  }),
}));

const { readSpeciesTotals, __resetSpeciesTotalsCacheForTests } = await import("./species-presence");

function gate() {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
}

beforeEach(() => {
  __resetSpeciesTotalsCacheForTests();
  db.version = "1";
  db.snapshots = [];
  db.computes = 0;
});

describe("readSpeciesTotals cache (td-7162f6)", () => {
  it("computes once per version; an unchanged version is a 1-row read", async () => {
    expect((await readSpeciesTotals()).counts?.world).toBe(100);
    expect((await readSpeciesTotals()).counts?.world).toBe(100);
    expect(db.computes).toBe(1);
    db.version = "2";
    expect((await readSpeciesTotals()).counts?.world).toBe(200);
    expect(db.computes).toBe(2);
  });

  it("concurrent misses for the same version share one computation", async () => {
    const g = gate();
    db.snapshots.push({ version: "1", gate: g.p });
    const a = readSpeciesTotals();
    const b = readSpeciesTotals();
    g.open();
    expect((await a).counts?.world).toBe(100);
    expect((await b).counts?.world).toBe(100);
    expect(db.computes).toBe(1);
  });

  it("a request for V2 never accepts an in-flight V1 computation", async () => {
    const g1 = gate();
    db.snapshots.push({ version: "1", gate: g1.p }, { version: "2", gate: Promise.resolve() });
    const a = readSpeciesTotals(); // reads V1, starts the V1 snapshot
    await Promise.resolve();
    db.version = "2"; // a load commits
    const b = readSpeciesTotals(); // reads V2, finds V1 in flight
    g1.open();
    expect((await a).counts?.world).toBe(100);
    expect((await b).counts?.world).toBe(200);
    // The cache now holds V2: a further V2 read computes nothing.
    const before = db.computes;
    expect((await readSpeciesTotals()).counts?.world).toBe(200);
    expect(db.computes).toBe(before);
  });

  it("an older result finishing late never overwrites a newer cached one", async () => {
    db.version = "3";
    expect((await readSpeciesTotals()).counts?.world).toBe(300);
    // A stale computation (snapshot V2) resolving afterwards must not win.
    __resetSpeciesTotalsCacheForTests();
    expect((await readSpeciesTotals()).counts?.world).toBe(300);
    const g = gate();
    db.snapshots.push({ version: "2", gate: g.p });
    db.version = "2"; // a request that read an older version (replica lag style)
    const late = readSpeciesTotals();
    g.open();
    // It got the newer cached result, not its own older snapshot.
    expect((await late).counts?.world).toBe(300);
    db.version = "3";
    expect((await readSpeciesTotals()).counts?.world).toBe(300);
  });

  it("a read failure reports totals unavailable instead of throwing", async () => {
    const { query } = await import("$lib/db");
    vi.mocked(query).mockRejectedValueOnce(new Error("connection reset"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await readSpeciesTotals()).toEqual({ counts: null, unavailable: [] });
    err.mockRestore();
  });
});
