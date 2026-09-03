/**
 * Loader coverage for the ribbon's discriminated result (td-c6b113, CODEX1
 * P3 deploy-gate follow-up: "the loader's discriminated result was
 * source-review-only"). `$server/ribbon`'s `speciesRibbon` is mocked so both
 * branches of +page.server.ts's `.then(resolveFn, rejectFn)` wiring
 * (:131-143) can be driven directly — everything else in the loader runs
 * for real against the test DB, species-media.test.ts style.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$server/ribbon", async (importOriginal) => {
  const actual = await importOriginal<typeof import("$server/ribbon")>();
  return { ...actual, speciesRibbon: vi.fn() };
});

import { speciesRibbon } from "$server/ribbon";

const mockedSpeciesRibbon = vi.mocked(speciesRibbon);

const { query } = await import("$lib/db");
const { load } = await import("./+page.server");

const dbUp = await query("SELECT 1")
  .then(() => true)
  .catch(() => false);

function loadEvent(scopeId: number, code: string) {
  return {
    locals: { scopeId, user: { id: scopeId, role: "admin" } },
    params: { code },
    url: new URL(`http://localhost/species/${code}`),
  } as unknown as Parameters<typeof load>[0];
}

async function seedTaxon(code: string) {
  await query(
    `INSERT INTO taxonomy_cache (species_code, com_name, sci_name, category, family)
     VALUES ($1, 'Ribbon Loader Testbird', 'Testus loaderus', 'species', 'Testidae')
     ON CONFLICT (species_code) DO UPDATE SET category = 'species'`,
    [code],
  );
}

async function noKeyUserId(): Promise<number> {
  const r = await query<{ id: number }>(
    `SELECT u.id FROM users u
      WHERE NOT EXISTS (SELECT 1 FROM user_ebird ue WHERE ue.user_id = u.id)
      ORDER BY u.id LIMIT 1`,
  );
  return r.rows[0].id;
}

describe.runIf(dbUp)("species/[code] loader — ribbon discriminated result (td-c6b113)", () => {
  beforeEach(() => mockedSpeciesRibbon.mockReset());

  it("ribbon: {ok:true, grid:null} when speciesRibbon resolves with nothing loaded", async () => {
    const CODE = "rbldnul9";
    await seedTaxon(CODE);
    const uid = await noKeyUserId();
    mockedSpeciesRibbon.mockResolvedValue(null);
    try {
      const data = (await load(loadEvent(uid, CODE))) as unknown as {
        ribbon: { ok: boolean; grid: unknown };
      };
      expect(data.ribbon).toEqual({ ok: true, grid: null });
    } finally {
      await query("DELETE FROM taxonomy_cache WHERE species_code = $1", [CODE]);
    }
  });

  it("ribbon: {ok:false, error:'ribbon'} when speciesRibbon rejects — never plain absence", async () => {
    const CODE = "rbldbad9";
    await seedTaxon(CODE);
    const uid = await noKeyUserId();
    // A persistent mockImplementation() that throws makes vitest's own
    // internal test-runner bookkeeping invoke the mock a second, unrelated
    // time (confirmed via a stack-traced call log: one real call from
    // +page.server.ts's `.then(ok, err)` chain, one from deep inside
    // @vitest/runner's cleanup-hooks path) which then reports as an
    // unhandled rejection unrelated to the loader itself. A single-use
    // rejection sidesteps it while still exercising the real call.
    mockedSpeciesRibbon.mockRejectedValueOnce(new Error("boom"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const data = (await load(loadEvent(uid, CODE))) as unknown as {
        ribbon: { ok: boolean; error?: string };
      };
      expect(data.ribbon).toEqual({ ok: false, error: "ribbon" });
      expect(errorSpy).toHaveBeenCalledWith("[species] ribbon", expect.any(Error));
    } finally {
      errorSpy.mockRestore();
      await query("DELETE FROM taxonomy_cache WHERE species_code = $1", [CODE]);
    }
  });

  it("ribbon: {ok:true, grid} when speciesRibbon resolves with a grid", async () => {
    const CODE = "rbldok9";
    await seedTaxon(CODE);
    const uid = await noKeyUserId();
    const fakeGrid = { speciesCode: CODE } as unknown as Awaited<ReturnType<typeof speciesRibbon>>;
    mockedSpeciesRibbon.mockResolvedValue(fakeGrid);
    try {
      const data = (await load(loadEvent(uid, CODE))) as unknown as {
        ribbon: { ok: boolean; grid: unknown };
      };
      expect(data.ribbon).toEqual({ ok: true, grid: fakeGrid });
    } finally {
      await query("DELETE FROM taxonomy_cache WHERE species_code = $1", [CODE]);
    }
  });
});
