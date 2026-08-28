/**
 * Route-level coverage for the field-guide sample media feature (plan:
 * docs/2026-08-23-field-guide-sample-media-CLAUDE.md, §9 loader/action,
 * §15 "Routes" bullet — Phase B scope only; UI rendering is not covered
 * here since this repo has no component-render test harness — see
 * guide-loader.test.ts for the established DB-backed route-test pattern
 * this file follows).
 *
 * Loader: DB-only — real species_media/species_enrichment rows via the
 * real gateway functions (upsertMediaOk/markMediaError), asserting the
 * loader's `sampleMedia` field matches the SampleMedia shape. No
 * Commons/xeno-canto network calls (key invariant #1 — the loader never
 * makes them; nothing here stubs them because nothing should call them).
 *
 * Action: `refresh_enrichment`'s network phase (enrichOneNow) is mocked so
 * every wiki outcome branch (ok, no_article, transient) can be driven
 * without live Wikimedia calls — matching this repo's existing vi.mock
 * convention for queue primitives in job-handlers.test.ts. enqueueJob is
 * mocked here so this route file cannot race the jobs-db suite's real queue;
 * jobs-db.test.ts owns the SQL contract for queue persistence.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EnqueueParams } from "$server/jobs";

const enqueueJobMock = vi.hoisted(() =>
  vi.fn<
    (params: EnqueueParams) => Promise<{ jobId: number; deduped: boolean }>
  >(async () => ({ jobId: 4242, deduped: false })),
);

vi.mock("$server/species-enrichment", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("$server/species-enrichment")>();
  return { ...actual, enrichOneNow: vi.fn() };
});
vi.mock("$server/jobs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("$server/jobs")>();
  return { ...actual, enqueueJob: enqueueJobMock };
});

const { query } = await import("$lib/db");
const { upsertMediaOk, markMediaError, enrichOneNow } =
  await import("$server/species-enrichment");
const { dedupKeys } = await import("$server/job-policy");
const { load, actions } = await import("./+page.server");

const dbUp = await query("SELECT 1")
  .then(() => true)
  .catch(() => false);

function loadEvent(scopeId: number, role: string, code: string) {
  return {
    locals: { scopeId, user: { id: scopeId, role } },
    params: { code },
    url: new URL(`http://localhost/species/${code}`),
  } as unknown as Parameters<typeof load>[0];
}

function actionEvent(userId: number, role: string, code: string) {
  return {
    locals: { scopeId: userId, user: { id: userId, role } },
    params: { code },
  } as unknown as Parameters<NonNullable<typeof actions.refresh_enrichment>>[0];
}

async function seedTaxon(code: string) {
  await query(
    `INSERT INTO taxonomy_cache (species_code, com_name, sci_name, category, family)
     VALUES ($1, 'Sample Media Testbird', 'Testus mediaus', 'species', 'Testidae')
     ON CONFLICT (species_code) DO UPDATE SET category = 'species'`,
    [code],
  );
}

/**
 * A user with no user_ebird row. The loader unconditionally calls
 * getEbirdApiKey(userId); the fixture DB carries a real encrypted key on
 * some seeded users whose ciphertext doesn't decrypt under this test run's
 * EBIRD_KEY_SECRET (the same landmine already skipping 2 guide-loader.test.ts
 * cases — unrelated to this feature). Avoid it entirely.
 */
async function noKeyUserId(): Promise<number> {
  const r = await query<{ id: number }>(
    `SELECT u.id FROM users u
      WHERE NOT EXISTS (SELECT 1 FROM user_ebird ue WHERE ue.user_id = u.id)
      ORDER BY u.id LIMIT 1`,
  );
  return r.rows[0].id;
}

async function cleanup(code: string) {
  await query(`DELETE FROM species_media WHERE species_code = $1`, [code]);
  await query(`DELETE FROM species_enrichment WHERE species_code = $1`, [code]);
  await query(`DELETE FROM taxonomy_cache WHERE species_code = $1`, [code]);
}

