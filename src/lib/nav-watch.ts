/**
 * Browser side of Stuck pages (td-1cb094, under td-c4a58d). Watches this tab's
 * navigations and reports the ones that went wrong (kinds in client-stalls.ts),
 * by SvelteKit's own milestones:
 *
 *   start (the `navigating` store: every navigation, including one started
 *   while another is still loading, which beforeNavigate skips)
 *   → ready to draw (onNavigate: data and code loaded, history updated)
 *   → finished (afterNavigate)
 *
 * Each milestone is matched to the navigation object it belongs to.
 *
 * A heartbeat runs every BEAT_MS. A gap of FREEZE_MS or more while the page
 * stayed visible is a freeze. The tab's state (heartbeat, visibility, the
 * navigation in progress, its build and account) is saved to localStorage at
 * each milestone and every SAVE_EVERY_MS, so a hang that ends with the app
 * being killed is still reported by the next page of the app.
 *
 * When is an earlier page gone? The installed app (home-screen) runs one page
 * at a time, so a new one starting proves the old one is gone. In a browser,
 * other tabs may be live: this page asks them over a BroadcastChannel (a roll
 * call), and a page counts as gone only after missing two roll calls
 * RECHECK_MS apart while its last heartbeat said it was on screen. A hidden
 * browser tab that misses them may only be suspended, so it is never
 * reported. Without BroadcastChannel a heartbeat older than STALE_MS stands
 * in. The check reruns every CLAIM_EVERY_MS, so a page that died moments ago
 * is still picked up.
 *
 * Reports belong to the account that was signed in when they happened, and
 * only that account sends them. Never throws into the app; storage or network
 * failures only lose reports.
 */
import {
  FREEZE_MS,
  MAX_ERRORS,
  MAX_EVENTS_PER_POST,
  SLOW_NAV_MS,
  cleanError,
  pathOrNull,
  routeOrNull,
  type NavType,
  type StallEvent,
  type StallKind,
} from "$lib/client-stalls";

/** Also the resolution of a freeze's length: a gap is reported less one beat. */
export const BEAT_MS = 500;
/** The saved state is refreshed this often between milestones. */
export const SAVE_EVERY_MS = 2_000;
/** Heartbeat age that marks a page gone where there is no BroadcastChannel. */
export const STALE_MS = 30_000;
/** How long live pages get to answer a roll call. */
export const ANSWER_MS = 1_500;
/** A browser tab must miss a second roll call this much later (a busy page is not a dead one). */
export const RECHECK_MS = 10_000;
/** The check for gone pages reruns this often. */
export const CLAIM_EVERY_MS = 60_000;
/** Queued reports are retried at most this often while the page runs. */
export const RETRY_EVERY_MS = 30_000;
/** A reload that lands on its own destination this soon is SvelteKit's full-page fallback working. */
export const FALLBACK_MS = 15_000;
const TAB_PREFIX = "birds.navWatch.tab.";
const QUEUE_KEY = "birds.navWatch.queue.v2";
const MAX_QUEUE = 40;
const FORGET_AFTER_MS = 7 * 86_400_000;

interface Pending {
  fromRoute: string | null;
  toRoute: string | null;
  toPath: string | null;
  navType: NavType | null;
  startedAt: number;
  dataAt: number | null;
  /** Time on screen from the start to ready to draw (the clock slow/superseded use). */
  dataVisibleMs: number | null;
  /** When it first went to the background, if it did. */
  hiddenAt: number | null;
  /** Time on screen so far, not counting the visible stretch in progress. */
  visibleMs: number;
  /** Start of the visible stretch in progress (null while hidden). */
  visibleSince: number | null;
  errors: string[];
}

interface TabRecord {
  beatAt: number;
  visible: boolean;
  route: string | null;
  path: string | null;
  /** Set on pagehide (not into the back/forward cache): the document is gone. */
  unloadedAt: number | null;
  pending: Pending | null;
  standalone: boolean;
  online: boolean;
  /** The build and account this page ran, for reports recovered later. */
  version: string;
  userId: number | null;
}

interface Queued {
  userId: number;
  queuedAt: number;
  event: StallEvent;
}

export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;
export type RollCall = { t: "ping" | "pong"; tab: string };

