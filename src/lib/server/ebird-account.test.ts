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

const { testEbirdLogin, EbirdLoginError, EbirdUpstreamError } = await import(
  "./ebird-account"
);

const CAS_FORM_HTML = `<form><input type="hidden" name="execution" value="e1s1" /></form>`;

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html" },
  });
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
      new Response(null, { status: 302, headers: { location: "https://ebird.org/home" } }),
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
