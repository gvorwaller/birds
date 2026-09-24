import { browser } from "$app/environment";
import { goto, replaceState } from "$app/navigation";
import { page } from "$app/state";
import {
  NAVIGATION_STATE_KEY,
  canonicalHref,
  createNavigationNode,
  emptyNavigationSnapshot,
  navigationTrail,
  nodeById,
  parseNavigationSnapshot,
  parseLocalHref,
  safeLabel,
  type NavigationNode,
  type NavigationRef,
  type NavigationSnapshot,
  type NavigationUiState,
  upsertNavigationNode,
  withReturnTo,
} from "$lib/navigation-context";

export type NavigationStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
>;

function storageFor(accountId: number): NavigationStorage | null {
  if (!browser || !Number.isSafeInteger(accountId) || accountId <= 0)
    return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function navigationStorageAvailable(
  accountId: number | null | undefined,
): boolean {
  const id = accountId;
  if (id == null || !Number.isSafeInteger(id) || id <= 0) return false;
  const storage = id == null ? null : storageFor(id);
  if (!storage) return false;
  try {
    storage.getItem(storageKey(id));
    return true;
  } catch {
    return false;
  }
}

function storageKey(accountId: number): string {
  return `birds-navigation-v${1}-u${accountId}`;
}

function reloadBridgeKey(accountId: number): string {
  return `${storageKey(accountId)}-reload`;
}

let reloadBridgeConsumed = false;
let missingReferenceHref: string | null = null;

function documentWasReloaded(): boolean {
  try {
    const entry = performance.getEntriesByType("navigation")[0] as
      | PerformanceNavigationTiming
      | undefined;
    return entry?.type === "reload";
  } catch {
    return false;
  }
}

function writeReloadBridge(accountId: number, node: NavigationNode): void {
  const storage = storageFor(accountId);
  if (!storage) return;
  try {
    storage.setItem(
      reloadBridgeKey(accountId),
      JSON.stringify({ accountId, nodeId: node.id, href: node.href }),
    );
  } catch {
    // degraded storage leaves ordinary links usable
  }
}

function clearReloadBridge(accountId: number): void {
  try {
    storageFor(accountId)?.removeItem(reloadBridgeKey(accountId));
  } catch {
    /* no-op */
  }
}

function clearOtherAccountNamespaces(accountId: number): void {
  const storage = storageFor(accountId);
  if (!storage) return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < (storage as Storage).length; i += 1) {
      const key = (storage as Storage).key(i);
      if (
        key?.startsWith("birds-navigation-v1-u") &&
        key !== storageKey(accountId) &&
        key !== reloadBridgeKey(accountId)
      )
        keys.push(key);
    }
    for (const key of keys) storage.removeItem(key);
  } catch {
    // blocked/private storage remains a supported degraded mode
  }
}

function readSnapshot(accountId: number): NavigationSnapshot {
  const storage = storageFor(accountId);
  if (!storage) return emptyNavigationSnapshot();
  try {
    const raw = storage.getItem(storageKey(accountId));
    return raw
      ? parseNavigationSnapshot(JSON.parse(raw))
      : emptyNavigationSnapshot();
  } catch {
    return emptyNavigationSnapshot();
  }
}

function writeSnapshot(accountId: number, snapshot: NavigationSnapshot): void {
  const storage = storageFor(accountId);
  if (!storage) return;
  try {
    storage.setItem(storageKey(accountId), JSON.stringify(snapshot));
  } catch {
    // Blocked/private storage is an accepted degraded mode. The ordinary href
    // remains usable and the immediate fallback is still rendered.
  }
}

function newId(): string {
  if (browser && globalThis.crypto?.randomUUID)
    return globalThis.crypto.randomUUID();
  return `nav_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`;
}

function currentHref(): string {
  return page.url.pathname + page.url.search + page.url.hash;
}

function fullLocalHref(raw: string): string | null {
  const url = parseLocalHref(raw);
  return url ? `${url.pathname}${url.search}${url.hash}` : null;
}

function resourceKey(href: string): string {
  const parsed = parseLocalHref(href);
  if (!parsed) return "";
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts[0] === "hotspots" || parts[0] === "species" || parts[0] === "trips")
    return `/${parts[0]}/${parts[1] ?? ""}`;
  if (parts[0] === "forecast" && parts[1] === "species") {
    const species = parsed.searchParams.get("species");
    return species && /^[A-Za-z0-9_-]+$/.test(species)
      ? "/forecast/species/" + species
      : "/forecast/species";
  }
  return parsed.pathname;
}