export interface NavWatchDeps {
  storage: StorageLike | null;
  now: () => number;
  uuid: () => string;
  /** POSTs the events recorded under `accountId`; true when the server stored them. */
  send: (events: StallEvent[], accountId: number, keepalive: boolean) => Promise<boolean>;
  version: string;
  standalone: () => boolean;
  online: () => boolean;
  visible: () => boolean;
  /** This document's pathname. */
  location: () => string;
  /** Messages to the app's other pages (BroadcastChannel); null where unsupported. */
  channel: { post: (msg: RollCall) => void; listen: (fn: (msg: RollCall) => void) => void } | null;
  later: (fn: () => void, ms: number) => void;
}

/** A SvelteKit Navigation, reduced to what is used. Matched by identity. */
export interface NavLike {
  type: string;
  willUnload: boolean;
  from: { route: { id: string | null } } | null;
  to: { route: { id: string | null }; url: URL } | null;
}

const NAV_TYPES: readonly string[] = ["link", "goto", "popstate", "form"];

export class NavWatch {
  private readonly tabId: string;
  private rec: TabRecord;
  /** The navigation `rec.pending` describes. */
  private current: NavLike | null = null;
  private lastTick: number;
  private lastSave = 0;
  private lastFlush = 0;
  /** The page was hidden or shown since the last beat: that gap is not a freeze. */
  private visibilityChanged = false;
  private flushing = false;
  /** Pages that missed the previous roll call. */
  private suspects = new Set<string>();
  /** Pages that answered the roll call in progress. */
  private answered: Set<string> | null = null;
  /** Used only when there is no storage. */
  private memoryQueue: Queued[] = [];

  constructor(private readonly d: NavWatchDeps) {
    this.tabId = d.uuid();
    const now = d.now();
    this.lastTick = now;
    this.rec = {
      beatAt: now,
      visible: d.visible(),
      route: null,
      path: null,
      unloadedAt: null,
      pending: null,
      standalone: d.standalone(),
      online: d.online(),
      version: d.version,
      userId: null,
    };
  }

  /** Page start: save this page, answer roll calls, then look for earlier pages that are gone. */
  start(): void {
    this.save();
    this.d.channel?.listen((msg) => {
      if (msg?.t === "ping" && msg.tab !== this.tabId) this.d.channel?.post({ t: "pong", tab: this.tabId });
      else if (msg?.t === "pong") this.answered?.add(msg.tab);
    });
    this.rollCall();
  }

  /** The signed-in account (null when signed out). Reports are sent only for their own account. */
  setUser(userId: number | null): void {
    this.rec.userId = userId;
    this.save();
    if (userId != null) void this.flush(false);
  }

  /** The `navigating` store became this navigation. */
  begin(nav: NavLike): void {
    if (nav === this.current) return;
    if (nav.willUnload || !nav.to || !NAV_TYPES.includes(nav.type)) return;
    const now = this.d.now();
    const p = this.rec.pending;
    if (p && visibleWait(p, now) >= SLOW_NAV_MS) this.queue(this.navEvent("superseded", p, visibleWait(p, now)));
    this.current = nav;
    this.rec.pending = {
      fromRoute: routeOrNull(nav.from?.route.id ?? null),
      toRoute: routeOrNull(nav.to.route.id),
      toPath: pathOrNull(nav.to.url.pathname),
      navType: nav.type as NavType,
      startedAt: now,
      dataAt: null,
      dataVisibleMs: null,
      hiddenAt: null,
      visibleMs: 0,
      visibleSince: this.d.visible() ? now : null,
      errors: [],
    };
    this.save();
  }

  /** onNavigate: this navigation's data and code are loaded and it is about to be drawn. */
  dataReady(nav: NavLike): void {
    const p = this.rec.pending;
    if (nav !== this.current || !p || p.dataAt != null) return;
    const now = this.d.now();
    p.dataAt = now;
    p.dataVisibleMs = Math.round(visibleWait(p, now));
    this.save();
  }

