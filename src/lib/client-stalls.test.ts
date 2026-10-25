import { describe, expect, it } from "vitest";
import { MAX_ERROR_CHARS, MAX_RAW_ERROR_CHARS, cleanError, describeStall, deviceLabel, isClientStallsRequest, parseStallEvent } from "$lib/client-stalls";

const NOW = Date.UTC(2026, 9, 25, 15, 0, 0);
const good = {
  id: "0b6f3a9e-1c2d-4e5f-8a9b-0c1d2e3f4a5b",
  kind: "unfinished",
  occurredAt: NOW - 60_000,
  fromRoute: "/species/[code]",
  toRoute: "/species/[code]",
  toPath: "/species/blugrb1",
  navType: "link",
  stage: "data",
  waitedMs: 25_300,
  dataMs: 300,
  aliveMs: 25_000,
  hiddenMs: null,
  errors: ["TypeError: x\nis undefined"],
  standalone: true,
  online: true,
  version: "b50f11b",
};

describe("parseStallEvent (td-1cb094)", () => {
  it("accepts a well-formed report and cleans its error text", () => {
    expect(parseStallEvent(good, NOW)).toEqual({ ...good, errors: ["TypeError: x is undefined"] });
  });

  it("takes an implausible browser clock as now", () => {
    expect(parseStallEvent({ ...good, occurredAt: NOW + 3_600_000 }, NOW)?.occurredAt).toBe(NOW);
    expect(parseStallEvent({ ...good, occurredAt: NOW - 40 * 86_400_000 }, NOW)?.occurredAt).toBe(NOW);
  });

  it("drops route and path text that does not fit the stored shape, keeping the report", () => {
    const e = parseStallEvent({ ...good, toPath: "/species/x?q=secret", toRoute: "javascript:alert(1)" }, NOW);
    expect(e).toMatchObject({ toPath: null, toRoute: null });
  });

  it("refuses anything else malformed", () => {
    for (const bad of [
      null,
      "x",
      { ...good, id: "not-a-uuid" },
      { ...good, kind: "crash" },
      { ...good, navType: "leave" },
      { ...good, stage: "drawn" },
      { ...good, waitedMs: -1 },
      { ...good, waitedMs: 1.5 },
      { ...good, dataMs: "300" },
      { ...good, standalone: "yes" },
      { ...good, version: "has space" },
      { ...good, errors: ["a", "b", "c", "d"] },
      { ...good, errors: "a" },
      { ...good, toPath: 42 },
      { ...good, occurredAt: Number.NaN },
    ]) {
      expect(parseStallEvent(bad, NOW)).toBeNull();
    }
  });

  it("names only the report endpoint as a viewer write", () => {
    expect(isClientStallsRequest("/api/client-stalls", "POST")).toBe(true);
    expect(isClientStallsRequest("/api/client-stalls", "GET")).toBe(false);
    expect(isClientStallsRequest("/api/admin/client-stalls", "POST")).toBe(false);
  });
});

/** `prefix`, padding, then a backslash as the 1000th character, then the rest of the quoted value. */
function cutAtBackslash(prefix: string, quote: string): string {
  return prefix + "x".repeat(MAX_RAW_ERROR_CHARS - 1 - prefix.length) + "\\" + `tail${quote}}`;
}

