/**
 * The public surface of the app, pinned (td-8b959f follow-up). Everything
 * not listed here requires a session — accidentally widening a prefix is a
 * data leak, accidentally narrowing one breaks share links and health checks.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("$server/session", () => ({ validateSession: vi.fn(), SESSION_COOKIE_NAME: "s" }));
vi.mock("$server/access", () => ({ scopeOwnerId: vi.fn() }));
vi.mock("$env/dynamic/private", () => ({ env: {} }));

import { handle, isPublicPath } from "./hooks.server";

describe("isPublicPath", () => {
  it("share links are public by prefix — the token is the credential", () => {
    expect(isPublicPath("/share/trip/abc123")).toBe(true);
  });

  it("bare /share is NOT public (nothing lives there)", () => {
    expect(isPublicPath("/share")).toBe(false);
  });

  it("exact public paths unchanged", () => {
    expect(isPublicPath("/login")).toBe(true);
    expect(isPublicPath("/api/health")).toBe(true);
    expect(isPublicPath("/api/internal/trip-places")).toBe(true);
  });

  it("everything else stays private — including lookalikes", () => {
    for (const p of ["/", "/trips", "/trips/7", "/settings/appearance", "/loginx", "/api/healthz", "/sharex/y"]) {
      expect(isPublicPath(p), p).toBe(false);
    }
  });
});

it("lets a viewer set personal interest without allowing adjacent or owner mutations", async () => {
  for (const [path,method,expected] of [
    ['/api/special-interest','POST',200],
    ['/api/special-interest-extra','POST',403],
    ['/api/special-interest','DELETE',403],
    ['/settings?/save_api_key','POST',403],
    ['/trips?/create','POST',403],
  ] as const) {
    const url = new URL('http://localhost'+path);
    const resolve = vi.fn(async () => new Response('resolved'));
    const event = {url, request:new Request(url,{method}), locals:{user:{id:2,role:'viewer'},scopeId:1}, cookies:{get:()=>undefined}};
    const response = await handle({event,resolve} as unknown as Parameters<typeof handle>[0]);
    expect(response.status).toBe(expected);
    await response.text();
    expect(resolve).toHaveBeenCalledTimes(expected===200 ? 1:0);
  }
});
