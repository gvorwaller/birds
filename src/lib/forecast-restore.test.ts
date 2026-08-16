import { describe, expect, it } from "vitest";
import { hasIdentityParam, restoreDecision } from "./forecast-restore";

describe("restoreDecision (td-671082)", () => {
  const SAVED = "place=St.+Petersburg%2C+FL&month=8";

  it("bare arrival with a saved search → restore with the saved params", () => {
    expect(restoreDecision("", SAVED)).toEqual({ restore: true, target: SAVED });
  });

  it("month-only arrival restores, with the CURRENT month merged over (GROK #5)", () => {
    const d = restoreDecision("month=12", SAVED);
    expect(d.restore).toBe(true);
    if (d.restore) {
      const sp = new URLSearchParams(d.target);
      expect(sp.get("month")).toBe("12");
      expect(sp.get("place")).toBe("St. Petersburg, FL");
    }
  });

  it("dist-only arrival restores with dist merged", () => {
    const d = restoreDecision("dist=25", SAVED);
    expect(d.restore).toBe(true);
    if (d.restore) {
      expect(new URLSearchParams(d.target).get("dist")).toBe("25");
    }
  });

  it("identity in the current url → NO restore (the loop guard property)", () => {
    expect(restoreDecision("place=Bangor%2C+ME", SAVED).restore).toBe(false);
    expect(restoreDecision("lat=27.7&lng=-82.6&loc=Pin", SAVED).restore).toBe(false);
    expect(restoreDecision("species=snakit&region=US-FL", SAVED).restore).toBe(false);
  });

  it("explicit clear wins: PRESENT-but-empty identity keys block the restore (CODEX1 #8)", () => {
    expect(restoreDecision("place=&dist=40", SAVED).restore).toBe(false);
    expect(restoreDecision("q=", SAVED).restore).toBe(false);
  });

  it("no saved identity VALUE → no restore (an empty saved place restores nothing)", () => {
    expect(restoreDecision("", null).restore).toBe(false);
    expect(restoreDecision("", "").restore).toBe(false);
    expect(restoreDecision("", "place=&dist=40").restore).toBe(false);
    expect(restoreDecision("", "month=8&dist=25").restore).toBe(false);
  });

  it("hasIdentityParam: the post-goto verification predicate", () => {
    expect(hasIdentityParam("?place=X")).toBe(true);
    expect(hasIdentityParam("?place=")).toBe(true); // present counts — clear state
    expect(hasIdentityParam("?month=8")).toBe(false);
    expect(hasIdentityParam("")).toBe(false);
  });
});
