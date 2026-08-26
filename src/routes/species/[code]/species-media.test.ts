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
describe.runIf(dbUp)("species/[code] loader — similar species (td-8f0ed8)", () => {
  const FOCAL = "simfoc1";
  const PARTNER = "simpar1";
  const THIRD = "simthr1";
  const GENUS_MATE = "simgen1";
  const OUT_OF_SCOPE = "simoos1";
  const FOURTH = "simfou1";
  const SLASH2 = "simsl2x";
  const SLASH3 = "simsl3x";
  const ALL = [
    FOCAL,
    PARTNER,
    THIRD,
    GENUS_MATE,
    OUT_OF_SCOPE,
    FOURTH,
    SLASH2,
    SLASH3,
  ];

  type SimRow = {
    species_code: string;
    com_name: string;
    sci_name: string;
    basis: string;
    slash_com_name: string | null;
    note: string | null;
    seen: boolean;
  };

  /** The loader's typed return is the SvelteKit union; cast like the cases above. */
  async function loadSimilar(uid: number, code: string) {
    const data = (await load(loadEvent(uid, "admin", code))) as unknown as {
      similar: { similar: SimRow[]; related: SimRow[] };
    };
    return data.similar;
  }

  async function seed(code: string, com: string, sci: string, category: string) {
    await query(
      `INSERT INTO taxonomy_cache (species_code, com_name, sci_name, category, family)
       VALUES ($1, $2, $3, $4, 'Testidae')
       ON CONFLICT (species_code) DO UPDATE
         SET com_name = $2, sci_name = $3, category = $4`,
      [code, com, sci, category],
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

  async function seedAll() {
    await seed(FOCAL, "Test Focal Bird", "Simfocus focalis", "species");
    await seed(PARTNER, "Test Partner Bird", "Simfocus partneris", "species");
    await seed(THIRD, "Test Third Bird", "Simother tertius", "species");
    await seed(GENUS_MATE, "Test Genus Mate", "Simfocus congener", "species");
    await seed(OUT_OF_SCOPE, "Test Out Of Scope", "Simfocus absentis", "species");
    // Deliberately in Othergenus, NOT Testus: it is only reachable if the bare
    // epithet "quartus" inherits the genus of the PRECEDING part.
    await seed(FOURTH, "Test Fourth Bird", "Simother quartus", "species");
    // Two-part slash, shared genus.
    await seed(SLASH2, "Test Focal/Partner Bird", "Simfocus focalis/partneris", "slash");
    // Three-part slash whose LAST member is a bare epithet after a genus
    // change — the carry-forward case.
    await seed(
      SLASH3,
      "Test Focal/Third/Fourth Bird",
      "Simfocus focalis/Simother tertius/quartus",
      "slash",
    );
    await putInScope(GENUS_MATE);
    await putInScope(PARTNER);
  }

  async function cleanAll() {
    await query(`DELETE FROM photo_links WHERE photo_id LIKE 'simphoto-%'`);
    await query(`DELETE FROM species_similar WHERE species_code = ANY($1)`, [ALL]);
    await query(`DELETE FROM seen_species WHERE species_code = ANY($1)`, [ALL]);
    await query(`DELETE FROM species_media WHERE species_code = ANY($1)`, [ALL]);
    await query(`DELETE FROM species_enrichment WHERE species_code = ANY($1)`, [ALL]);
    await query(`DELETE FROM taxonomy_cache WHERE species_code = ANY($1)`, [ALL]);
  }

  it("returns slash partners as `similar`, never the focal species itself", async () => {
    await seedAll();
    const uid = await noKeyUserId();
    try {
      const sim = await loadSimilar(uid, FOCAL);
      const codes = sim.similar.map((s) => s.species_code);
      expect(codes).toContain(PARTNER);
      expect(codes).not.toContain(FOCAL);
      const partner = sim.similar.find((s) => s.species_code === PARTNER)!;
      expect(partner.basis).toBe("ebird_slash");
      expect(partner.slash_com_name).toBe("Test Focal/Partner Bird");
    } finally {
      await cleanAll();
    }
  });

  it("REGRESSION: a bare epithet inherits the NEAREST preceding genus", async () => {
    // "Simfocus focalis/Simother tertius/quartus" must resolve its third member
    // to "Simother quartus" (seeded, code FOURTH). Inheriting from the FIRST
    // part instead would produce "Simfocus quartus", which does not exist — the
    // member would vanish silently and this assertion is the only thing that
    // would notice.
    await seedAll();
    const uid = await noKeyUserId();
    try {
      const sim = await loadSimilar(uid, FOCAL);
      const codes = sim.similar.map((s) => s.species_code);
      expect(codes).toContain(THIRD);
      expect(codes).toContain(FOURTH);
      expect(
        sim.similar.find((s) => s.species_code === FOURTH)!.sci_name,
      ).toBe("Simother quartus");
    } finally {
      await cleanAll();
    }
  });

  it("drops a slash member that resolves to no species row", async () => {
    // Same three-part slash, but with the carry-forward target absent: the
    // member must disappear rather than surface as a bare code or a
    // synthesised name (cs.md forbids placeholder data).
    await seedAll();
    await query(`DELETE FROM taxonomy_cache WHERE species_code = $1`, [FOURTH]);
    const uid = await noKeyUserId();
    try {
      const sim = await loadSimilar(uid, FOCAL);
      const codes = sim.similar.map((s) => s.species_code);
      expect(codes).not.toContain(FOURTH);
      expect(codes).toContain(THIRD);
      expect(sim.similar.every((s) => s.com_name && s.sci_name)).toBe(true);
    } finally {
      await cleanAll();
    }
  });

  it("matches case-insensitively — the stored sci_name is capitalised too", async () => {
    // Regression guard for the defect where the expanded name was compared raw
    // against lower(sci_name), matching nothing and shipping an empty feature.
    await seedAll();
    const uid = await noKeyUserId();
    try {
      const sim = await loadSimilar(uid, FOCAL);
      expect(sim.similar.length).toBeGreaterThan(0);
    } finally {
      await cleanAll();
    }
  });

  it("ignores non-species rows that collide on sci_name", async () => {
    await seedAll();
    // An issf row sharing the partner's binomial must not be returned in its
    // place — taxonomy_sci_idx is not unique.
    await seed("simiss1", "Test Partner Bird (form)", "Simfocus partneris", "issf");
    const uid = await noKeyUserId();
    try {
      const sim = await loadSimilar(uid, FOCAL);
      const codes = sim.similar.map((s) => s.species_code);
      expect(codes).toContain(PARTNER);
      expect(codes).not.toContain("simiss1");
    } finally {
      await query(`DELETE FROM taxonomy_cache WHERE species_code = 'simiss1'`);
      await cleanAll();
    }
  });

  it("puts in-scope genus mates in `related`, and never repeats a `similar` row", async () => {
    await seedAll();
    const uid = await noKeyUserId();
    try {
      // A genus row only renders WITH a note — without one it asserts nothing
      // and reads as missing data (reported from the phone view of Ringed
      // Kingfisher). Seed the note so this case tests placement, not visibility.
      await query(
        `INSERT INTO species_similar (species_code, similar_code, note, ai_model)
         VALUES ($1, $2, 'Bigger overall, with a heavier bill and broader band.', 'test')
         ON CONFLICT (species_code, similar_code) DO NOTHING`,
        [FOCAL, GENUS_MATE],
      );
      const sim = await loadSimilar(uid, FOCAL);
      const related = sim.related.map((s) => s.species_code);
      const similar = sim.similar.map((s) => s.species_code);
      expect(related).toContain(GENUS_MATE);
      // PARTNER is a genus mate too, but tier 1 already claimed it.
      expect(related).not.toContain(PARTNER);
      expect(related.some((c) => similar.includes(c))).toBe(false);
      expect(
        sim.related.find((s) => s.species_code === GENUS_MATE)!.basis,
      ).toBe("genus");
    } finally {
      await cleanAll();
    }
  });

  it("HIDES a genus mate that has no note, while keeping a note-less slash row", async () => {
    await seedAll();
    const uid = await noKeyUserId();
    try {
      const sim = await loadSimilar(uid, FOCAL);
      // eBird's grouping is itself information, so the slash row stands alone.
      expect(sim.similar.map((s) => s.species_code)).toContain(PARTNER);
      // "Same genus, may or may not be a look-alike" with no note says nothing.
      expect(sim.related).toEqual([]);
    } finally {
      await cleanAll();
    }
  });

  it("excludes genus mates that are out of enrichment scope", async () => {
    await seedAll();
    const uid = await noKeyUserId();
    try {
      const sim = await loadSimilar(uid, FOCAL);
      const related = sim.related.map((s) => s.species_code);
      expect(related).not.toContain(OUT_OF_SCOPE);
    } finally {
      await cleanAll();
    }
  });

  it("`seen` is scope-personal, not global", async () => {
    await seedAll();
    const uid = await noKeyUserId();
    const other = await query<{ id: number }>(
      `SELECT u.id FROM users u
        WHERE u.id <> $1
          AND NOT EXISTS (SELECT 1 FROM user_ebird ue WHERE ue.user_id = u.id)
        ORDER BY u.id LIMIT 1`,
      [uid],
    );
    try {
      await query(
        `INSERT INTO seen_species (user_id, species_code, source) VALUES ($1, $2, 'manual')
         ON CONFLICT DO NOTHING`,
        [uid, PARTNER],
      );
      const mine = await loadSimilar(uid, FOCAL);
      expect(mine.similar.find((s) => s.species_code === PARTNER)!.seen).toBe(
        true,
      );
      if (other.rows[0]) {
        const theirs = await loadSimilar(other.rows[0].id, FOCAL);
        expect(
          theirs.similar.find((s) => s.species_code === PARTNER)!.seen,
        ).toBe(false);
      }
    } finally {
      await cleanAll();
    }
  });

  it("returns empty arrays for a species in no slash taxon and no small genus", async () => {
    const LONE = "simlone1";
    await seed(LONE, "Test Lone Bird", "Solitarius unicus", "species");
    const uid = await noKeyUserId();
    try {
      const sim = await loadSimilar(uid, LONE);
      expect(sim.similar).toEqual([]);
      expect(sim.related).toEqual([]);
    } finally {
      await query(`DELETE FROM taxonomy_cache WHERE species_code = $1`, [LONE]);
    }
  });

  it("attaches the stored AI note to the matching ordered pair only", async () => {
    await seedAll();
    const uid = await noKeyUserId();
    try {
      await query(
        `INSERT INTO species_similar (species_code, similar_code, note, ai_model)
         VALUES ($1, $2, 'Partner shows a longer bill.', 'test-model')`,
        [FOCAL, PARTNER],
      );
      const mine = await loadSimilar(uid, FOCAL);
      expect(
        mine.similar.find((s) => s.species_code === PARTNER)!.note,
      ).toBe("Partner shows a longer bill.");
      // Directional: the note must NOT be mirrored onto the partner's page.
      const theirs = await loadSimilar(uid, PARTNER);
      expect(
        theirs.similar.find((s) => s.species_code === FOCAL)?.note ?? null,
      ).toBeNull();
    } finally {
      await cleanAll();
    }
  });
});
