/**
 * td-6093ae: a taxonomy refresh run records "applied" INSIDE the replacement
 * transaction, after the new taxonomy is written and re-derived, so the run
 * and the installed taxonomy can never disagree. The tag engine is replaced
 * here: no test rewrites the shared taxonomy_cache.
 */
import { describe, expect, it, vi } from "vitest";

const events: string[] = [];
const fakeTx = {
  exec: vi.fn(async (text: string) => {
    events.push(`exec:${text.trim().split(/\s+/).slice(0, 2).join(" ")}`);
    return { rows: [{ lexicon_hash: "h1" }] };
  }),
  client: {
    query: vi.fn(async (text: string) => {
      events.push(`client:${text.trim().split(/\s+/).slice(0, 2).join(" ")}`);
      return { rows: [] };
    }),
  },
};

vi.mock("$server/tag-engine/runtime", () => ({
  withTagWriteTx: vi.fn(async (_mode: string, _key: string, _entry: string, fn: (tx: unknown) => Promise<unknown>) => {
    events.push("tx:begin");
    try {
      const out = await fn(fakeTx);
      events.push("tx:commit");
      return out;
    } catch (err) {
      events.push("tx:rollback");
      throw err;
    }
  }),
}));
vi.mock("$server/tag-engine/materialize", () => ({
  lexiconFor: vi.fn(async () => {
    events.push("lexicon");
    return { hash: "h1" };
  }),
  materializeMany: vi.fn(async () => {
    events.push("materialize");
  }),
}));
vi.mock("$server/tag-engine/repair", () => ({ beginTagRepair: vi.fn() }));

const { replaceTaxonomy } = await import("./taxonomy-sync");

const payload = [{ speciesCode: "x1", comName: "Bird", sciName: "Avis", category: "species" }];

describe("replaceTaxonomy onApplied (td-6093ae)", () => {
  it("runs last inside the replacement transaction, on its transaction", async () => {
    events.length = 0;
    const seen: unknown[] = [];
    await replaceTaxonomy(payload, 7, {
      onApplied: async (tx) => {
        seen.push(tx);
        events.push("applied");
      },
    });
    expect(seen).toEqual([fakeTx]);
    const applied = events.indexOf("applied");
    expect(applied).toBeGreaterThan(events.indexOf("client:INSERT INTO"));
    expect(applied).toBeGreaterThan(events.indexOf("lexicon"));
    expect(events.at(-1)).toBe("tx:commit");
    expect(events.indexOf("tx:commit")).toBe(applied + 1);
  });

  it("a failing onApplied aborts the replacement", async () => {
    events.length = 0;
    await expect(
      replaceTaxonomy(payload, 7, {
        onApplied: async () => {
          throw new Error("could not record applied");
        },
      }),
    ).rejects.toThrow("could not record applied");
    expect(events.at(-1)).toBe("tx:rollback");
    expect(events).not.toContain("tx:commit");
  });

  it("works unchanged without a hook", async () => {
    events.length = 0;
    await expect(replaceTaxonomy(payload, 7)).resolves.toBe(1);
    expect(events.at(-1)).toBe("tx:commit");
  });
});