  /** afterNavigate (also the first page). */
  shown(nav: NavLike, routeId: string | null, path: string): void {
    const now = this.d.now();
    const p = this.rec.pending;
    // SvelteKit lets only the latest navigation finish, so whatever finishes ends the one in progress.
    if (p && nav === this.current && visibleWait(p, now) >= SLOW_NAV_MS) {
      this.queue(this.navEvent("slow", { ...p, toPath: pathOrNull(path) ?? p.toPath }, visibleWait(p, now)));
    }
    this.current = null;
    this.rec.pending = null;
    this.rec.route = routeOrNull(routeId);
    this.rec.path = pathOrNull(path);
    this.save();
    void this.flush(false);
  }

  /** Every BEAT_MS. */
  tick(): void {
    const now = this.d.now();
    const visible = this.d.visible();
    const gap = now - this.lastTick - BEAT_MS;
    if (visible && this.rec.visible && !this.visibilityChanged && gap >= FREEZE_MS) {
      const p = this.rec.pending;
      this.queue(
        this.event("freeze", this.lastTick, gap, {
          fromRoute: p ? p.fromRoute : null,
          toRoute: p ? p.toRoute : this.rec.route,
          toPath: p ? p.toPath : this.rec.path,
          navType: p ? p.navType : null,
          stage: p ? (p.dataAt != null ? "data" : "started") : null,
          dataMs: p ? dataMs(p) : null,
        }),
      );
      this.lastSave = 0;
    }
    this.visibilityChanged = false;
    this.lastTick = now;
    this.rec.beatAt = now;
    this.rec.visible = visible;
    this.rec.online = this.d.online();
    if (now - this.lastSave >= SAVE_EVERY_MS) this.save();
    if (now - this.lastFlush >= RETRY_EVERY_MS) void this.flush(false);
  }

  /** visibilitychange (and pagehide into the back/forward cache, which is hidden whatever the document says). */
  visibility(forceHidden = false): void {
    const now = this.d.now();
    const visible = !forceHidden && this.d.visible();
    this.visibilityChanged = true;
    this.rec.visible = visible;
    this.rec.beatAt = now;
    this.lastTick = now;
    const p = this.rec.pending;
    if (p && !visible && p.visibleSince != null) {
      p.visibleMs += now - p.visibleSince;
      p.visibleSince = null;
      p.hiddenAt ??= now;
    } else if (p && visible && p.visibleSince == null) {
      p.visibleSince = now;
    }
    this.save();
    if (!visible) void this.flush(true);
  }

  /** pagehide. Into the back/forward cache the page is only hidden; otherwise this document is gone. */
  pageHide(persisted: boolean): void {
    if (persisted) {
      this.visibility(true);
      return;
    }
    this.rec.unloadedAt = this.d.now();
    this.save();
  }

  /** pageshow from the back/forward cache: the page is live again. */
  pageShow(): void {
    this.rec.unloadedAt = null;
    this.visibility();
  }

  /** An uncaught error or rejection: kept only while a navigation is in progress. */
  error(message: unknown): void {
    const p = this.rec.pending;
    if (!p || p.errors.length >= MAX_ERRORS) return;
    const text = cleanError(message);
    if (!text) return;
    p.errors.push(text);
    this.save();
  }

  /** Sends the signed-in account's queued reports. Kept until the server confirms them. */
  async flush(keepalive: boolean): Promise<void> {
    const userId = this.rec.userId;
    if (userId == null || this.flushing) return;
    this.lastFlush = this.d.now();
    const batch = this.readQueue()
      .filter((q) => q.userId === userId)
      .slice(0, MAX_EVENTS_PER_POST);
    if (batch.length === 0) return;
    this.flushing = true;
    try {
      const ok = await this.d.send(batch.map((q) => q.event), userId, keepalive).catch(() => false);
      if (ok) {
        const sent = new Set(batch.map((q) => q.event.id));
        this.writeQueue(this.readQueue().filter((q) => !sent.has(q.event.id)));
      }
    } finally {
      this.flushing = false;
    }
  }

  /** For tests: the queued events, oldest first. */
  queued(): StallEvent[] {
    return this.readQueue().map((q) => q.event);
  }

  private rollCall(): void {
    const ch = this.d.channel;
    if (ch) {
      const answered = new Set<string>();
      this.answered = answered;
      ch.post({ t: "ping", tab: this.tabId });
      this.d.later(() => {
        if (this.answered === answered) this.answered = null;
        this.claim(answered);
      }, ANSWER_MS);
    } else {
      this.claim(null);
    }
  }

