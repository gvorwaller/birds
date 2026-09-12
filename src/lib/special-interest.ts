/** Exact personal-write exception; never grants access to owner mutations. */
export function isSpecialInterestRequest(
  path: string,
  method: string,
): boolean {
  return path === "/api/special-interest" && method === "POST";
}