/** One species, hotspot, trip or forecast bird, as opposed to a list/search page. */
function isDetailResource(href: string): boolean {
  const parsed = parseLocalHref(href);
  if (!parsed) return false;
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts.length === 2 && (parts[0] === "hotspots" || parts[0] === "species"))
    return true;
  if (parts.length === 2 && parts[0] === "trips") return parts[1] !== "plan";
  return (
    parts.length === 2 &&
    parts[0] === "forecast" &&
    parts[1] === "species" &&
    /^[A-Za-z0-9_-]+$/.test(parsed.searchParams.get("species") ?? "")
  );
}

function stateRef(): NavigationRef | null {
  const state = page.state as unknown as Record<string, unknown>;
  const ref = state[NAVIGATION_STATE_KEY];
  if (!ref || typeof ref !== "object") return null;
  const candidate = ref as Record<string, unknown>;
  return Number.isSafeInteger(candidate.accountId) &&
    typeof candidate.nodeId === "string"
    ? { accountId: candidate.accountId as number, nodeId: candidate.nodeId }
    : null;
}

function mergeState(ref: NavigationRef): Record<string, unknown> {
  return {
    ...(page.state as unknown as Record<string, unknown>),
    [NAVIGATION_STATE_KEY]: ref,
  };
}

let activeAccountId: number | null = null;
let activeNode: NavigationNode | null = null;
let routerReady = false;
let lastNavigationType: string | null = null;

/** Native Back/Forward owns its scroll position; explicit returns restore origins. */
export function shouldRestoreNavigationOrigin(): boolean {
  return lastNavigationType !== "popstate";
}
let pendingGeneration = 0;
let pending: {
  generation: number;
  accountId: number;
  node: NavigationNode;
  href: string;
  stateRef: NavigationRef | null;
  detached: NavigationNode | null;
} | null = null;
let requested: {
  generation: number;
  accountId: number;
  node: NavigationNode;
  href: string;
  detached: NavigationNode | null;
} | null = null;

/**
 * Store a completed navigation's node. A revisit also re-parents the step
 * that followed the spliced-out earlier visit (td-8214cb); every path that
 * completes a navigation must apply both, whichever runs first.
 */
function commitNode(
  snapshot: NavigationSnapshot,
  node: NavigationNode,
  detached: NavigationNode | null,
): NavigationSnapshot {
  const next = detached ? upsertNavigationNode(snapshot, detached) : snapshot;
  return upsertNavigationNode(next, node);
}

export function clearNavigationAccount(
  accountId: number | null | undefined,
): void {
  if (accountId == null) return;
  const storage = storageFor(accountId);
  try {
    storage?.removeItem(storageKey(accountId));
    storage?.removeItem(reloadBridgeKey(accountId));
  } catch {
    // no-op
  }
  if (activeAccountId === accountId) {
    pendingGeneration += 1;
    pending = null;
    activeAccountId = null;
    activeNode = null;
    requested = null;
    missingReferenceHref = null;
  }
}

