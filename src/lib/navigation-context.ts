/**
 * Pure policy for the shared journey context.  It deliberately knows nothing
 * about SvelteKit, storage or the DOM so malformed links and stale history can
 * be tested at the trust boundary without a browser or database.
 */

export const NAVIGATION_VERSION = 1 as const;
export const NAVIGATION_STATE_KEY = "birdsNavigation" as const;
export const MAX_NAVIGATION_NODES = 100;
export const MAX_NAVIGATION_LABEL = 160;
export const MAX_NAVIGATION_HREF = 4096;
export const MAX_NAVIGATION_UI = 24;

const INTERNAL_ORIGIN = "https://birds.internal";
const NAVIGATION_KEYS = new Set([
  "returnTo",
  "returnLabel",
  "navNode",
  "navParent",
  "navAccount",
]);

export interface NavigationUiState {
  /** Route-specific state is intentionally small and JSON-safe. */
  expanded?: boolean;
  expandedIds?: string[];
}

export interface NavigationNode {
  id: string;
  href: string;
  label: string;
  parentId: string | null;
  originId: string | null;
  scrollY: number | null;
  focusId: string | null;
  ui: NavigationUiState | null;
}

export interface NavigationSnapshot {
  version: typeof NAVIGATION_VERSION;
  nodes: NavigationNode[];
}

export interface NavigationRef {
  accountId: number;
  nodeId: string;
}

export function isNavigationRef(value: unknown): value is NavigationRef {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    Number.isSafeInteger(v.accountId) &&
    (v.accountId as number) > 0 &&
    typeof v.nodeId === "string" &&
    /^[A-Za-z0-9_-]{8,80}$/.test(v.nodeId as string)
  );
}

function hasControl(value: string): boolean {
  return /[\u0000-\u001f\u007f]/u.test(value);
}

function hasMalformedPercent(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] === "%" && !/^[0-9A-Fa-f]{2}$/.test(value.slice(i + 1, i + 3)))
      return true;
  }
  return false;
}

function hasUnsafePathPart(value: string): boolean {
  try {
    const decoded = decodeURIComponent(value);
    return (
      value.includes("\\") || decoded.includes("\\") || hasControl(decoded)
    );
  } catch {
    return true;
  }
}

/** Return a validated local URL, or null for any untrusted/ambiguous input. */
export function parseLocalHref(raw: string | null | undefined): URL | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  if (
    !raw.startsWith("/") ||
    raw.startsWith("//") ||
    hasControl(raw) ||
    hasMalformedPercent(raw)
  )
    return null;
  let url: URL;
  try {
    url = new URL(raw, INTERNAL_ORIGIN);
  } catch {
    return null;
  }
  if (url.origin !== INTERNAL_ORIGIN || !url.pathname.startsWith("/"))
    return null;
  if (
    hasUnsafePathPart(url.pathname) ||
    hasUnsafePathPart(url.search) ||
    hasUnsafePathPart(url.hash)
  )
    return null;
  return url;
}

function cleanQuery(url: URL, actionKeys?: Iterable<string>): void {
  const keys = new Set(NAVIGATION_KEYS);
  for (const key of actionKeys ?? []) keys.add(key);
  for (const key of [...url.searchParams.keys()]) {
    // SvelteKit named form actions arrive as query keys such as
    // "/load_hotspot". They are transport controls, never content state.
    if (keys.has(key) || key.startsWith("/")) url.searchParams.delete(key);
  }
}

/** Canonical shareable content URL. Navigation bookkeeping is removed. */
export function canonicalHref(
  raw: string | null | undefined,
  actionKeys?: Iterable<string>,
): string | null {
  const url = parseLocalHref(raw);
  if (!url) return null;
  cleanQuery(url, actionKeys);
  return `${url.pathname}${url.search}${url.hash}`;
}

/** Add exactly one immediate return target, stripping any nested source first. */
export function withReturnTo(
  destination: string,
  source: string | null | undefined,
  actionKeys?: Iterable<string>,
  sourceLabel?: string | null,
): string {
  const target = parseLocalHref(destination);
  if (!target) return "/";
  cleanQuery(target, actionKeys);
  const fullTarget = `${target.pathname}${target.search}${target.hash}`;
  if (fullTarget.length > MAX_NAVIGATION_HREF) return fullTarget;
  const sourceHref = canonicalHref(source);
  if (sourceHref && sourceHref !== "/") {
    target.searchParams.set("returnTo", sourceHref);
    if (sourceLabel)
      target.searchParams.set("returnLabel", safeLabel(sourceLabel));
  } else target.searchParams.delete("returnTo");
  const result = `${target.pathname}${target.search}${target.hash}`;
  return result.length <= MAX_NAVIGATION_HREF ? result : fullTarget;
}

