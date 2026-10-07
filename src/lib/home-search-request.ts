/**
 * Home's remembered-search actions (td-9304cd): the signed-in account's own
 * state, never owner data, so a read-only viewer may use them. Exactly these
 * two first actions on `/` — SvelteKit dispatches the FIRST `?/name` key.
 */
export function isHomeSearchRequest(
  path: string,
  method: string,
  action?: string,
): boolean {
  return (
    method === "POST" &&
    path === "/" &&
    (action === "/search" || action === "/reset")
  );
}