export function ensureCurrentNode(input: {
  accountId: number | null | undefined;
  href?: string;
  label: string;
  ui?: NavigationUiState | null;
}): NavigationNode | null {
  if (!browser) return null;
  if (
    input.accountId == null ||
    !Number.isSafeInteger(input.accountId) ||
    input.accountId <= 0
  )
    return null;
  const accountId = input.accountId;
  if (activeAccountId !== null && activeAccountId !== accountId) {
    try {
      storageFor(activeAccountId)?.removeItem(storageKey(activeAccountId));
      storageFor(activeAccountId)?.removeItem(reloadBridgeKey(activeAccountId));
    } catch {
      // blocked storage is already a supported degraded mode
    }
    pendingGeneration += 1;
    pending = null;
    activeNode = null;
  }
  const fullHref = fullLocalHref(input.href ?? currentHref()) ?? currentHref();
  const href = canonicalHref(fullHref) ?? fullHref;
  if (activeAccountId !== accountId) {
    activeAccountId = accountId;
    activeNode = null;
    missingReferenceHref = null;
    clearOtherAccountNamespaces(accountId);
  }
  const ref = stateRef();
  const snapshot = readSnapshot(accountId);
  if (
    ref?.accountId === accountId &&
    !nodeById(snapshot, ref.nodeId) &&
    pending?.node.id !== ref.nodeId
  ) {
    missingReferenceHref = href;
  }
  if (
    activeAccountId === accountId &&
    !ref &&
    !reloadBridgeConsumed &&
    documentWasReloaded()
  ) {
    reloadBridgeConsumed = true;
    try {
      const raw = storageFor(accountId)?.getItem(reloadBridgeKey(accountId));
      const bridge = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
      const stored =
        bridge &&
        bridge.accountId === accountId &&
        bridge.href === href &&
        typeof bridge.nodeId === "string"
          ? nodeById(snapshot, bridge.nodeId)
          : null;
      if (stored?.href === href) {
        activeNode = stored;
        if (routerReady)
          replaceState(currentHref(), mergeState({ accountId, nodeId: stored.id }));
        return stored;
      }
      if (raw) missingReferenceHref = href;
    } catch {
      missingReferenceHref = href;
    }
  }
  if (ref?.accountId === accountId) {
    const stored = nodeById(snapshot, ref.nodeId);
    if (stored && stored.href === href) {
      activeNode = stored;
      return stored;
    }
  }
  if (requested && requested.accountId === accountId && requested.href === href) {
    const completed = requested;
    activeNode = completed.node;
    writeSnapshot(accountId, commitNode(snapshot, completed.node, completed.detached));
    if (routerReady)
      replaceState(
        currentHref(),
        mergeState({ accountId, nodeId: completed.node.id }),
      );
    if (routerReady) writeReloadBridge(accountId, completed.node);
    pending = null;
    requested = null;
    return completed.node;
  }
  if (pending && pending.accountId === accountId && pending.href === href) {
    activeNode = pending.node;
    return pending.node;
  }
  if (activeNode?.href === href) return activeNode;
  if (activeNode && resourceKey(activeNode.href) === resourceKey(href)) {
    const updated = { ...activeNode, href };
    activeNode = updated;
    writeSnapshot(accountId, upsertNavigationNode(snapshot, updated));
    if (routerReady)
      replaceState(currentHref(), mergeState({ accountId, nodeId: updated.id }));
    if (routerReady) writeReloadBridge(accountId, updated);
    return updated;
  }
  const node = createNavigationNode({
    id: newId(),
    href,
    label: safeLabel(input.label),
    ui: input.ui,
  });
  if (!node) return null;
  activeNode = node;
  writeSnapshot(accountId, upsertNavigationNode(snapshot, node));
  if (routerReady)
    replaceState(currentHref(), mergeState({ accountId, nodeId: node.id }));
  if (routerReady) writeReloadBridge(accountId, node);
  return node;
}

export function currentNavigationNode(
  accountId: number | null | undefined,
): NavigationNode | null {
  if (accountId == null) return null;
  const current = ensureCurrentNode({ accountId, label: "Back" });
  return current;
}

export function updateCurrentNode(input: {
  accountId: number | null | undefined;
  href: string;
  label?: string;
  ui?: NavigationUiState | null;
}): NavigationNode | null {
  if (input.accountId == null) return null;
  const fullHref = fullLocalHref(input.href);
  if (!fullHref) return null;
  const canonical = canonicalHref(fullHref) ?? fullHref;
  let current = activeAccountId === input.accountId ? activeNode : null;
  if (current && resourceKey(current.href) !== resourceKey(canonical)) {
    activeNode = null;
    current = null;
  }
  if (!current) {
    return ensureCurrentNode({
      accountId: input.accountId,
      href: fullHref,
      label: input.label ?? "Back",
      ui: input.ui,
    });
  }
  if (!current) return null;
  const updated = {
    ...current,
    href: canonical,
    label: input.label ? safeLabel(input.label) : current.label,
    ui: input.ui === undefined ? current.ui : input.ui,
  };
  activeNode = updated;
  writeSnapshot(
    input.accountId,
    upsertNavigationNode(readSnapshot(input.accountId), updated),
  );
  return updated;
}

export function trailFor(
  accountId: number | null | undefined,
  nodeId?: string | null,
) {
  if (accountId == null) return { nodes: [], truncated: false };
  const snapshot = readSnapshot(accountId);
  return navigationTrail(
    snapshot,
    nodeId ??
      stateRef()?.nodeId ??
      (activeAccountId === accountId ? activeNode?.id : null),
  );
}