  /** `answered`: the pages that answered this roll call (null: no channel, judge by heartbeat age). */
  private claim(answered: Set<string> | null): void {
    const s = this.d.storage;
    const now = this.d.now();
    const keys: string[] = [];
    try {
      for (let i = 0; s && i < s.length; i++) {
        const k = s.key(i);
        if (k?.startsWith(TAB_PREFIX) && k !== TAB_PREFIX + this.tabId) keys.push(k);
      }
    } catch {
      // Storage unreadable: nothing to recover.
    }
    const suspects = new Set<string>();
    for (const k of keys) {
      const id = k.slice(TAB_PREFIX.length);
      const rec = this.read<TabRecord>(k);
      if (!rec || typeof rec.beatAt !== "number") {
        this.remove(k);
        continue;
      }
      const age = now - rec.beatAt;
      if (rec.unloadedAt != null) {
        // The document is gone. A navigation in progress was cut off by a reload, unless the reload
        // was SvelteKit's full-page fallback, which loads the destination itself. Only a page at that
        // destination can settle that; any other page leaves the record for FALLBACK_MS, in case the
        // destination is still loading.
        const p = rec.pending;
        if (p) {
          const inWindow = now - rec.unloadedAt < FALLBACK_MS;
          if (inWindow && p.toPath != null && p.toPath === this.d.location()) {
            this.remove(k); // the fallback landed: this page is it
          } else if (inWindow) {
            suspects.add(id); // look again soon
          } else {
            this.recover(rec, this.navEvent("reloaded", p, Math.max(0, rec.unloadedAt - p.startedAt)), p);
            this.remove(k);
          }
        } else {
          this.remove(k);
        }
        continue;
      }
      if (answered?.has(id)) continue;
      let gone: boolean;
      if (rec.standalone && this.rec.standalone) gone = true; // the installed app runs one page at a time
      else if (!answered) gone = age > STALE_MS && rec.visible;
      else if (!rec.visible) gone = false; // a hidden browser tab may only be suspended
      else if (this.suspects.has(id)) gone = true;
      else {
        suspects.add(id);
        gone = false;
      }
      if (gone) {
        if (rec.pending) {
          this.recover(rec, this.navEvent("unfinished", rec.pending, Math.max(0, rec.beatAt - rec.pending.startedAt)), rec.pending);
        } else if (rec.visible) {
          this.recover(rec, this.event("lost", rec.beatAt, 0, { toRoute: rec.route, toPath: rec.path }), null);
        }
        this.remove(k);
      } else if (age > FORGET_AFTER_MS) {
        this.remove(k);
      }
    }
    this.suspects = suspects;
    void this.flush(false);
    this.d.later(() => this.rollCall(), suspects.size > 0 ? RECHECK_MS : CLAIM_EVERY_MS);
  }

  /** A report about an earlier page: its own build, device state and account. */
  private recover(rec: TabRecord, e: StallEvent, p: Pending | null): void {
    if (rec.userId == null) return;
    e.version = rec.version;
    e.standalone = rec.standalone;
    e.online = rec.online;
    if (p) e.aliveMs = Math.max(0, rec.beatAt - p.startedAt);
    this.queue(e, rec.userId);
  }

  private navEvent(kind: StallKind, p: Pending, waitedMs: number): StallEvent {
    return this.event(kind, p.startedAt, waitedMs, {
      fromRoute: p.fromRoute,
      toRoute: p.toRoute,
      toPath: p.toPath,
      navType: p.navType,
      stage: kind === "slow" ? "shown" : p.dataAt != null ? "data" : "started",
      dataMs: dataMs(p),
      hiddenMs: p.hiddenAt != null ? p.hiddenAt - p.startedAt : null,
      errors: [...p.errors],
    });
  }

  private event(kind: StallKind, at: number, waitedMs: number, over: Partial<StallEvent>): StallEvent {
    return {
      id: this.d.uuid(),
      kind,
      occurredAt: Math.round(at),
      fromRoute: null,
      toRoute: null,
      toPath: null,
      navType: null,
      stage: null,
      waitedMs: Math.max(0, Math.round(waitedMs)),
      dataMs: null,
      aliveMs: null,
      hiddenMs: null,
      errors: [],
      standalone: this.d.standalone(),
      online: this.d.online(),
      version: this.d.version,
      ...over,
    };
  }

