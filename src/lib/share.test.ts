/**
 * share.ts (ported trips-app pattern). Pins: node-env safety via the browser
 * guard, and the share-sheet outcome mapping (AbortError is a cancel, not a
 * failure — surfacing it as an error was the trips app's original bug).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const envMock = vi.hoisted(() => ({ browser: false }));
vi.mock("$app/environment", () => envMock);

import { canShareText, isIosStandalone, shareText } from "./share";

const g = globalThis as { navigator?: unknown };

afterEach(() => {
  envMock.browser = false;
  delete g.navigator;
});

describe("node-env safety (browser guard)", () => {
  it("everything is inert outside the browser", async () => {
    expect(isIosStandalone()).toBe(false);
    expect(canShareText()).toBe(false);
    await expect(shareText("x")).resolves.toBe("unavailable");
  });
});

describe("shareText outcome mapping", () => {
  it("no navigator.share → 'unavailable' (fall back to copy)", async () => {
    envMock.browser = true;
    g.navigator = {};
    await expect(shareText("x")).resolves.toBe("unavailable");
  });

  it("successful share → 'shared'", async () => {
    envMock.browser = true;
    g.navigator = { share: vi.fn().mockResolvedValue(undefined) };
    await expect(shareText("field sheet", "Trip")).resolves.toBe("shared");
  });

  it("PINNED: user closing the sheet (AbortError) is 'cancelled', never an error", async () => {
    envMock.browser = true;
    g.navigator = {
      share: vi.fn().mockRejectedValue(new DOMException("cancel", "AbortError")),
    };
    await expect(shareText("x")).resolves.toBe("cancelled");
  });

  it("any other throw → 'failed'", async () => {
    envMock.browser = true;
    g.navigator = { share: vi.fn().mockRejectedValue(new Error("denied")) };
    await expect(shareText("x")).resolves.toBe("failed");
  });
});