export function navigationNodeHref(
  accountId: number | null | undefined,
  nodeId: string,
): string {
  if (accountId == null) return "/";
  const snapshot = readSnapshot(accountId);
  const node = nodeById(snapshot, nodeId);
  if (!node) return "/";
  const parent = nodeById(snapshot, node.parentId);
  return parent
    ? withReturnTo(node.href, parent.href, undefined, parent.label)
    : node.href;
}

export function navigationReferenceUnavailable(
  accountId: number | null | undefined,
): boolean {
  if (accountId == null) return false;
  const ref = stateRef();
  return (
    missingReferenceHref === canonicalHref(currentHref()) ||
    (ref?.accountId === accountId &&
      pending?.node.id !== ref.nodeId &&
      nodeById(readSnapshot(accountId), ref.nodeId) === null)
  );
}

function eligibleClick(event: MouseEvent, anchor: HTMLAnchorElement): boolean {
  return (
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    !anchor.target &&
    !anchor.hasAttribute("download") &&
    !event.defaultPrevented
  );
}

/** Navigate an adopted link while retaining a normal href for modifiers/JS-off. */
export function navigateWithContext(input: {
  event: MouseEvent;
  href: string;
  label: string;
  accountId: number | null | undefined;
  originId?: string | null;
  ui?: NavigationUiState | null;
  existingNodeId?: string | null;
}): void {
  const anchor = input.event.currentTarget as HTMLAnchorElement;
  if (!eligibleClick(input.event, anchor) || input.accountId == null) return;
  const destination = fullLocalHref(input.href);
  if (!destination) return;
  const href = canonicalHref(destination) ?? destination;
  const generation = ++pendingGeneration;
  const current = currentNavigationNode(input.accountId);
  if (current && (input.originId || input.ui)) {
    const source = {
      ...current,
      originId: input.originId ?? current.originId,
      ui: input.ui ?? current.ui,
      scrollY: Number.isFinite(window.scrollY)
        ? Math.max(0, Math.round(window.scrollY))
        : current.scrollY,
    };
    activeNode = source;
    writeSnapshot(
      input.accountId,
      upsertNavigationNode(readSnapshot(input.accountId), source),
    );
  }
  const snapshot = readSnapshot(input.accountId);
  const currentTrail = navigationTrail(snapshot, current?.id).nodes;
  // An explicit rewind (Back / Your path) names its node. A forward link that
  // revisits a page already on the trail moves that page to the end instead
  // (td-8214cb): the earlier step is spliced out, so the path never loops and
  // the page just left stays the Back target. Only the current page is
  // updated in place (a tab/month change on the same resource). List pages
  // match only on the exact URL, so an unfiltered "Browse field guide" does
  // not overwrite a saved Field guide search.
  const revisit = input.existingNodeId
    ? null
    : ([...currentTrail]
        .reverse()
        .find((candidate) => candidate.href === href) ??
      (isDetailResource(href)
        ? [...currentTrail]
            .reverse()
            .find(
              (candidate) => resourceKey(candidate.href) === resourceKey(href),
            )
        : undefined) ??
      null);
  const existing = input.existingNodeId
    ? nodeById(snapshot, input.existingNodeId)
    : revisit && revisit.id === current?.id
      ? revisit
      : null;
  let detached: NavigationNode | null = null;
  if (!existing && revisit) {
    const at = currentTrail.findIndex((candidate) => candidate.id === revisit.id);
    const child = at >= 0 ? currentTrail[at + 1] : undefined;
    if (child) detached = { ...child, parentId: revisit.parentId };
  }
  const node = existing
    ? { ...existing, href }
    : createNavigationNode({
        id: newId(),
        href,
        label: input.label,
        parentId: current?.id ?? null,
        originId: null,
        ui: null,
      });
  if (!node) return;
  input.event.preventDefault();
  const ref = { accountId: input.accountId, nodeId: node.id };
  pending = {
    generation,
    accountId: input.accountId,
    node,
    href,
    stateRef: ref,
    detached,
  };
  requested = { generation, accountId: input.accountId, node, href, detached };
  void goto(destination, { state: mergeState(ref) })
    .then(() => {
      const winner = currentHref();
      const winnerRef = stateRef();
      const winnerMatches = (canonicalHref(winner) ?? winner) === href;
      if (
        !winnerMatches ||
        (winnerRef != null &&
          (winnerRef.accountId !== input.accountId ||
            winnerRef.nodeId !== ref.nodeId))
      ) {
        if (requested?.generation === generation) requested = null;
        return;
      }
      if (
        !pending ||
        pending.generation !== generation ||
        pending.href !== href ||
        !winnerRef
      )
        return;
      const latest = readSnapshot(input.accountId!);
      writeSnapshot(input.accountId!, commitNode(latest, node, detached));
      routerReady = true;
      writeReloadBridge(input.accountId!, node);
      activeAccountId = input.accountId!;
      activeNode = node;
      replaceState(currentHref(), mergeState(ref));
      pending = null;
      if (requested?.generation === generation) requested = null;
    })
    .catch(() => {
      if (pending?.generation === generation) pending = null;
      if (requested?.generation === generation) requested = null;
    });
}

