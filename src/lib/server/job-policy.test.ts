import { describe, expect, it } from "vitest";
import { HOTSPOT_FAILURE_COOLDOWN_MS } from "./barchart";
import {
  RATE_LIMIT_RETRY_DELAY_MS,
  TRANSIENT_RETRY_DELAYS_MS,
  dedupKeys,
  displayName,
  durationMs,
  canViewJobEvents,
  isScheduledSingleton,
  jobLocCodes,
  jobOutcome,
  jobTarget,
  retryDelayMs,
  sanitizeErrorText,
  scrubStoredValue,
  statusColor,
  type EnsureSummary,
  type UnitFailure,
} from "./job-policy";

function summary(overrides: Partial<EnsureSummary> = {}): EnsureSummary {
  return {
    ready: [],
    refreshed: [],
    failed: [],
    notAttempted: [],
    credentialProblem: null,
    rateLimited: false,
    ...overrides,
  };
}

function failure(kind: UnitFailure["kind"], code = "L1"): UnitFailure {
  return { code, error: `${kind} problem`, kind };
}

describe("retryDelayMs", () => {
  it("walks the transient schedule and clamps at the last entry", () => {
    expect(retryDelayMs(1, "transient")).toBe(TRANSIENT_RETRY_DELAYS_MS[0]);
    expect(retryDelayMs(2, "transient")).toBe(TRANSIENT_RETRY_DELAYS_MS[1]);
    expect(retryDelayMs(3, "transient")).toBe(TRANSIENT_RETRY_DELAYS_MS[2]);
    expect(retryDelayMs(99, "transient")).toBe(TRANSIENT_RETRY_DELAYS_MS[2]);
    expect(retryDelayMs(0, "transient")).toBe(TRANSIENT_RETRY_DELAYS_MS[0]);
  });

  it("rate limit uses the flat delay regardless of attempt", () => {
    expect(retryDelayMs(1, "rate_limited")).toBe(RATE_LIMIT_RETRY_DELAY_MS);
    expect(retryDelayMs(3, "rate_limited")).toBe(RATE_LIMIT_RETRY_DELAY_MS);
  });

  it("PROPERTY: every retry delay ≥ the hotspot failure cooldown, so a retry round never finds all units still cooling down", () => {
    for (const d of TRANSIENT_RETRY_DELAYS_MS) {
      expect(d).toBeGreaterThanOrEqual(HOTSPOT_FAILURE_COOLDOWN_MS);
    }
    expect(RATE_LIMIT_RETRY_DELAY_MS).toBeGreaterThanOrEqual(
      HOTSPOT_FAILURE_COOLDOWN_MS,
    );
  });
});