export function safeLabel(raw: unknown, fallback = "Back"): string {
  if (typeof raw !== "string") return fallback;
  const value = raw
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .trim()
    .slice(0, MAX_NAVIGATION_LABEL);
  return value || fallback;
}

export function createNavigationNode(input: {
  id: string;
  href: string;
  label: string;
  parentId?: string | null;
  originId?: string | null;
  scrollY?: number | null;
  focusId?: string | null;
  ui?: NavigationUiState | null;
}): NavigationNode | null {
  const href = canonicalHref(input.href);
  if (
    !href ||
    href.length > MAX_NAVIGATION_HREF ||
    typeof input.id !== "string" ||
    !/^[A-Za-z0-9_-]{8,80}$/.test(input.id)
  )
    return null;
  const ui =
    input.ui && typeof input.ui === "object" ? sanitizeUi(input.ui) : null;
  return {
    id: input.id,
    href,
    label: safeLabel(input.label),
    parentId: validId(input.parentId) ? input.parentId! : null,
    originId: safeOptionalText(input.originId),
    scrollY: Number.isFinite(input.scrollY)
      ? Math.max(0, Math.round(input.scrollY!))
      : null,
    focusId: safeOptionalText(input.focusId),
    ui,
  };
}

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{8,80}$/.test(value);
}

function safeOptionalText(value: unknown): string | null {
  return typeof value === "string" && value.length <= 200 && !hasControl(value)
    ? value
    : null;
}

function sanitizeUi(value: NavigationUiState): NavigationUiState | null {
  const ui: NavigationUiState = {};
  if (typeof value.expanded === "boolean") ui.expanded = value.expanded;
  if (Array.isArray(value.expandedIds)) {
    const ids = value.expandedIds
      .filter((id): id is string => validId(id))
      .slice(0, MAX_NAVIGATION_UI);
    if (ids.length) ui.expandedIds = ids;
  }
  return Object.keys(ui).length ? ui : null;
}

export function emptyNavigationSnapshot(): NavigationSnapshot {
  return { version: NAVIGATION_VERSION, nodes: [] };
}

/** Validate storage as hostile input and discard invalid nodes/cycles. */
export function parseNavigationSnapshot(value: unknown): NavigationSnapshot {
  if (!value || typeof value !== "object") return emptyNavigationSnapshot();
  const raw = value as Record<string, unknown>;
  if (raw.version !== NAVIGATION_VERSION || !Array.isArray(raw.nodes))
    return emptyNavigationSnapshot();
  const nodes: NavigationNode[] = [];
  const ids = new Set<string>();
  for (const candidate of raw.nodes.slice(-MAX_NAVIGATION_NODES)) {
    if (!candidate || typeof candidate !== "object") continue;
    const c = candidate as Record<string, unknown>;
    const node = createNavigationNode({
      id: c.id as string,
      href: c.href as string,
      label: c.label as string,
      parentId: c.parentId as string | null,
      originId: c.originId as string | null,
      scrollY: c.scrollY as number | null,
      focusId: c.focusId as string | null,
      ui: c.ui as NavigationUiState | null,
    });
    if (!node || ids.has(node.id)) continue;
    ids.add(node.id);
    nodes.push(node);
  }
  return {
    version: NAVIGATION_VERSION,
    nodes: nodes.slice(-MAX_NAVIGATION_NODES),
  };
}

export function upsertNavigationNode(
  snapshot: NavigationSnapshot,
  node: NavigationNode,
): NavigationSnapshot {
  const nodes = snapshot.nodes.filter((item) => item.id !== node.id);
  nodes.push(node);
  return {
    version: NAVIGATION_VERSION,
    nodes: nodes.slice(-MAX_NAVIGATION_NODES),
  };
}

export function nodeById(
  snapshot: NavigationSnapshot,
  id: string | null | undefined,
): NavigationNode | null {
  if (!id) return null;
  return snapshot.nodes.find((node) => node.id === id) ?? null;
}

export function navigationTrail(
  snapshot: NavigationSnapshot,
  currentId: string | null | undefined,
): {
  nodes: NavigationNode[];
  truncated: boolean;
} {
  const nodes: NavigationNode[] = [];
  const seen = new Set<string>();
  let current = nodeById(snapshot, currentId);
  let truncated = false;
  while (current) {
    if (seen.has(current.id)) {
      truncated = true;
      break;
    }
    seen.add(current.id);
    nodes.unshift(current);
    const parentId = current.parentId;
    current = nodeById(snapshot, parentId);
    if (!current && parentId) truncated = true;
    if (nodes.length >= MAX_NAVIGATION_NODES) {
      truncated = truncated || !!current;
      break;
    }
  }
  return { nodes, truncated };
}
