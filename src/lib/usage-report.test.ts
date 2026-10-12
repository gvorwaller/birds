import { beforeEach, describe, expect, it, vi } from "vitest";
import { reportPageUse, resetPageUseReports } from "./usage-report";

const ok = () => vi.fn(async () => new Response(null, { status: 204 }));
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("browser usage report (td-c8e6a3)", () => {
  beforeEach(() => resetPageUseReports());

  it("reports a page shown without an error, once per account, day and section", async () => {
    const send = ok();
    const t = new Date("2026-10-12T10:00:00Z");
    expect(reportPageUse(7, "/species", 200, false, send, t)).toBe(true);
    expect(reportPageUse(7, "/species/[code]", 200, false, send, t)).toBe(false); // same section, same day
    expect(reportPageUse(7, "/forecast", 200, false, send, t)).toBe(true);
    expect(reportPageUse(8, "/species", 200, false, send, t)).toBe(true); // another account in this browser
    expect(reportPageUse(7, "/species", 200, false, send, new Date("2026-10-13T00:00:01Z"))).toBe(true); // next UTC day
    expect(send).toHaveBeenCalledTimes(4);
    expect(send.mock.calls[0]).toEqual([
      "/api/activity",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ routeId: "/species" }), keepalive: true }),
    ]);
  });

  it("never reports an error page, a signed-out view, or an uncounted route", () => {
    const send = ok();
    expect(reportPageUse(7, "/admin", 404, true, send)).toBe(false);
    expect(reportPageUse(7, "/species/[code]", 500, true, send)).toBe(false);
    expect(reportPageUse(7, "/trips", 200, true, send)).toBe(false); // error set, status not
    expect(reportPageUse(null, "/", 200, false, send)).toBe(false);
    expect(reportPageUse(7, "/login", 200, false, send)).toBe(false);
    expect(reportPageUse(7, null, 200, false, send)).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("a failed report is retried on the next page load", async () => {
    const send = vi.fn(async () => new Response(null, { status: 503 }));
    const t = new Date("2026-10-12T10:00:00Z");
    expect(reportPageUse(7, "/", 200, false, send, t)).toBe(true);
    await flush();
    expect(reportPageUse(7, "/", 200, false, send, t)).toBe(true);
    const thrown = vi.fn(async () => { throw new Error("offline"); });
    resetPageUseReports();
    expect(reportPageUse(7, "/", 200, false, thrown as typeof fetch, t)).toBe(true);
    await flush();
    expect(reportPageUse(7, "/", 200, false, thrown as typeof fetch, t)).toBe(true);
  });
});