describe("jobOutcome", () => {
  it("credential problem is terminal on ANY attempt — no retry ever", () => {
    const s = summary({ credentialProblem: "eBird rejected the sign-in." });
    const o = jobOutcome(s, 1, 4);
    expect(o.kind).toBe("fail");
    if (o.kind === "fail") expect(o.error).toMatch(/rejected/);
  });

  it("rate limited retries with the flat delay, then fails when attempts run out", () => {
    const s = summary({ rateLimited: true, notAttempted: ["L2"] });
    const mid = jobOutcome(s, 2, 4);
    expect(mid).toMatchObject({ kind: "retry", delayMs: RATE_LIMIT_RETRY_DELAY_MS });
    const last = jobOutcome(s, 4, 4);
    expect(last.kind).toBe("fail");
  });

  it("notAttempted remainder retries per the transient schedule", () => {
    const s = summary({ refreshed: ["L1"], notAttempted: ["L2", "L3"] });
    const o = jobOutcome(s, 1, 4);
    expect(o).toMatchObject({
      kind: "retry",
      delayMs: TRANSIENT_RETRY_DELAYS_MS[0],
    });
    const spent = jobOutcome(s, 4, 4);
    expect(spent.kind).toBe("fail");
  });

  it("transient unit failures retry while attempts remain, FAIL when exhausted (never a quiet success)", () => {
    const s = summary({ refreshed: ["L1"], failed: [failure("transient", "L2")] });
    expect(jobOutcome(s, 1, 4).kind).toBe("retry");
    // Attempts spent: a location that 500s through every round is a terminal
    // job failure the UI must surface (CODEX1 re-review #1) — with the
    // partial result preserved.
    const spent = jobOutcome(s, 4, 4);
    expect(spent.kind).toBe("fail");
    if (spent.kind === "fail") {
      expect(spent.error).toMatch(/after 4 attempts/);
      expect(spent.result.refreshed).toEqual(["L1"]);
    }
  });

  it("cooldown-only remainder retries just past the cooldown and NEVER exhausts the budget", () => {
    const s = summary({ failed: [failure("cooldown", "L9")] });
    const o = jobOutcome(s, 1, 4);
    expect(o).toMatchObject({
      kind: "retry",
      delayMs: HOTSPOT_FAILURE_COOLDOWN_MS + 60_000,
    });
    // Attempts spent → complete with the cooldown units reported (GROK #11j),
    // never a generic failure.
    const spent = jobOutcome(s, 4, 4);
    expect(spent.kind).toBe("complete");
    expect(spent.result.failed[0].kind).toBe("cooldown");
  });

  it("permanent unit failures complete with the detail in the result", () => {
    const s = summary({ refreshed: ["L1"], failed: [failure("unit", "L2")] });
    const o = jobOutcome(s, 1, 4);
    expect(o.kind).toBe("complete");
  });

  it("everything-failed-permanently still completes honestly", () => {
    const s = summary({ failed: [failure("unit", "L1"), failure("unit", "L2")] });
    expect(jobOutcome(s, 1, 4).kind).toBe("complete");
  });

  it("all-current no-op completes", () => {
    const s = summary({ ready: ["L1", "L2"] });
    expect(jobOutcome(s, 1, 4).kind).toBe("complete");
  });
});

describe("dedup keys", () => {
  it("load_hotspots key is order-independent and bounded", () => {
    const a = dedupKeys.loadHotspots(["L3", "L1", "L2"]);
    const b = dedupKeys.loadHotspots(["L1", "L2", "L3"]);
    expect(a).toBe(b);
    expect(a).toMatch(/^load_hotspots:[0-9a-f]{16}$/);
    expect(dedupKeys.loadHotspots(["L1"])).not.toBe(a);
  });

  it("forced media retries do not dedup against normal scheduled media", () => {
    const codes = ["melthr", "grycat"];
    expect(dedupKeys.enrichMediaForceChunk(codes)).toMatch(/^enrich_media_force:/);
    expect(dedupKeys.enrichMediaForceChunk(codes)).not.toBe(dedupKeys.enrichMediaChunk(codes));
  });

  it("scalar keys embed their target", () => {
    expect(dedupKeys.loadRegion("US-ME")).toBe("load_region:US-ME");
    expect(dedupKeys.analyzeCounties("US-FL")).toBe("analyze_counties:US-FL");
    expect(dedupKeys.refreshLoc("L123")).toBe("refresh_loc:L123");
    expect(dedupKeys.retryLoc("L123")).toBe("retry_loc:L123");
    expect(dedupKeys.syncLifelist(7)).toBe("sync_lifelist:u7");
    expect(dedupKeys.syncTaxonomy()).toBe("sync_taxonomy:global");
  });
});

