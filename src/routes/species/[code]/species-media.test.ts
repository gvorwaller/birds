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
          };
        };
        expect(data.sampleMedia.status).toBe("ok");
        expect(data.sampleMedia.mediaError).toBeNull();
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