/** Reconcile a pending client navigation after SvelteKit selects the winning route. */
export function navigationAfterNavigate(
  accountId: number | null | undefined,
  type?: string,
): void {
  lastNavigationType = type ?? null;
  routerReady = true;
  if (accountId == null) {
    if (activeAccountId != null) clearNavigationAccount(activeAccountId);
    pendingGeneration += 1;
    pending = null;
    requested = null;
    activeNode = null;
    activeAccountId = null;
    missingReferenceHref = null;
    // Sign-out may load a fresh document, with no surviving in-memory account.
    try {
      const storage = window.sessionStorage;
      const keys: string[] = [];
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (key?.startsWith("birds-navigation-v")) keys.push(key);
      }
      for (const key of keys) storage.removeItem(key);
    } catch {
      /* Private storage remains a supported degraded mode. */
    }
    return;
  }
  if (!pending) {
    const ref = stateRef();
    if (
      accountId != null &&
      accountId === activeAccountId &&
      activeNode &&
      !ref &&
      resourceKey(currentHref()) !== resourceKey(activeNode.href)
    ) {
      clearReloadBridge(accountId);
      activeNode = null;
      activeAccountId = null;
    }
    if (accountId != null && ref?.accountId === accountId) {
      const restored = nodeById(readSnapshot(accountId), ref.nodeId);
      if (restored?.href === canonicalHref(currentHref())) {
        activeAccountId = accountId;
        activeNode = restored;
      }
    }
    if (
      accountId != null &&
      accountId === activeAccountId &&
      activeNode &&
      activeNode.href === canonicalHref(currentHref())
    ) {
      if (ref?.accountId !== accountId || ref.nodeId !== activeNode.id) {
        replaceState(
          currentHref(),
          mergeState({ accountId, nodeId: activeNode.id }),
        );
      }
      writeReloadBridge(accountId, activeNode);
    }
    if (accountId == null && activeAccountId != null)
      clearNavigationAccount(activeAccountId);
    return;
  }
  const winner = currentHref();
  const winnerRef = stateRef();
  if (
    accountId !== pending.accountId ||
    (canonicalHref(winner) ?? winner) !== pending.href ||
    (winnerRef != null &&
      (winnerRef.accountId !== pending.accountId ||
        winnerRef.nodeId !== pending.stateRef?.nodeId))
  ) {
    pendingGeneration += 1;
    pending = null;
    return;
  }
  // SvelteKit can render the winning route before page.state exposes the
  // state passed to goto (notably after a document reload). The URL still
  // proves this is the pending winner, so attach its validated reference here
  // instead of letting the destination register a fresh root node.
  if (!winnerRef && pending.stateRef) {
    const completed = pending;
    const completedRef = pending.stateRef;
    writeSnapshot(
      completed.accountId,
      commitNode(
        readSnapshot(completed.accountId),
        completed.node,
        completed.detached,
      ),
    );
    activeAccountId = completed.accountId;
    activeNode = completed.node;
    replaceState(currentHref(), mergeState(completedRef));
    writeReloadBridge(completed.accountId, completed.node);
    pending = null;
    if (requested?.generation === completed.generation) requested = null;
  }
}

export function navigationHref(
  destination: string,
  accountId: number | null | undefined,
): string {
  const current = accountId == null ? null : currentNavigationNode(accountId);
  return withReturnTo(destination, current?.href ?? currentHref());
}

export function navigationAction(
  accountId: number | null | undefined,
  options: {
    label: string;
    originId?: string | null;
    ui?: NavigationUiState | null;
    existingNodeId?: string | null;
  },
) {
  return (event: MouseEvent) => {
    if (!browser) return;
    const anchor = event.currentTarget as HTMLAnchorElement;
    navigateWithContext({
      ...options,
      event,
      href: anchor.pathname + anchor.search + anchor.hash,
      accountId,
    });
  };
}