describe("cleanError redaction", () => {
  const leaks = [
    'failed response {"token":"CANARY_A"}',
    'failed response {"password": "CANARY_B"}',
    "api_key=CANARY_C access_token=CANARY_D",
    "Authorization: Bearer CANARY_E",
    "secret='multi word CANARY_F'",
    "GET https://user:CANARY_G@birds.example/api/x?sig=CANARY_H failed",
    "bearer CANARY_I",
    'set-cookie: session_id=CANARY_J; Path=/',
    JSON.stringify({ password: 'prefix" CANARY_ESCAPED_SUFFIX' }),
    '{"token":"abc def CANARY_UNTERMINATED',
    "x".repeat(150) + ' {"secret":"CANARY_NEAR_THE_CUT and more text past the 200-character limit"}',
    // The 1000-character raw cut lands just after a backslash inside the quoted value.
    cutAtBackslash('{"token":"abc def CANARY_DANGLING ', '"'),
    cutAtBackslash("{'token':'abc def CANARY_DANGLING_SINGLE ", "'"),
  ];

  it("blanks credential values in JSON, query and header forms, through the cleaner and the endpoint's parser", () => {
    for (const text of leaks) {
      const cleaned = cleanError(text);
      expect(cleaned, text).not.toMatch(/CANARY/);
      // The full path: cleaned in the browser, then parsed (and cleaned again) by the endpoint.
      const parsed = parseStallEvent({ ...good, errors: [cleaned] }, NOW);
      expect(parsed?.errors.join(" "), text).not.toMatch(/CANARY/);
    }
    expect(cleanError('failed response {"token":"CANARY_A"}')).toBe('failed response {"token":…}');
    expect(cleanError("api_key=CANARY_C access_token=CANARY_D")).toBe("api_key=… access_token=…");
  });

  it("stays fast on huge or label-heavy text, and the endpoint refuses error text longer than the browser sends", () => {
    for (const text of ["a".repeat(1_000_000), "api_key".repeat(100_000), "key: ".repeat(100_000)]) {
      const start = performance.now();
      expect(cleanError(text).length).toBeLessThanOrEqual(MAX_ERROR_CHARS);
      expect(performance.now() - start).toBeLessThan(50);
    }
    expect(parseStallEvent({ ...good, errors: ["a".repeat(MAX_ERROR_CHARS + 1)] }, NOW)).toBeNull();
    expect(parseStallEvent({ ...good, errors: ["a".repeat(MAX_ERROR_CHARS)] }, NOW)).not.toBeNull();
  });

  it("leaves ordinary error text alone", () => {
    for (const text of [
      "TypeError: undefined is not an object (evaluating 'a.b')",
      "TypeError: Load failed",
      "Cannot read properties of undefined (reading 'token')",
      "key is undefined",
    ]) {
      expect(cleanError(text)).toBe(text);
    }
  });
});

describe("describeStall", () => {
  const base = { stage: null, dataMs: null, aliveMs: null, hiddenMs: null };
  it("says what was measured, on one clock, and never a cause", () => {
    expect(describeStall({ ...base, kind: "slow", stage: "shown", waitedMs: 11_000, dataMs: 6_000, hiddenMs: 1_000 })).toBe(
      "Finished after 11 s on screen: ready to draw after 6 s, then 5 s more to finish.",
    );
    expect(describeStall({ ...base, kind: "superseded", stage: "started", waitedMs: 25_300 })).toBe(
      "Another page was opened after 25.3 s on screen; it never got as far as ready to draw (its data or code had not loaded).",
    );
    expect(describeStall({ ...base, kind: "unfinished", stage: "data", waitedMs: 20_000, dataMs: 400, aliveMs: 20_000, hiddenMs: 20_000 })).toBe(
      "The app closed with this page still loading; it was ready to draw after 400 ms on screen, but never finished. It was still running when the app went to the background 20 s after it started.",
    );
    expect(describeStall({ ...base, kind: "unfinished", stage: "started", waitedMs: 2_000, aliveMs: 2_000 })).toContain(
      "Its last saved heartbeat was 2 s after it started, while still on screen; nothing after that.",
    );
    expect(describeStall({ ...base, kind: "freeze", waitedMs: 3_000 })).toBe("No heartbeat for about 3 s while on screen, then it resumed.");
    for (const kind of ["slow", "superseded", "unfinished", "reloaded", "lost", "freeze"] as const) {
      expect(describeStall({ ...base, kind, waitedMs: 1_000, dataMs: 2_000 })).not.toMatch(/-\d|froze or crashed|waiting, not frozen/);
    }
  });
});

describe("deviceLabel", () => {
  it("names the owner's phone, a Mac and the other common browsers", () => {
    expect(
      deviceLabel(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0.1 Mobile/15E148 Safari/604.1",
        true,
      ),
    ).toBe("iPhone · Safari 27.0.1 · installed app");
    expect(
      deviceLabel(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5.2 Safari/605.1.15",
        false,
      ),
    ).toBe("Mac · Safari 26.5.2");
    expect(deviceLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36", false)).toBe(
      "Windows · Chrome 122",
    );
    expect(deviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1", false)).toBe(
      "iPhone · Chrome 130",
    );
    expect(deviceLabel("", false)).toBe("Unknown device");
  });
});