  /** Queued for `userId` (default: this page's account); dropped when nobody was signed in. */
  private queue(e: StallEvent, userId = this.rec.userId): void {
    if (userId == null) return;
    const now = this.d.now();
    const q = this.readQueue().filter((x) => now - x.queuedAt < FORGET_AFTER_MS);
    q.push({ userId, queuedAt: now, event: e });
    this.writeQueue(q.slice(-MAX_QUEUE));
  }

  private readQueue(): Queued[] {
    if (!this.d.storage) return this.memoryQueue;
    const q = this.read<Queued[]>(QUEUE_KEY);
    return Array.isArray(q) ? q.filter((x) => x && typeof x.userId === "number" && x.event) : [];
  }

  private writeQueue(q: Queued[]): void {
    if (!this.d.storage) {
      this.memoryQueue = q;
      return;
    }
    try {
      if (q.length) this.d.storage.setItem(QUEUE_KEY, JSON.stringify(q));
      else this.d.storage.removeItem(QUEUE_KEY);
    } catch {
      // Full or blocked storage: the report is lost, the app is not.
    }
  }

  private save(): void {
    this.lastSave = this.d.now();
    try {
      this.d.storage?.setItem(TAB_PREFIX + this.tabId, JSON.stringify(this.rec));
    } catch {
      // As above.
    }
  }

  private read<T>(key: string): T | null {
    try {
      const raw = this.d.storage?.getItem(key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      return null;
    }
  }

  private remove(key: string): void {
    try {
      this.d.storage?.removeItem(key);
    } catch {
      // As above.
    }
  }
}

/** On-screen time to ready to draw (records saved before dataVisibleMs existed: wall time). */
function dataMs(p: Pending): number | null {
  if (p.dataAt == null) return null;
  return typeof p.dataVisibleMs === "number" ? p.dataVisibleMs : p.dataAt - p.startedAt;
}

/** Time the navigation has spent waiting on screen (records saved before visibleMs existed count from the start). */
function visibleWait(p: Pending, now: number): number {
  if (typeof p.visibleMs !== "number") return now - p.startedAt;
  return p.visibleMs + (p.visibleSince != null ? now - p.visibleSince : 0);
}

let installed: NavWatch | null = null;

/**
 * The page's one watcher, with its heartbeat and page listeners installed on
 * first use. Browser only.
 */
export function navWatch(version: string): NavWatch {
  if (installed) return installed;
  let storage: StorageLike | null = null;
  try {
    storage = window.localStorage;
  } catch {
    storage = null;
  }
  const w = new NavWatch({
    storage,
    now: () => Date.now(),
    uuid: () => crypto.randomUUID(),
    send: async (events, accountId, keepalive) => {
      const r = await fetch("/api/client-stalls", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accountId, events }),
        keepalive,
      });
      return r.ok;
    },
    version,
    standalone: () =>
      window.matchMedia?.("(display-mode: standalone)").matches === true ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true,
    online: () => navigator.onLine !== false,
    visible: () => document.visibilityState === "visible",
    location: () => location.pathname,
    channel: rollCallChannel(),
    later: (fn, ms) => void setTimeout(fn, ms),
  });
  installed = w;
  w.start();
  setInterval(() => w.tick(), BEAT_MS);
  document.addEventListener("visibilitychange", () => w.visibility());
  window.addEventListener("pagehide", (e) => w.pageHide(e.persisted));
  window.addEventListener("pageshow", (e) => {
    if (e.persisted) w.pageShow();
  });
  window.addEventListener("online", () => void w.flush(false));
  window.addEventListener("error", (e) => w.error(e.message || e.error));
  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason as { message?: unknown } | undefined;
    w.error(r && typeof r === "object" && "message" in r ? r.message : r);
  });
  return w;
}

function rollCallChannel(): NavWatchDeps["channel"] {
  if (typeof BroadcastChannel === "undefined") return null;
  try {
    const bc = new BroadcastChannel("birds.navWatch");
    return {
      post: (msg) => bc.postMessage(msg),
      listen: (fn) => bc.addEventListener("message", (e) => fn(e.data as RollCall)),
    };
  } catch {
    return null;
  }
}
