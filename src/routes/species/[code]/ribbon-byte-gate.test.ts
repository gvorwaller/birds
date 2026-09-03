/**
 * SSR byte gate for the migration ribbon (td-c6b113, build spec TD-B
 * acceptance, CODEX1 P2-8): the serialised `ribbon` property must stay
 * <= 40 KB gzipped. Runs the REAL species page loader against the test DB
 * and gzips `devalue`'s output for `data.ribbon` alone — the ribbon is
 * awaited, not streamed, so it is a fully resolved value with no promises
 * devalue would need SvelteKit's transport machinery for.
 *
 * The spec names Rock Pigeon — the widest species in PRODUCTION — as the
 * target. This repo's local test cluster (`npm run test:db:up`) has no real
 * eBird coverage at all (frequency_fetch starts empty; only the worker
 * populates it, against a live API key), so production's actual widest
 * species can't be reproduced here. Per the spec's own fallback ("if the
 * fixture DB is too thin to be meaningful, gate on the fixture and say so"):
 * this test builds the widest species it can — one real, already-seeded
 * (0044) region per ribbon column, all 12 months non-zero — and gates on
 * that. It is a floor, not a proof of the true production worst case
 * (3,888 slots per P2-8's math) — see the td-c6b113 report.
 *
 * Every touched loc_code is real `regions` data (no new region is seeded —
 * td-b29d1c) but is NOT expected to carry real `frequency_fetch` rows on a
 * freshly migrated `birds_test` (this repo's normal local state). CODEX1
 * P2-1 deploy-gate finding: an earlier version HARD-FAILED when any of them
 * already had data (e.g. a prod-restored test DB, or another session's
 * fixture sharing this cluster) — never acceptable for a test that runs
 * against a cluster other sessions can be using at the same time. This
 * version is non-destructive: if any WIDE_CODES loc already has data, it
 * measures the widest species ALREADY loaded instead of touching it, and
 * only if there is truly nothing to measure does it skip with an explicit
 * reason (never a hard failure either way).
 */
import { gzipSync } from "node:zlib";
import { stringify } from "devalue";
import { describe, expect, it } from "vitest";

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
     VALUES ($1, 'Byte Gate Testbird', 'Testus bytus', 'species', 'Testidae')
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

// One real, already-seeded (0044) region per ribbon column: two US states
// (west/east of 100°W) for NAW/NAE, and one bare country per remaining
// column.
const WIDE_CODES = ["US-CA", "US-NY", "BR", "FR", "ZA", "IN", "AU", "AQ"];

async function insertLoc(code: string) {
  const sizes = Array(48).fill(2000);
  await query(
    `INSERT INTO frequency_fetch
       (loc_code, loc_kind, loc_name, begin_year, end_year, sample_sizes, n_species)
     VALUES ($1, 'region', $2, 2016, 2025, $3, 1)`,
    [code, `Byte gate fixture ${code}`, sizes],
  );
}

async function insertFreq(code: string, species: string) {
  // Every week non-zero — maximizes how much of the curve actually
  // serializes as real numbers rather than being collapsed by a zero-fill.
  for (let week = 1; week <= 48; week++) {
    await query(
      `INSERT INTO species_frequency (loc_code, species_code, week, freq)
       VALUES ($1, $2, $3, $4)`,
      [code, species, week, 0.01 + (week % 12) * 0.02],
    );
  }
}

/** The species with the most species_band_month_freq coverage currently in
 * the DB — the best available stand-in for "widest species" when this
 * test can't safely seed its own fixture. */
async function widestLoadedSpecies(): Promise<string | null> {
  const r = await query<{ species_code: string }>(
    `SELECT species_code FROM species_band_month_freq
      GROUP BY species_code ORDER BY count(*) DESC LIMIT 1`,
  );
  return r.rows[0]?.species_code ?? null;
}

async function measureRibbon(uid: number, code: string): Promise<number> {
  const data = (await load(loadEvent(uid, code))) as unknown as {
    ribbon: { ok: true; grid: unknown } | { ok: false; error: string };
  };
  expect(data.ribbon.ok).toBe(true);
  if (!data.ribbon.ok) throw new Error("ribbon load failed");
  const serialized = stringify(data.ribbon);
  return gzipSync(Buffer.from(serialized, "utf8")).length;
}

describe.runIf(dbUp)("migration ribbon SSR byte gate (td-c6b113, CODEX1 P2-8)", () => {
  it("keeps the serialised ribbon <= 40 KB gzipped for the widest available species", async () => {
    const preexisting = await query<{ loc_code: string }>(
      "SELECT loc_code FROM frequency_fetch WHERE loc_code = ANY($1)",
      [WIDE_CODES],
    );
    const uid = await noKeyUserId();

    if (preexisting.rows.length > 0) {
      // Non-destructive fallback (CODEX1 P2-1): never overwrite data that's
      // already there — measure whatever is already the widest loaded
      // species instead.
      const widest = await widestLoadedSpecies();
      if (!widest) {
        // eslint-disable-next-line no-console
        console.log(
          `[ribbon byte gate] SKIPPED: ${preexisting.rows.map((r) => r.loc_code).join(", ")} ` +
            "already have data, and no species is loaded to measure instead.",
        );
        return;
      }
      const gzipped = await measureRibbon(uid, widest);
      // eslint-disable-next-line no-console
      console.log(
        `[ribbon byte gate] measured pre-existing species "${widest}" (WIDE_CODES already loaded): ${gzipped} B gzipped`,
      );
      expect(gzipped).toBeLessThanOrEqual(40 * 1024);
      return;
    }

    const CODE = "rbbytgt1";
    const { rebuildMonthRollup, rebuildBandRollup } = await import("$server/barchart");
    await seedTaxon(CODE);
    try {
      for (const code of WIDE_CODES) {
        await insertLoc(code);
        await insertFreq(code, CODE);
        await rebuildMonthRollup(code);
        await rebuildBandRollup(code);
      }

      const gzipped = await measureRibbon(uid, CODE);
      // eslint-disable-next-line no-console
      console.log(
        `[ribbon byte gate] ${WIDE_CODES.length}-region fixture: ${gzipped} B gzipped`,
      );
      expect(gzipped).toBeLessThanOrEqual(40 * 1024);
    } finally {
      // frequency_fetch's delete cascades species_frequency (0011 FK); the
      // rebuild then correctly zeroes each country's band/month rollups.
      await query("DELETE FROM frequency_fetch WHERE loc_code = ANY($1)", [WIDE_CODES]);
      for (const code of WIDE_CODES) await rebuildBandRollup(code);
      await query("DELETE FROM taxonomy_cache WHERE species_code = $1", [CODE]);
    }
  });
});
