/**
 * Browser side of account usage (td-c8e6a3). After a navigation finishes on a
 * page shown without an error, report its route once per account, UTC day and
 * section. A preload, a failed or redirected load (only the final page
 * arrives here) and a download never reach this.
 */
import { usageFeatureFor } from "$lib/usage-features";

const sent = new Set<string>();

/** Returns whether a report was sent (for tests). */
export function reportPageUse(
  userId: number | null | undefined,
  routeId: string | null,
  status: number,
  hasError: boolean,
  send: typeof fetch = fetch,
  now = new Date(),
): boolean {
  if (userId == null || hasError || status >= 400) return false;
  const feature = usageFeatureFor(routeId);
  if (!feature) return false;
  const key = `${now.toISOString().slice(0, 10)}|${userId}|${feature}`;
  if (sent.has(key)) return false;
  sent.add(key);
  send("/api/activity", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ routeId }),
    keepalive: true,
  })
    .then((r) => {
      if (!r.ok) sent.delete(key);
    })
    .catch(() => sent.delete(key));
  return true;
}

/** Test hook. */
export function resetPageUseReports(): void {
  sent.clear();
}
