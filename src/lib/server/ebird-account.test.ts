/**
 * casLogin error CLASSIFICATION at the source (CODEX1 Phase-3): an outage of
 * Cornell's CAS must surface as EbirdUpstreamError (retryable), never as
 * EbirdLoginError — the pre-fix bug failed sync/frequency jobs terminally on
 * attempt 1 during a plain reachability blip. Exercised through
 * testEbirdLogin with a stubbed global fetch (no network).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/db", () => ({
  query: vi.fn(async () => ({
    rows: [{ login_username_enc: "enc-user", login_password_enc: "enc-pass" }],
  })),
  withTransaction: vi.fn(),
}));
vi.mock("$server/crypto", () => ({
  decryptSecret: (v: string) => v.replace(/^enc-/, ""),
  encryptSecret: (v: string) => `enc-${v}`,
}));

const { testEbirdLogin, syncLifeListFromEbird, EbirdLoginError, EbirdUpstreamError, CookieJar, fetchAuthenticatedEbird } =
  await import("./ebird-account");

const CAS_FORM_HTML = `<form><input type="hidden" name="execution" value="e1s1" /></form>`;

// Constructed Responses have res.url = "" (real fetch sets it), and
// followRedirects resolves Location against res.url — pin a realistic url on
// every fixture or new URL(loc, "") throws and masks the path under test.
function withUrl(r: Response, url: string): Response {
  Object.defineProperty(r, "url", { value: url });
  return r;
}
function html(body: string, status = 200): Response {
  return withUrl(
    new Response(body, { status, headers: { "content-type": "text/html" } }),
    "https://secure.birds.cornell.edu/cas/login",
  );
}
function redirect(location: string): Response {
  return withUrl(
    new Response(null, { status: 302, headers: { location } }),
    "https://secure.birds.cornell.edu/cas/login",
  );
}

let fetchQueue: (Response | Error)[] = [];
const realFetch = globalThis.fetch;

beforeEach(() => {
  fetchQueue = [];
  globalThis.fetch = vi.fn(async () => {
    const next = fetchQueue.shift();
    if (!next) throw new Error("test fetch queue exhausted");
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("casLogin classification (via testEbirdLogin)", () => {
  it("network failure reaching the sign-in page → EbirdUpstreamError, NOT EbirdLoginError", async () => {
    fetchQueue = [new Error("getaddrinfo ENOTFOUND secure.birds.cornell.edu")];
    await expect(testEbirdLogin(1)).rejects.toBeInstanceOf(EbirdUpstreamError);
  });

  it("sign-in page 503 (maintenance) → EbirdUpstreamError with the status", async () => {
    fetchQueue = [html("<h1>down for maintenance</h1>", 503)];
    const err = await testEbirdLogin(1).catch((e) => e);
    expect(err).toBeInstanceOf(EbirdUpstreamError);
    expect((err as InstanceType<typeof EbirdUpstreamError>).status).toBe(503);
  });

  it("login POST fetch rejection → EbirdUpstreamError, NOT a raw TypeError", async () => {
    fetchQueue = [
      html(CAS_FORM_HTML),
      new Error("fetch failed: connection reset"),
    ];
    await expect(testEbirdLogin(1)).rejects.toBeInstanceOf(EbirdUpstreamError);
  });

  it("success-redirect follow rejection → EbirdUpstreamError", async () => {
    fetchQueue = [
      html(CAS_FORM_HTML),
      redirect("https://ebird.org/home"),
      new Error("fetch failed: socket hang up"),
    ];
    await expect(testEbirdLogin(1)).rejects.toBeInstanceOf(EbirdUpstreamError);
  });

  it("login POST 5xx → EbirdUpstreamError; credentials are not blamed", async () => {
    fetchQueue = [html(CAS_FORM_HTML), html("oops", 502)];
    const err = await testEbirdLogin(1).catch((e) => e);
    expect(err).toBeInstanceOf(EbirdUpstreamError);
    expect((err as InstanceType<typeof EbirdUpstreamError>).status).toBe(502);
  });

  it("rejected credentials still classify as EbirdLoginError", async () => {
    fetchQueue = [
      html(CAS_FORM_HTML),
      html("<p>Invalid credentials.</p>", 401),
    ];
    await expect(testEbirdLogin(1)).rejects.toBeInstanceOf(EbirdLoginError);
  });

  it("a missing login form on a 200 page stays EbirdLoginError (auth-flow invalidation)", async () => {
    fetchQueue = [html("<h1>totally new page</h1>")];
    await expect(testEbirdLogin(1)).rejects.toBeInstanceOf(EbirdLoginError);
  });
});

// ---------------------------------------------------------------------------
// CookieJar domain/path/secure-aware tests (CC1 pin B, GROK blocker 4)
// ---------------------------------------------------------------------------

function cookieRes(url: string, ...setCookies: string[]): Response {
  const h = new Headers();
  for (const sc of setCookies) h.append("set-cookie", sc);
  const r = new Response(null, { status: 200, headers: h });
  Object.defineProperty(r, "url", { value: url });
  return r;
}

describe("CookieJar domain/path/secure awareness (pin B)", () => {
  it("CAS JSESSIONID not sent to ebird.org", () => {
    const jar = new CookieJar();
    jar.absorb(
      cookieRes(
        "https://secure.birds.cornell.edu/cassso/login",
        "JSESSIONID=abc123; Path=/cassso; Secure",
      ),
      "https://secure.birds.cornell.edu/cassso/login",
    );
    expect(jar.headerFor("https://secure.birds.cornell.edu/cassso/login")).toContain("JSESSIONID=abc123");
    expect(jar.headerFor("https://ebird.org/lifelist")).toBe("");
  });

  it("ebird.org session cookie set during redirect survives for subsequent requests", () => {
    const jar = new CookieJar();
    // CAS redirect lands on ebird.org with a session cookie
    jar.absorb(
      cookieRes(
        "https://ebird.org/home",
        "EBIRD_SESSIONID=sess456; Domain=ebird.org; Path=/; Secure",
      ),
      "https://ebird.org/home",
    );
    expect(jar.headerFor("https://ebird.org/checklist/S12345")).toContain("EBIRD_SESSIONID=sess456");
    expect(jar.headerFor("https://www.ebird.org/checklist/S12345")).toContain("EBIRD_SESSIONID=sess456");
  });

  it("foreign origin cannot plant cookies for ebird.org", () => {
    const jar = new CookieJar();
    // A redirect through evil.com tries to set Domain=ebird.org
    jar.absorb(
      cookieRes(
        "https://evil.com/redirect",
        "STOLEN=val; Domain=ebird.org; Path=/",
      ),
      "https://evil.com/redirect",
    );
    expect(jar.headerFor("https://ebird.org/home")).toBe("");
  });

  it("rejects public-suffix Domain (Domain=org)", () => {
    const jar = new CookieJar();
    jar.absorb(
      cookieRes(
        "https://ebird.org/home",
        "TOO_BROAD=val; Domain=org; Path=/",
      ),
      "https://ebird.org/home",
    );
    // Should be stored as host-only for ebird.org, not domain-scoped to "org"
    expect(jar.headerFor("https://ebird.org/home")).toContain("TOO_BROAD=val");
    expect(jar.headerFor("https://other.org/page")).toBe("");
  });

  it("Secure cookies not sent over http", () => {
    const jar = new CookieJar();
    jar.absorb(
      cookieRes(
        "https://ebird.org/home",
        "SEC=val; Secure; Path=/",
      ),
      "https://ebird.org/home",
    );
    expect(jar.headerFor("https://ebird.org/page")).toContain("SEC=val");
    expect(jar.headerFor("http://ebird.org/page")).toBe("");
  });

  it("path scoping: /cassso cookie not sent to /other", () => {
    const jar = new CookieJar();
    jar.absorb(
      cookieRes(
        "https://secure.birds.cornell.edu/cassso/login",
        "CAS_TOK=abc; Path=/cassso",
      ),
      "https://secure.birds.cornell.edu/cassso/login",
    );
    expect(jar.headerFor("https://secure.birds.cornell.edu/cassso/login")).toContain("CAS_TOK=abc");
    expect(jar.headerFor("https://secure.birds.cornell.edu/other")).toBe("");
  });

  it("host-only cookie (no Domain attr) not sent to subdomains", () => {
    const jar = new CookieJar();
    jar.absorb(
      cookieRes("https://ebird.org/home", "HOSTONLY=val; Path=/"),
      "https://ebird.org/home",
    );
    expect(jar.headerFor("https://ebird.org/page")).toContain("HOSTONLY=val");
    expect(jar.headerFor("https://sub.ebird.org/page")).toBe("");
  });

  it("full CAS redirect chain: CAS cookies stay on CAS, ebird session on ebird", () => {
    const jar = new CookieJar();
    // Step 1: GET CAS login page → CAS sets JSESSIONID
    jar.absorb(
      cookieRes(
        "https://secure.birds.cornell.edu/cassso/login",
        "JSESSIONID=cas1; Path=/cassso; Secure",
      ),
      "https://secure.birds.cornell.edu/cassso/login",
    );
    // Step 2: POST CAS login → 302 redirect with ticket to ebird.org
    // (no new cookies from CAS on the redirect response itself)
    // Step 3: Follow redirect to ebird.org → ebird sets session
    jar.absorb(
      cookieRes(
        "https://ebird.org/home?ticket=ST-12345",
        "EBIRD_SESSION=ebsess; Domain=ebird.org; Path=/; Secure",
      ),
      "https://ebird.org/home?ticket=ST-12345",
    );

    // CAS cookie goes to CAS, not to ebird
    expect(jar.headerFor("https://secure.birds.cornell.edu/cassso/login")).toContain("JSESSIONID=cas1");
    expect(jar.headerFor("https://ebird.org/checklist/S123")).not.toContain("JSESSIONID");

    // ebird session goes to ebird, not to CAS
    expect(jar.headerFor("https://ebird.org/checklist/S123")).toContain("EBIRD_SESSION=ebsess");
    expect(jar.headerFor("https://secure.birds.cornell.edu/cassso/login")).not.toContain("EBIRD_SESSION");
  });

  it("cookie deletion removes the cookie", () => {
    const jar = new CookieJar();
    jar.absorb(
      cookieRes("https://ebird.org/home", "SID=val; Path=/"),
      "https://ebird.org/home",
    );
    expect(jar.headerFor("https://ebird.org/page")).toContain("SID=val");
    jar.absorb(
      cookieRes("https://ebird.org/home", "SID=deleted; Path=/"),
      "https://ebird.org/home",
    );
    expect(jar.headerFor("https://ebird.org/page")).toBe("");
  });
});

describe("fetchAuthenticatedEbird host allowlist", () => {
  it("rejects api.ebird.org (must use API-key path, not CAS session)", async () => {
    await expect(
      fetchAuthenticatedEbird(1, "https://api.ebird.org/v2/ref/hotspot/info/L123"),
    ).rejects.toThrow(/refuses non-eBird host/);
  });
});

describe("life-list CSV export classification (GROK Phase-3 P2)", () => {
  // A full successful CAS login, then the export response under test.
  function loginOkThen(...rest: (Response | Error)[]): (Response | Error)[] {
    return [
      html(CAS_FORM_HTML),
      redirect("https://ebird.org/home"),
      html("<h1>home</h1>"),
      ...rest,
    ];
  }

  it("export 5xx after a successful login → EbirdUpstreamError (retryable), never terminal", async () => {
    fetchQueue = loginOkThen(html("<h1>bad gateway</h1>", 502));
    const err = await syncLifeListFromEbird(1).catch((e) => e);
    expect(err).toBeInstanceOf(EbirdUpstreamError);
    expect((err as InstanceType<typeof EbirdUpstreamError>).status).toBe(502);
  });

  it("export 429 → EbirdUpstreamError(429)", async () => {
    fetchQueue = loginOkThen(html("slow down", 429));
    const err = await syncLifeListFromEbird(1).catch((e) => e);
    expect(err).toBeInstanceOf(EbirdUpstreamError);
    expect((err as InstanceType<typeof EbirdUpstreamError>).status).toBe(429);
  });

  it("export fetch rejection → EbirdUpstreamError", async () => {
    fetchQueue = loginOkThen(new Error("fetch failed: connection reset"));
    await expect(syncLifeListFromEbird(1)).rejects.toBeInstanceOf(EbirdUpstreamError);
  });

  it("an HTML page on a 200 export stays EbirdLoginError (flow change / session bounce)", async () => {
    fetchQueue = loginOkThen(html("<html>please sign in</html>"));
    await expect(syncLifeListFromEbird(1)).rejects.toBeInstanceOf(EbirdLoginError);
  });
});
