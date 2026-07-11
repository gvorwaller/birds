export const DEFAULT_NEAR_ME_RADIUS_KM = 40;
export const MIN_NEAR_ME_RADIUS_KM = 1;
export const MAX_NEAR_ME_RADIUS_KM = 50;

export const NEAR_ME_RADIUS_OPTIONS_KM = [8, 16, 24, 40, 50] as const;

export type NearMeRadiusOptionKm = (typeof NEAR_ME_RADIUS_OPTIONS_KM)[number];

export function normalizeNearMeRadiusKm(
  value: number | string | null | undefined,
  fallback = DEFAULT_NEAR_ME_RADIUS_KM,
): number {
  const n = typeof value === "number" ? value : Number(value);
  if (
    Number.isInteger(n) &&
    n >= MIN_NEAR_ME_RADIUS_KM &&
    n <= MAX_NEAR_ME_RADIUS_KM
  ) {
    return n;
  }
  return fallback;
}

export function validateNearMeRadiusKm(
  value: FormDataEntryValue | number | string | null | undefined,
): { ok: true; value: number } | { ok: false; error: string } {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n)) {
    return { ok: false, error: "Choose a whole-number radius." };
  }
  if (n < MIN_NEAR_ME_RADIUS_KM || n > MAX_NEAR_ME_RADIUS_KM) {
    return {
      ok: false,
      error: `Radius must be between ${MIN_NEAR_ME_RADIUS_KM} and ${MAX_NEAR_ME_RADIUS_KM} km.`,
    };
  }
  return { ok: true, value: n };
}
