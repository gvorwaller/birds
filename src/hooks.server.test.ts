/**
 * The public surface of the app, pinned (td-8b959f follow-up). Everything
 * not listed here requires a session — accidentally widening a prefix is a
 * data leak, accidentally narrowing one breaks share links and health checks.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("$server/session", () => ({ validateSession: vi.fn(), SESSION_COOKIE_NAME: "s" }));
vi.mock("$server/access", () => ({ scopeOwnerId: vi.fn() }));
vi.mock("$env/dynamic/private", () => ({ env: {} }));

import { isPublicPath } from "./hooks.server";

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
    for (const p of ["/", "/trips", "/trips/7", "/loginx", "/api/healthz", "/sharex/y"]) {
      expect(isPublicPath(p), p).toBe(false);
    }
  });
});