describe.runIf(dbUp)(
  "species/[code] loader — sampleMedia (td-86a2b6 §9b)",
  () => {
    it("returns photo + sounds in the SampleMedia shape when media rows exist", async () => {
      const CODE = "smedld1";
      await seedTaxon(CODE);
      const uid = await noKeyUserId();
      try {
        await upsertMediaOk(
          CODE,
          [
            {
              kind: "photo",
              vocalization_type: null,
              rank: 1,
              provider: "wikimedia_commons",
              provider_id: "Testbird.jpg",
              media_url: "https://upload.wikimedia.org/Testbird.jpg",
              thumbnail_url: "https://upload.wikimedia.org/Testbird-640.jpg",
              source_url:
                "https://commons.wikimedia.org/wiki/File:Testbird.jpg",
              title: null,
              creator: "Jane Photographer",
              license_code: "CC BY-SA 4.0",
              license_url: "https://creativecommons.org/licenses/by-sa/4.0/",
              location: null,
              duration_seconds: null,
              width: 800,
              height: 600,
            },
            {
              kind: "sound",
              vocalization_type: "song",
              rank: 1,
              provider: "xeno_canto",
              provider_id: "XC1",
              media_url: "https://xeno-canto.org/1/download",
              thumbnail_url: null,
              source_url: "https://xeno-canto.org/1",
              title: null,
              creator: "John Recordist",
              license_code: "CC BY-NC-SA 4.0",
              license_url: "https://creativecommons.org/licenses/by-nc-sa/4.0/",
              location: "Somewhere",
              duration_seconds: 12.5,
              width: null,
              height: null,
            },
          ],
          "ok",
        );

        const data = (await load(loadEvent(uid, "admin", CODE))) as unknown as {
          sampleMedia: {
            photo: { provider_id: string; width: number | null } | null;
            sounds: { provider_id: string; vocalization_type: string | null }[];
            status: string | null;
            mediaError: string | null;
            audioStatus: "restricted" | null;
          };
        };
        expect(data.sampleMedia.status).toBe("ok");
        expect(data.sampleMedia.mediaError).toBeNull();
        expect(data.sampleMedia.audioStatus).toBeNull();
        expect(data.sampleMedia.photo?.provider_id).toBe("Testbird.jpg");
        expect(data.sampleMedia.photo?.width).toBe(800);
        expect(data.sampleMedia.sounds).toHaveLength(1);
        expect(data.sampleMedia.sounds[0].provider_id).toBe("XC1");
        expect(data.sampleMedia.sounds[0].vocalization_type).toBe("song");
      } finally {
        await cleanup(CODE);
      }
    });

    it("last-good preservation: a failed refresh keeps prior rows but reports error status", async () => {
      const CODE = "smedld2";
      await seedTaxon(CODE);
      const uid = await noKeyUserId();
      try {
        await upsertMediaOk(
          CODE,
          [
            {
              kind: "photo",
              vocalization_type: null,
              rank: 1,
              provider: "wikimedia_commons",
              provider_id: "Keeper.jpg",
              media_url: "https://upload.wikimedia.org/Keeper.jpg",
              thumbnail_url: null,
              source_url: "https://commons.wikimedia.org/wiki/File:Keeper.jpg",
              title: null,
              creator: null,
              license_code: "CC0",
              license_url: null,
              location: null,
              duration_seconds: null,
              width: null,
              height: null,
            },
          ],
          "ok",
        );
        await markMediaError(CODE, "commons unreachable");

        const data = (await load(loadEvent(uid, "admin", CODE))) as unknown as {
          sampleMedia: {
            photo: { provider_id: string } | null;
            status: string | null;
            mediaError: string | null;
          };
        };
        expect(data.sampleMedia.status).toBe("error");
        expect(data.sampleMedia.mediaError).toBe("commons unreachable");
        // The prior photo row is untouched (last-good preservation).
        expect(data.sampleMedia.photo?.provider_id).toBe("Keeper.jpg");
      } finally {
        await cleanup(CODE);
      }
    });

    it("no media attempted yet: photo null, sounds empty, status null", async () => {
      const CODE = "smedld3";
      await seedTaxon(CODE);
      const uid = await noKeyUserId();
      try {
        const data = (await load(loadEvent(uid, "admin", CODE))) as unknown as {
          sampleMedia: {
            photo: unknown;
            sounds: unknown[];
            status: string | null;
          };
        };
        expect(data.sampleMedia.photo).toBeNull();
        expect(data.sampleMedia.sounds).toEqual([]);
        expect(data.sampleMedia.status).toBeNull();
      } finally {
        await cleanup(CODE);
      }
    });
  },
);