describe("sanitizeErrorText / scrubStoredValue", () => {
  it("redacts every credential-shaped key=value pattern", () => {
    const hostile =
      "username=gaylon@vorwaller.net password=hunter2 pwd:oops " +
      "Authorization: Bearer abc.def.ghi\nCookie: session=deadbeef; theme=dark " +
      "api_key=sk-live-XYZ access-token=tok123 secret: s3cr3t email=x@y.z";
    const clean = sanitizeErrorText(hostile);
    for (const secret of [
      "hunter2",
      "gaylon@vorwaller.net",
      "abc.def.ghi",
      "deadbeef",
      "sk-live-XYZ",
      "tok123",
      "s3cr3t",
      "x@y.z",
      "oops",
    ]) {
      expect(clean).not.toContain(secret);
    }
    expect(clean).toContain("[redacted]");
  });

  it('JSON-form "password":"…" bodies are redacted too', () => {
    const hostile =
      'upstream echoed {"username":"gaylon@vorwaller.net","password":"hunter2","apiKey":"sk-live-XYZ","note":"ok"}';
    const clean = sanitizeErrorText(hostile);
    for (const secret of ["hunter2", "gaylon@vorwaller.net", "sk-live-XYZ"]) {
      expect(clean).not.toContain(secret);
    }
    expect(clean).toContain('"note":"ok"');
  });

  it("multi-pair cookie headers redact EVERY pair, across CRLF line ends", () => {
    const hostile =
      "Set-Cookie: session=deadbeef; auth=topsecret; theme=dark\r\n" +
      "next line is fine\r\n" +
      "Cookie: sid=alpha1; token=beta2";
    const clean = sanitizeErrorText(hostile);
    for (const secret of ["deadbeef", "topsecret", "alpha1", "beta2"]) {
      expect(clean).not.toContain(secret);
    }
    // Redaction stops at the line break — following lines survive.
    expect(clean).toContain("next line is fine");
  });

  it("leaves innocent place names and plain errors untouched", () => {
    for (const s of [
      "eBird export failed (HTTP 500) for Token Creek Conservancy",
      "Login Rd Marsh returned no rows",
      "timeout after 30s fetching US-ME-001",
    ]) {
      expect(sanitizeErrorText(s)).toBe(s);
    }
  });

  it("scrubStoredValue deep-walks nested objects and arrays", () => {
    const scrubbed = scrubStoredValue({
      a: [{ error: "password=hunter2" }],
      b: { c: "fine", n: 3, t: true, z: null },
    });
    expect(JSON.stringify(scrubbed)).not.toContain("hunter2");
    expect(scrubbed.b).toEqual({ c: "fine", n: 3, t: true, z: null });
  });
});

describe("payload projections", () => {
  it("jobTarget scopes region jobs to their region, multi-loc loads to null", () => {
    expect(
      jobTarget("analyze_counties", { regionCode: "US-ME", counties: [] }),
    ).toBe("US-ME");
    expect(
      jobTarget("load_region", { locs: [{ code: "US-TX", kind: "region" }] }),
    ).toBe("US-TX");
    expect(jobTarget("refresh_loc", { locs: [{ code: "L123" }] })).toBe("L123");
    expect(
      jobTarget("load_hotspots", { locs: [{ code: "L1" }, { code: "L2" }] }),
    ).toBeNull();
    expect(jobTarget("analyze_counties", {})).toBeNull();
    expect(jobTarget("load_region", null)).toBeNull();
  });

  it("jobLocCodes lists covered codes for loc AND county payloads, codes only", () => {
    expect(
      jobLocCodes({ locs: [{ code: "L1", name: "secret name" }, { code: "L2" }] }),
    ).toEqual(["L1", "L2"]);
    expect(
      jobLocCodes({
        regionCode: "US-ME",
        counties: [{ code: "US-ME-001", name: "Androscoggin" }],
      }),
    ).toEqual(["US-ME-001"]);
    expect(jobLocCodes({})).toEqual([]);
    expect(jobLocCodes(null)).toEqual([]);
    expect(jobLocCodes({ locs: [{ code: 5 }, {}] })).toEqual([]);
  });
});

