import { afterEach, describe, expect, it } from "vitest";
import { env } from "$env/dynamic/private";
import {
  XenoCantoError,
  categorizeType,
  fetchXenoCantoRecordings,
  getXenoCantoApiKey,
  licenseUrl,
  normalizeLicense,
  parseDuration,
} from "./xeno-canto";

// $env/dynamic/private bakes a snapshot object at first import (see
// ai-enrichment.test.ts's process.env convention) — later `process.env`
// writes do NOT propagate to it. The snapshot object itself is a plain,
// mutable POJO though, so tests toggle the key by writing directly onto
// the imported `env` binding (same module singleton `xeno-canto.ts` reads).
function setKey(value: string | undefined) {
  if (value === undefined) delete (env as Record<string, string | undefined>).XENO_CANTO_API_KEY;
  else env.XENO_CANTO_API_KEY = value;
}

describe("xeno-canto pure helpers", () => {
  it("categorizeType: substring match on 'song', everything else is a call", () => {
    expect(categorizeType("song")).toBe("song");
    expect(categorizeType("Song")).toBe("song");
    expect(categorizeType("flight song")).toBe("song");
    expect(categorizeType("call")).toBe("call");
    expect(categorizeType("alarm call")).toBe("call");
    expect(categorizeType("flight call")).toBe("call");
    expect(categorizeType("")).toBe("call");
  });

  it("parseDuration: mm:ss and h:mm:ss to seconds; bare integer accepted defensively", () => {
    expect(parseDuration("0:07")).toBe(7);
    expect(parseDuration("1:30")).toBe(90);
    expect(parseDuration("1:02:03")).toBe(3723);
    expect(parseDuration("45")).toBe(45);
    expect(parseDuration("garbage")).toBe(0);
    expect(parseDuration("")).toBe(0);
  });

  it("normalizeLicense: CC licenses and public-domain grants get a short code; unknown passes through", () => {
    expect(normalizeLicense("//creativecommons.org/licenses/by-nc-sa/4.0/")).toBe(
      "CC BY-NC-SA 4.0",
    );
    expect(normalizeLicense("https://creativecommons.org/licenses/by/4.0/")).toBe("CC BY 4.0");
    expect(normalizeLicense("//creativecommons.org/publicdomain/zero/1.0/")).toBe("CC0 1.0");
    expect(normalizeLicense("//example.com/unknown-license")).toBe(
      "//example.com/unknown-license",
    );
  });

  it("licenseUrl: protocol-relative gets an https scheme; absolute URLs pass through", () => {
    expect(licenseUrl("//creativecommons.org/licenses/by/4.0/")).toBe(
      "https://creativecommons.org/licenses/by/4.0/",
    );
    expect(licenseUrl("https://creativecommons.org/licenses/by/4.0/")).toBe(
      "https://creativecommons.org/licenses/by/4.0/",
    );
  });

  it("getXenoCantoApiKey: null when unset/blank, trimmed value when set", () => {
    const orig = env.XENO_CANTO_API_KEY;
    try {
      setKey(undefined);
      expect(getXenoCantoApiKey()).toBeNull();
      setKey("   ");
      expect(getXenoCantoApiKey()).toBeNull();
      setKey("  abc123  ");
      expect(getXenoCantoApiKey()).toBe("abc123");
    } finally {
      setKey(orig);
    }
  });
});

