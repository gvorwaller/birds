import { describe, expect, it } from "vitest";
import { FREEZE_MS, SLOW_NAV_MS, describeStall } from "$lib/client-stalls";
import {
  ANSWER_MS,
  BEAT_MS,
  CLAIM_EVERY_MS,
  FALLBACK_MS,
  RECHECK_MS,
  RETRY_EVERY_MS,
  STALE_MS,
  NavWatch,
  type NavLike,
  type NavWatchDeps,
  type RollCall,
  type StorageLike,
} from "$lib/nav-watch";

/** One browser profile: shared storage, a clock, timers and a BroadcastChannel its pages join. */
function browser() {
  const map = new Map<string, string>();
  const storage: StorageLike = {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    key: (i) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
  let t = 1_000_000;
  let timers: { at: number; fn: () => void; owner: object }[] = [];
  const listeners = new Set<(m: RollCall) => void>();
  let ids = 0;
  const sent: { events: { kind: string; id: string }[] }[] = [];
  const b = {
    map,
    sent,
    now: () => t,
    tabs: () => [...map.keys()].filter((k) => k.startsWith("birds.navWatch.tab.")),
    /** Moves the clock, running due timers (except those of dead pages). */
    advance(ms: number) {
      const end = t + ms;
      for (;;) {
        const due = timers.filter((x) => x.at <= end).sort((x, y) => x.at - y.at)[0];
        if (!due) break;
        timers = timers.filter((x) => x !== due);
        t = Math.max(t, due.at);
        due.fn();
      }
      t = end;
    },
    page(
      over: Omit<Partial<NavWatchDeps>, "standalone" | "version"> & {
        visible?: () => boolean;
        noChannel?: boolean;
        standalone?: boolean;
        version?: string;
        path?: string;
      } = {},
    ) {
      const { noChannel, standalone, version, path, ...rest } = over;
      const own = new Set<(m: RollCall) => void>();
      const owner = {};
      /** False once the page is dead or suspended: it neither answers nor runs timers. */
      let running = true;
      const deps: NavWatchDeps = {
        storage,
        now: () => t,
        uuid: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
        send: async (events) => {
          sent.push({ events });
          return true;
        },
        version: version ?? "build-a",
        standalone: () => standalone ?? false,
        online: () => true,
        visible: () => true,
        location: () => path ?? "/",
        channel: noChannel
          ? null
          : {
              post: (m) => [...listeners].filter((l) => !own.has(l)).forEach((l) => l(m)),
              listen: (fn) => {
                own.add(fn);
                listeners.add(fn);
              },
            },
        later: (fn, ms) => void timers.push({ at: t + ms, fn: () => running && fn(), owner }),
        ...rest,
      };
      const w = new NavWatch(deps);
      return {
        w,
        /** The page dies or freezes for good: it stops answering and its timers stop. */
        kill: () => {
          running = false;
          own.forEach((l) => listeners.delete(l));
        },
        /** Busy or suspended for a while: no answers, no timers. */
        mute: () => {
          running = false;
          own.forEach((l) => listeners.delete(l));
        },
        unmute: () => {
          running = true;
          own.forEach((l) => listeners.add(l));
        },
      };
    },
  };
  return b;
}

const nav = (to: string, path = to, type = "link", from: string | null = "/species/[code]"): NavLike => ({
  type,
  willUnload: false,
  from: from ? { route: { id: from } } : null,
  to: { route: { id: to }, url: new URL(`http://x${path}`) },
});
const enter = nav("/", "/", "enter", null);

/** Ticks a live page through `ms` the way its interval would. */
function run(b: ReturnType<typeof browser>, pages: { w: NavWatch }[], ms: number) {
  for (let left = ms; left > 0; left -= BEAT_MS) {
    b.advance(Math.min(BEAT_MS, left));
    pages.forEach((p) => p.w.tick());
  }
}

describe("NavWatch (td-1cb094)", () => {
  it("reports a navigation finished after SLOW_NAV_MS with its milestones; a quick one is not reported", () => {
    const b = browser();
    const { w } = b.page();
    w.start();
    w.setUser(1);
    const quick = nav("/species/[code]", "/species/indbun");
    w.begin(quick);
    run(b, [{ w }], 400);
    w.dataReady(quick);
    run(b, [{ w }], 200);
    w.shown(quick, "/species/[code]", "/species/indbun");
    expect(w.queued()).toEqual([]);

    const slow = nav("/species/[code]", "/species/blugrb1");
    w.begin(slow);
    run(b, [{ w }], 500);
    w.dataReady(slow);
    run(b, [{ w }], SLOW_NAV_MS);
    w.shown(slow, "/species/[code]", "/species/blugrb1");
    expect(w.queued()).toMatchObject([
      { kind: "slow", toRoute: "/species/[code]", toPath: "/species/blugrb1", stage: "shown", dataMs: 500, waitedMs: 500 + SLOW_NAV_MS, navType: "link", version: "build-a" },
    ]);
  });

  it("follows overlapping navigations by identity: a second tap while the first still loads (no beforeNavigate for it)", () => {
    const b = browser();
    const { w } = b.page();
    w.start();
    w.setUser(1);
    const first = nav("/species/[code]", "/species/blugrb1");
    const second = nav("/species", "/species", "link");
    w.begin(first);
    run(b, [{ w }], 25_000);
    w.begin(second); // the `navigating` store moved on; SvelteKit's beforeNavigate did not run
    w.dataReady(first); // a late milestone of the abandoned navigation is ignored
    run(b, [{ w }], 300);
    w.dataReady(second);
    w.shown(second, "/species", "/species");
    expect(w.queued()).toMatchObject([{ kind: "superseded", toPath: "/species/blugrb1", stage: "started", dataMs: null, waitedMs: 25_000 }]);
  });

  it("counts only the time on screen: a navigation left while the app was in the background is not slow", () => {
    let visible = true;
    const b = browser();
    const { w } = b.page({ visible: () => visible });
    w.start();
    w.setUser(1);
    const n = nav("/species/[code]", "/species/x");
    w.begin(n);
    run(b, [{ w }], 1_000);
    visible = false;
    w.visibility();
    b.advance(60_000);
    visible = true;
    w.visibility();
    w.dataReady(n);
    w.shown(n, "/species/[code]", "/species/x");
    expect(w.queued()).toEqual([]);
  });

  it("counts on-screen waiting after a return from the background, and none of a navigation started while hidden", () => {
    let visible = true;
    const b = browser();
    const { w } = b.page({ visible: () => visible });
    w.start();
    w.setUser(1);
    const n = nav("/species/[code]", "/species/x");
    w.begin(n);
    run(b, [{ w }], 1_000);
    visible = false;
    w.visibility();
    b.advance(1_000);
    visible = true;
    w.visibility();
    run(b, [{ w }], 5_000);
    w.dataReady(n);
    run(b, [{ w }], 5_000);
    w.shown(n, "/species/[code]", "/species/x");
    expect(w.queued()).toMatchObject([{ kind: "slow", waitedMs: 11_000, dataMs: 6_000, hiddenMs: 1_000 }]);
    expect(describeStall(w.queued()[0])).toBe("Finished after 11 s on screen: ready to draw after 6 s, then 5 s more to finish.");

    visible = false;
    w.visibility();
    const bg = nav("/species/[code]", "/species/y");
    w.begin(bg);
    b.advance(60_000);
    visible = true;
    w.visibility();
    run(b, [{ w }], 500);
    w.shown(bg, "/species/[code]", "/species/y");
    expect(w.queued()).toHaveLength(1);
  });

  it("ignores full-page navigations, leaving the app and the first page", () => {
    const b = browser();
    const { w } = b.page();
    w.start();
    w.setUser(1);
    w.begin({ ...nav("/species/[code]"), willUnload: true });
    w.begin({ ...nav("/species/[code]"), type: "leave" });
    w.begin(enter);
    run(b, [{ w }], 10_000);
    w.shown(enter, "/", "/");
    expect(w.queued()).toEqual([]);
  });

  it("reports a heartbeat gap of FREEZE_MS or more while visible, not a gap spent in the background, and sends it within RETRY_EVERY_MS", () => {
    let visible = true;
    const b = browser();
    const { w } = b.page({ visible: () => visible });
    w.start();
    w.setUser(1);
    w.shown(enter, "/species/[code]", "/species/indbun");
    run(b, [{ w }], BEAT_MS);
    b.advance(BEAT_MS + FREEZE_MS + 500);
    w.tick();
    expect(w.queued()).toMatchObject([{ kind: "freeze", toRoute: "/species/[code]", toPath: "/species/indbun", stage: null, waitedMs: FREEZE_MS + 500 }]);

    visible = false;
    w.visibility();
    b.advance(60_000);
    visible = true;
    w.tick();
    run(b, [{ w }], RETRY_EVERY_MS);
    expect(b.sent.flatMap((s) => s.events.map((e) => e.kind))).toContain("freeze");
  });

  it("keeps errors raised during a navigation, with addresses, queries and credentials blanked", () => {
    const b = browser();
    const { w } = b.page();
    w.start();
    w.setUser(1);
    w.error("ignored: nothing in progress");
    const n = nav("/species/[code]", "/species/blugrb1");
    w.begin(n);
    w.error("TypeError: Load failed https://birds.example/api/x?token=abc\n(at y)");
    w.error({ toString: null });
    w.error(new Error("password: hunter2"));
    run(b, [{ w }], SLOW_NAV_MS);
    w.shown(n, "/species/[code]", "/species/blugrb1");
    expect(w.queued()[0].errors).toEqual(["TypeError: Load failed /api/x (at y)", "Error: password: …"]);
  });

  describe("the installed app (one page at a time)", () => {
    it("reports a navigation the killed page never finished as soon as the app reopens, with the old page's build and account", () => {
      let visible = true;
      const b = browser();
      const old = b.page({ standalone: true, visible: () => visible });
      old.w.start();
      old.w.setUser(1);
      const n = nav("/species/[code]", "/species/blugrb1");
      old.w.begin(n);
      run(b, [old], 400);
      old.w.dataReady(n);
      run(b, [old], 19_600);
      visible = false;
      old.w.visibility(); // app switcher
      old.kill();
      b.advance(2_000); // killed and reopened within seconds, after a deploy

      const fresh = b.page({ standalone: true, version: "build-b" });
      fresh.w.start();
      fresh.w.setUser(1);
      expect(fresh.w.queued()).toEqual([]);
      b.advance(ANSWER_MS);
      expect(fresh.w.queued()).toMatchObject([
        { kind: "unfinished", toPath: "/species/blugrb1", stage: "data", dataMs: 400, aliveMs: 20_000, hiddenMs: 20_000, version: "build-a", standalone: true },
      ]);
      expect(b.tabs()).toHaveLength(1);
    });

    it("reports a page that stopped on screen with nothing in progress as lost; a clean exit is not reported", () => {
      const b = browser();
      const frozen = b.page({ standalone: true });
      frozen.w.start();
      frozen.w.setUser(1);
      frozen.w.shown(enter, "/hotspots/[locId]", "/hotspots/L123");
      frozen.kill();
      const clean = b.page({ standalone: true });
      clean.w.start();
      clean.w.setUser(1);
      clean.w.pageHide(false);
      clean.kill();
      b.advance(1_000);

      const fresh = b.page({ standalone: true });
      fresh.w.start();
      fresh.w.setUser(1);
      b.advance(ANSWER_MS);
      expect(fresh.w.queued()).toMatchObject([{ kind: "lost", toRoute: "/hotspots/[locId]", toPath: "/hotspots/L123", waitedMs: 0 }]);
      expect(b.tabs()).toHaveLength(1);
    });
  });

  describe("browser tabs (other pages may be live)", () => {
    it("reports an on-screen page only after it misses two roll calls RECHECK_MS apart", () => {
      const b = browser();
      const old = b.page();
      old.w.start();
      old.w.setUser(1);
      const n = nav("/species/[code]", "/species/blugrb1");
      old.w.begin(n);
      run(b, [old], 3_000);
      old.kill();

      const fresh = b.page();
      fresh.w.start();
      fresh.w.setUser(1);
      run(b, [fresh], ANSWER_MS);
      expect(fresh.w.queued()).toEqual([]);
      run(b, [fresh], RECHECK_MS + ANSWER_MS);
      // The last heartbeat it saved (state is saved every SAVE_EVERY_MS between milestones).
      expect(fresh.w.queued()).toMatchObject([{ kind: "unfinished", toPath: "/species/blugrb1", aliveMs: 2_000, hiddenMs: null }]);
    });

    it("leaves alone a page that was only busy for the first roll call", () => {
      const b = browser();
      const busy = b.page();
      busy.w.start();
      busy.w.setUser(1);
      busy.w.begin(nav("/species/[code]", "/species/blugrb1"));
      busy.mute();
      const fresh = b.page();
      fresh.w.start();
      fresh.w.setUser(1);
      run(b, [busy, fresh], ANSWER_MS);
      busy.unmute();
      run(b, [busy, fresh], RECHECK_MS + ANSWER_MS + CLAIM_EVERY_MS);
      expect(fresh.w.queued()).toEqual([]);
      expect(b.tabs()).toHaveLength(2);
    });

    it("never reports a hidden tab that does not answer (it may only be suspended)", () => {
      let visible = true;
      const b = browser();
      const bg = b.page({ visible: () => visible });
      bg.w.start();
      bg.w.setUser(1);
      bg.w.begin(nav("/species/[code]", "/species/blugrb1"));
      visible = false;
      bg.w.visibility();
      bg.mute();
      const fresh = b.page();
      fresh.w.start();
      fresh.w.setUser(1);
      run(b, [fresh], 3 * CLAIM_EVERY_MS);
      expect(fresh.w.queued()).toEqual([]);
    });

    it("picks up a page that died moments before this one opened, on a later check (no BroadcastChannel)", () => {
      const b = browser();
      const old = b.page({ noChannel: true });
      old.w.start();
      old.w.setUser(1);
      old.w.begin(nav("/species/[code]", "/species/blugrb1"));
      run(b, [old], 2_000);
      old.kill();
      const fresh = b.page({ noChannel: true });
      fresh.w.start();
      fresh.w.setUser(1);
      expect(fresh.w.queued()).toEqual([]);
      run(b, [fresh], STALE_MS + CLAIM_EVERY_MS);
      expect(fresh.w.queued()).toMatchObject([{ kind: "unfinished", toPath: "/species/blugrb1" }]);
    });
  });

  describe("reloads", () => {
    it("reports a navigation cut off by a reload as reloaded", () => {
      const b = browser();
      const old = b.page();
      old.w.start();
      old.w.setUser(1);
      old.w.begin(nav("/species/[code]", "/species/blugrb1"));
      run(b, [old], 7_000);
      old.w.pageHide(false);
      old.kill();
      const fresh = b.page({ path: "/species/indbun" });
      fresh.w.start();
      fresh.w.setUser(1);
      run(b, [fresh], ANSWER_MS);
      expect(fresh.w.queued()).toEqual([]); // the destination may still be loading
      run(b, [fresh], FALLBACK_MS + RECHECK_MS + ANSWER_MS);
      expect(fresh.w.queued()).toMatchObject([{ kind: "reloaded", toPath: "/species/blugrb1", waitedMs: 7_000 }]);
    });

    it("does not report SvelteKit's full-page fallback that lands on the destination", () => {
      const b = browser();
      const old = b.page();
      old.w.start();
      old.w.setUser(1);
      old.w.begin(nav("/species/[code]", "/species/blugrb1"));
      run(b, [old], 400);
      old.w.pageHide(false);
      old.kill();
      const fresh = b.page({ path: "/species/blugrb1" });
      fresh.w.start();
      fresh.w.setUser(1);
      b.advance(ANSWER_MS);
      expect(fresh.w.queued()).toEqual([]);
      expect(b.tabs()).toHaveLength(1);
    });

    it("lets the destination settle SvelteKit's fallback: another open tab does not call it reloaded", () => {
      const b = browser();
      const old = b.page({ path: "/species/indbun" });
      old.w.start();
      old.w.setUser(1);
      old.w.begin(nav("/species/[code]", "/species/target"));
      run(b, [old], 400);
      old.w.pageHide(false);
      old.kill();
      const observer = b.page({ path: "/species/unrelated" });
      observer.w.start();
      observer.w.setUser(1);
      run(b, [observer], ANSWER_MS); // the unrelated tab checks first, while the destination is loading
      run(b, [observer], 2_000);
      const replacement = b.page({ path: "/species/target" });
      replacement.w.start();
      replacement.w.setUser(1);
      run(b, [observer, replacement], RECHECK_MS + 2 * ANSWER_MS);
      expect([...observer.w.queued(), ...replacement.w.queued()]).toEqual([]);
      expect(b.tabs()).toHaveLength(2);
    });

    it("lets another tab report a reload that never reached its destination, once the window has passed", () => {
      const b = browser();
      const observer = b.page({ path: "/species/unrelated" });
      observer.w.start();
      observer.w.setUser(1);
      const old = b.page();
      old.w.start();
      old.w.setUser(1);
      old.w.begin(nav("/species/[code]", "/species/target"));
      run(b, [observer, old], 400);
      old.w.pageHide(false);
      old.kill();
      run(b, [observer], CLAIM_EVERY_MS + RECHECK_MS + 3 * ANSWER_MS);
      expect(observer.w.queued()).toMatchObject([{ kind: "reloaded", toPath: "/species/target" }]);
    });

    it("treats a page kept in the back/forward cache as hidden, not gone", () => {
      const b = browser();
      const kept = b.page();
      kept.w.start();
      kept.w.setUser(1);
      kept.w.begin(nav("/species/[code]", "/species/blugrb1"));
      kept.w.pageHide(true);
      kept.mute();
      const fresh = b.page();
      fresh.w.start();
      fresh.w.setUser(1);
      run(b, [fresh], RECHECK_MS + 2 * ANSWER_MS);
      expect(fresh.w.queued()).toEqual([]);
    });
  });

  describe("accounts", () => {
    it("sends a report only for the account it happened under, and drops what happened signed out", async () => {
      const b = browser();
      let ok = false;
      const { w } = b.page({
        send: async (events) => {
          if (ok) b.sent.push({ events });
          return ok;
        },
      });
      w.start();
      w.setUser(1);
      const a = nav("/species/[code]", "/species/a");
      w.begin(a);
      b.advance(SLOW_NAV_MS);
      w.shown(a, "/species/[code]", "/species/a");
      w.setUser(null);
      const anon = nav("/login", "/login");
      w.begin(anon);
      b.advance(SLOW_NAV_MS);
      w.shown(anon, "/login", "/login");
      expect(w.queued().map((e) => e.toPath)).toEqual(["/species/a"]);
      ok = true;
      w.setUser(2);
      await new Promise((r) => setTimeout(r, 0));
      expect(b.sent).toEqual([]);
      w.setUser(1);
      await new Promise((r) => setTimeout(r, 0));
      expect(b.sent.flatMap((s) => s.events.map((e) => e.kind))).toEqual(["slow"]);
    });

    it("names the account the events were recorded under, so the server can refuse a stale tab's post", async () => {
      const b = browser();
      const accounts: number[] = [];
      const { w } = b.page({
        send: async (_events, accountId) => {
          accounts.push(accountId);
          return false; // e.g. 409: the session now belongs to someone else
        },
      });
      w.start();
      w.setUser(1);
      const n = nav("/species/[code]");
      w.begin(n);
      b.advance(SLOW_NAV_MS);
      w.shown(n, "/species/[code]", "/species/x");
      await new Promise((r) => setTimeout(r, 0));
      expect(accounts).toEqual([1]);
      expect(w.queued()).toHaveLength(1);
    });

    it("keeps reports the server did not store", async () => {
      const b = browser();
      let ok = false;
      const { w } = b.page({ send: async () => ok });
      w.start();
      w.setUser(1);
      const n = nav("/species/[code]");
      w.begin(n);
      b.advance(SLOW_NAV_MS);
      w.shown(n, "/species/[code]", "/species/x");
      await new Promise((r) => setTimeout(r, 0));
      expect(w.queued()).toHaveLength(1);
      ok = true;
      await w.flush(false);
      expect(w.queued()).toHaveLength(0);
    });
  });

  it("never throws when storage does", () => {
    const b = browser();
    const broken: StorageLike = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("full");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
      key: () => {
        throw new Error("blocked");
      },
      length: 1,
    };
    const { w } = b.page({ storage: broken });
    expect(() => {
      w.start();
      w.setUser(1);
      b.advance(ANSWER_MS);
      const n = nav("/species/[code]");
      w.begin(n);
      b.advance(SLOW_NAV_MS);
      w.tick();
      w.shown(n, "/species/[code]", "/species/x");
      w.visibility();
      w.pageHide(false);
    }).not.toThrow();
  });
});