describe.runIf(dbUp)(
  "species/[code] refresh_enrichment action — media enqueue in every branch (td-86a2b6 §9c)",
  () => {
    afterEach(() => {
      vi.mocked(enrichOneNow).mockReset();
      enqueueJobMock.mockClear();
    });

    function jobRowFor(code: string) {
      const call = enqueueJobMock.mock.calls.find(
        ([params]) => params.dedupKey === dedupKeys.enrichMediaOne(code),
      );
      return call?.[0] ?? null;
    }

    it("non-admin is rejected before any enqueue", async () => {
      const CODE = "smedact0";
      await seedTaxon(CODE);
      const uid = await noKeyUserId();
      try {
        const result = (await actions.refresh_enrichment!(
          actionEvent(uid, "viewer", CODE),
        )) as unknown as { status: number };
        expect(result.status).toBe(403);
        expect(jobRowFor(CODE)).toBeNull();
      } finally {
        await cleanup(CODE);
      }
    });

    it("outcome 'ok' still enqueues enrich_species_media", async () => {
      const CODE = "smedact1";
      await seedTaxon(CODE);
      const uid = await noKeyUserId();
      vi.mocked(enrichOneNow).mockResolvedValue({
        outcome: "ok",
        title: "T",
        viaFallback: false,
        aiDue: false,
      });
      try {
        const result = (await actions.refresh_enrichment!(
          actionEvent(uid, "admin", CODE),
        )) as unknown as {
          queued?: { jobId: number; label: string };
          message?: string;
        };
        const job = jobRowFor(CODE);
        expect(job?.type).toBe("enrich_species_media");
        expect(job?.payload).toMatchObject({ codes: [CODE], force: true });
        // One-button UX: when media is the only background work, return
        // queued so the layout chip tracks it (jobsPoll grace-stops idle).
        expect(result.queued?.label).toBe("Sample media");
        expect(result.message).toMatch(/sample media is updating/i);
      } finally {
        await cleanup(CODE);
      }
    });

    it("outcome 'no_article' still enqueues enrich_species_media", async () => {
      const CODE = "smedact2";
      await seedTaxon(CODE);
      const uid = await noKeyUserId();
      vi.mocked(enrichOneNow).mockResolvedValue({ outcome: "no_article" });
      try {
        await actions.refresh_enrichment!(actionEvent(uid, "admin", CODE));
        const job = jobRowFor(CODE);
        expect(job?.type).toBe("enrich_species_media");
      } finally {
        await cleanup(CODE);
      }
    });

    it("outcome 'transient' still enqueues enrich_species_media (alongside the wiki retry job)", async () => {
      const CODE = "smedact3";
      await seedTaxon(CODE);
      const uid = await noKeyUserId();
      vi.mocked(enrichOneNow).mockResolvedValue({ outcome: "transient" });
      try {
        await actions.refresh_enrichment!(actionEvent(uid, "admin", CODE));
        const job = jobRowFor(CODE);
        expect(job?.type).toBe("enrich_species_media");
      } finally {
        await cleanup(CODE);
      }
    });
  },
);

/**
 * Similar / related species on the loader (td-8f0ed8, plan
 * docs/2026-08-25-similar-species-plan.md Step 2).
 *
 * Real rows through the real query — the point of these cases is the SQL
 * contract (case normalisation, category filter, scope gate, dedupe), which a
 * mocked gateway would not exercise at all.
 */