describe("fetchXenoCantoRecordings", () => {
  const origKey = env.XENO_CANTO_API_KEY;
  afterEach(() => {
    setKey(origKey);
  });

  it("missing key throws XenoCantoError WITHOUT making a network call", async () => {
    setKey(undefined);
    let called = 0;
    const fetcher = (async () => {
      called++;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    await expect(fetchXenoCantoRecordings("Limosa fedoa", { fetcher })).rejects.toMatchObject({
      name: "XenoCantoError",
      rateLimited: false,
    });
    expect(called).toBe(0);
  });

  it("invalid scientific name is rejected before any network call", async () => {
    setKey("test-key");
    let called = 0;
    const fetcher = (async () => {
      called++;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    await expect(
      fetchXenoCantoRecordings('inj"ect', { fetcher }),
    ).rejects.toThrow(/invalid sci name/);
    expect(called).toBe(0);
  });

  it("passes the key as a query param (?key=), not a header", async () => {
    setKey("my-secret-key");
    let seenUrl = "";
    const fetcher = (async (input: URL | RequestInfo) => {
      seenUrl = String(input);
      return new Response(JSON.stringify({ recordings: [] }), { status: 200 });
    }) as typeof fetch;
    await fetchXenoCantoRecordings("Limosa fedoa", { fetcher });
    expect(seenUrl).toContain("key=my-secret-key");
    expect(seenUrl).toContain("xeno-canto.org/api/3/recordings");
    // Species tag syntax (sp:"Genus species"); no server-side q: tags —
    // stacked quality tags AND together and would match nothing.
    const query = new URL(seenUrl).searchParams.get("query");
    expect(query).toBe('sp:"Limosa fedoa"');
  });

  it("HTTP 200 body WITHOUT a recordings array (e.g. message-only error) throws, not empty success", async () => {
    setKey("test-key");
    const fetcher = (async () =>
      new Response(JSON.stringify({ message: "invalid key" }), {
        status: 200,
      })) as typeof fetch;
    await expect(fetchXenoCantoRecordings("Limosa fedoa", { fetcher })).rejects.toMatchObject({
      name: "XenoCantoError",
      rateLimited: false,
    });
  });

  it("error OBJECT payload ({code, message}) surfaces its message", async () => {
    setKey("test-key");
    const fetcher = (async () =>
      new Response(
        JSON.stringify({ error: { code: "bad_query", message: "unknown tag" } }),
        { status: 200 },
      )) as typeof fetch;
    await expect(fetchXenoCantoRecordings("Limosa fedoa", { fetcher })).rejects.toThrow(
      /unknown tag/,
    );
  });

  it("picks one song (shortest A/B) and one call, filters by 3-60s duration and A/B quality", async () => {
    setKey("test-key");
    const fetcher = (async () =>
      new Response(
        JSON.stringify({
          recordings: [
            { id: "1", file: "u1", type: "song", q: "C", len: "0:10", rec: "R1", lic: "//creativecommons.org/licenses/by-nc-sa/4.0/" }, // quality C — rejected
            { id: "2", file: "u2", type: "song", q: "B", len: "0:02", rec: "R2", lic: "//creativecommons.org/licenses/by-nc-sa/4.0/" }, // too short (<3s) — rejected
            { id: "3", file: "u3", type: "song", q: "B", len: "0:20", rec: "R3", lic: "//creativecommons.org/licenses/by-nc-sa/4.0/" },
            { id: "4", file: "u4", type: "song", q: "A", len: "0:15", rec: "R4", lic: "//creativecommons.org/licenses/by-nc-sa/4.0/" }, // best song: A beats B
            { id: "5", file: "u5", type: "alarm call", q: "A", len: "0:08", rec: "R5", lic: "//creativecommons.org/licenses/by/4.0/", loc: "Some Marsh" },
          ],
        }),
        { status: 200 },
      )) as typeof fetch;
    const { song, call } = await fetchXenoCantoRecordings("Limosa fedoa", { fetcher });
    expect(song?.xcId).toBe("XC4"); // quality A wins over B
    expect(song?.quality).toBe("A");
    expect(call?.xcId).toBe("XC5");
    expect(call?.location).toBe("Some Marsh");
    expect(call?.license).toBe("CC BY 4.0");
    expect(call?.sourceUrl).toBe("https://xeno-canto.org/5");
  });

  it("HTTP 429 → XenoCantoError with rateLimited true", async () => {
    setKey("test-key");
    const fetcher = (async () => new Response("busy", { status: 429 })) as typeof fetch;
    await expect(fetchXenoCantoRecordings("Limosa fedoa", { fetcher })).rejects.toMatchObject({
      name: "XenoCantoError",
      status: 429,
      rateLimited: true,
    });
  });

  it("network failure wraps into XenoCantoError", async () => {
    setKey("test-key");
    const fetcher = (async () => {
      throw new Error("fetch failed");
    }) as typeof fetch;
    await expect(fetchXenoCantoRecordings("Limosa fedoa", { fetcher })).rejects.toBeInstanceOf(
      XenoCantoError,
    );
  });

  it("no matching recordings → both song and call are null, not an error", async () => {
    setKey("test-key");
    const fetcher = (async () =>
      new Response(JSON.stringify({ recordings: [] }), { status: 200 })) as typeof fetch;
    const { song, call } = await fetchXenoCantoRecordings("Limosa fedoa", { fetcher });
    expect(song).toBeNull();
    expect(call).toBeNull();
  });
});