describe("decoration", () => {
  it("displayName combines type name and label", () => {
    expect(displayName({ type: "load_hotspots", label: "5 hotspots near Bangor" })).toBe(
      "Load hotspots — 5 hotspots near Bangor",
    );
    expect(displayName({ type: "load_region", label: "" })).toBe("Load state data");
    expect(displayName({ type: "mystery", label: "" })).toBe("mystery");
  });

  it("durationMs handles running and finished jobs", () => {
    const now = new Date("2026-08-15T10:01:00Z");
    expect(durationMs({ started_at: null, finished_at: null }, now)).toBeNull();
    expect(
      durationMs(
        {
          started_at: "2026-08-15T10:00:00Z",
          finished_at: "2026-08-15T10:00:30Z",
        },
        now,
      ),
    ).toBe(30_000);
    expect(
      durationMs({ started_at: "2026-08-15T10:00:00Z", finished_at: null }, now),
    ).toBe(60_000);
  });

  it("statusColor maps every terminal and active status", () => {
    expect(statusColor("succeeded")).toBe("ok");
    expect(statusColor("running")).toBe("busy");
    expect(statusColor("pending")).toBe("warn");
    expect(statusColor("failed")).toBe("error");
    expect(statusColor("cancelled")).toBe("muted");
  });
});

describe("jobLocCodes — allCodes union (GROK P1 on afb305d)", () => {
  it("without allCodes: current payload.locs codes, as before", () => {
    expect(jobLocCodes({ locs: [{ code: "L1" }, { code: "L2" }] })).toEqual(["L1", "L2"]);
  });

  it("after a yield narrows locs, allCodes keeps the ORIGINAL coverage", () => {
    // covered/queued flags must not flap mid-job: L1 is banked (gone from
    // locs) but still covered by the running batch.
    expect(
      jobLocCodes({ locs: [{ code: "L2" }, { code: "L3" }], allCodes: ["L1", "L2", "L3"] }),
    ).toEqual(["L1", "L2", "L3"]);
  });

  it("counties payloads are unaffected", () => {
    expect(jobLocCodes({ counties: [{ code: "US-FL-057" }] })).toEqual(["US-FL-057"]);
  });
});

describe("canViewJobEvents — type/role boundary (CODEX1 P1 on e3ac335)", () => {
  it("frequency-load family is communal (any role)", () => {
    for (const t of ["load_hotspots", "load_region", "analyze_counties", "refresh_loc", "retry_loc"]) {
      expect(canViewJobEvents(t, "user")).toBe(true);
      expect(canViewJobEvents(t, "viewer")).toBe(true);
    }
  });

  it("every other type is admin-only — their events can reference individual users", () => {
    for (const t of ["sync_lifelist", "sync_taxonomy", "scan_need_alerts", "enrich_species", "scan_enrichment"]) {
      expect(canViewJobEvents(t, "user")).toBe(false);
      expect(canViewJobEvents(t, "viewer")).toBe(false);
      expect(canViewJobEvents(t, undefined)).toBe(false);
      expect(canViewJobEvents(t, "admin")).toBe(true);
    }
  });
});

describe("isScheduledSingleton (td-b7d021 pin a: parked scans never read as queued)", () => {
  const base = {
    type: "scan_enrichment",
    status: "pending",
    next_retry_at: new Date(Date.now() + 3_600_000).toISOString(),
    progress: {},
  };
  it("recurring singleton + pending + future next run + not retrying → scheduled", () => {
    expect(isScheduledSingleton(base as never)).toBe(true);
    expect(isScheduledSingleton({ ...base, type: "scan_need_alerts" } as never)).toBe(true);
  });
  it("everything else is NOT scheduled", () => {
    expect(isScheduledSingleton({ ...base, type: "load_hotspots" } as never)).toBe(false);
    expect(isScheduledSingleton({ ...base, status: "running" } as never)).toBe(false);
    expect(isScheduledSingleton({ ...base, next_retry_at: null } as never)).toBe(false);
    expect(
      isScheduledSingleton({
        ...base,
        next_retry_at: new Date(Date.now() - 1000).toISOString(),
      } as never),
    ).toBe(false); // due now = real work
    expect(
      isScheduledSingleton({ ...base, progress: { phase: "waiting_retry" } } as never),
    ).toBe(false); // actually retrying keeps the honest retry copy
  });
});