describe.runIf(dbUp)("species/[code] loader — similar species display set (td-460b1c)", () => {
  const FOCAL = "simfoc1";
  const PARTNER = "simpar1";
  const THIRD = "simthr1";
  const ALL = [FOCAL, PARTNER, THIRD];

  type SimRow = {
    species_code: string;
    com_name: string;
    sci_name: string;
    misid_count: number | null;
    note: string | null;
    seen: boolean;
  };
  type UnresolvedRow = { inat_sci_name: string; inat_com_name: string | null };

  /** The loader's typed return is the SvelteKit union; cast like the cases above. */
  async function loadSimilar(uid: number, code: string) {
    const data = (await load(loadEvent(uid, "admin", code))) as unknown as {
      similar: { similar: SimRow[]; unresolved: UnresolvedRow[]; inatStatus: string };
    };
    return data.similar;
  }

  async function seed(code: string, com: string, sci: string) {
    await query(
      `INSERT INTO taxonomy_cache (species_code, com_name, sci_name, category, family)
       VALUES ($1, $2, $3, 'species', 'Testidae')
       ON CONFLICT (species_code) DO UPDATE
         SET com_name = $2, sci_name = $3, category = 'species'`,
      [code, com, sci],
    );
    await query(
      `INSERT INTO species_enrichment (species_code) VALUES ($1)
       ON CONFLICT (species_code) DO NOTHING`,
      [code],
    );
  }

  /** Put a species in enrichment scope without marking it seen by anyone. */
  async function putInScope(code: string) {
    await query(
      `INSERT INTO photo_links
         (photo_id, species_code, source_species, url, thumbnail, page_url, match_method)
       VALUES ($1, $2, 'Test', 'https://x/p.jpg', 'https://x/t.jpg', 'https://x/page', 'common_name')
       ON CONFLICT (photo_id) DO NOTHING`,
      [`simphoto-${code}`, code],
    );
  }

  async function display(pos: number, resolved: string | null, sci: string, misid: number | null) {
    await query(
      `INSERT INTO species_similar_display
         (species_code, position, resolved_code, inat_taxon_id, inat_sci_name,
          inat_com_name, misid_count, origin, unresolved)
       VALUES ($1, $2, $3, NULL, $4, NULL, $5, 'forward', $6)`,
      [FOCAL, pos, resolved, sci, misid, resolved === null],
    );
  }

  async function seedAll() {
    await seed(FOCAL, "Test Focal Bird", "Simfocus focalis");
    await seed(PARTNER, "Test Partner Bird", "Simfocus partneris");
    await seed(THIRD, "Test Third Bird", "Simother tertius");
    await putInScope(PARTNER);
    await putInScope(THIRD);
    await query(
      `UPDATE species_enrichment SET inat_similar_status = 'ok' WHERE species_code = $1`,
      [FOCAL],
    );
    await display(1, PARTNER, "Simfocus partneris", 33);
    await display(2, THIRD, "Simother tertius", 12);
    await display(3, null, "Simignotus mysterius", 5);
  }

  async function cleanAll() {
    await query(`DELETE FROM photo_links WHERE photo_id LIKE 'simphoto-%'`);
    await query(`DELETE FROM species_similar_display WHERE species_code = ANY($1)`, [ALL]);
    await query(`DELETE FROM species_similar WHERE species_code = ANY($1)`, [ALL]);
    await query(`DELETE FROM seen_species WHERE species_code = ANY($1)`, [ALL]);
    await query(`DELETE FROM species_media WHERE species_code = ANY($1)`, [ALL]);
    await query(`DELETE FROM species_enrichment WHERE species_code = ANY($1)`, [ALL]);
    await query(`DELETE FROM taxonomy_cache WHERE species_code = ANY($1)`, [ALL]);
  }

  it("renders the persisted display set in order with counts, unresolved passthrough, never the focal", async () => {
    await seedAll();
    const uid = await noKeyUserId();
    try {
      const sim = await loadSimilar(uid, FOCAL);
      expect(sim.inatStatus).toBe("ok");
      expect(sim.similar.map((s) => s.species_code)).toEqual([PARTNER, THIRD]);
      expect(sim.similar[0].misid_count).toBe(33);
      expect(sim.unresolved.map((u) => u.inat_sci_name)).toEqual(["Simignotus mysterius"]);
    } finally {
      await cleanAll();
    }
  });

  it("attaches the stored AI note to the matching ordered pair only, never mirrored", async () => {
    await seedAll();
    const uid = await noKeyUserId();
    try {
      await query(
        `INSERT INTO species_similar (species_code, similar_code, note, ai_model)
         VALUES ($1, $2, 'Slimmer, with a finer bill and paler flanks.', 'test')`,
        [FOCAL, PARTNER],
      );
      const sim = await loadSimilar(uid, FOCAL);
      expect(sim.similar.find((s) => s.species_code === PARTNER)?.note).toContain("finer bill");
      expect(sim.similar.find((s) => s.species_code === THIRD)?.note).toBeNull();
    } finally {
      await cleanAll();
    }
  });

  it("`seen` is scope-personal, not global", async () => {
    await seedAll();
    const uid = await noKeyUserId();
    try {
      await query(
        `INSERT INTO seen_species (user_id, species_code, source) VALUES ($1, $2, 'manual')
         ON CONFLICT DO NOTHING`,
        [uid, PARTNER],
      );
      const mine = await loadSimilar(uid, FOCAL);
      expect(mine.similar.find((s) => s.species_code === PARTNER)?.seen).toBe(true);
      expect(mine.similar.find((s) => s.species_code === THIRD)?.seen).toBe(false);
    } finally {
      await cleanAll();
    }
  });

  it("an empty display set with status 'none' yields empty arrays (honest hidden card)", async () => {
    await seed(FOCAL, "Test Focal Bird", "Simfocus focalis");
    await query(
      `UPDATE species_enrichment SET inat_similar_status = 'none' WHERE species_code = $1`,
      [FOCAL],
    );
    const uid = await noKeyUserId();
    try {
      const sim = await loadSimilar(uid, FOCAL);
      expect(sim.inatStatus).toBe("none");
      expect(sim.similar).toEqual([]);
      expect(sim.unresolved).toEqual([]);
    } finally {
      await cleanAll();
    }
  });
});
