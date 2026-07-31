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

/**
 * The radius a page view actually uses.
 *
 * - `dist` absent → the user's saved radius (or the default).
 * - `dist` a valid 1–50 km integer → that value, for this view only.
 * - `dist` present but invalid → the saved radius, never a hard-coded 50.
 *
 * Keeping this in one place is what stops `/` and a legacy `/targets?dist=…`
 * link from disagreeing about the effective radius.
 */
export function selectEffectiveRadiusKm(
  distParam: string | number | null | undefined,
  savedKm: number | string | null | undefined,
): number {
  const saved = normalizeNearMeRadiusKm(savedKm);
  if (distParam == null) return saved;
  const raw = typeof distParam === "number" ? String(distParam) : distParam;
  if (raw.trim() === "") return saved;
  return normalizeNearMeRadiusKm(raw, saved);
}

/**
 * Options for a radius `<select>` that is guaranteed to contain the effective
 * value. Without this, a saved 40 km radius rendered against a list that lacks
 * 40 shows the first option as selected and the next search silently shrinks
 * the search area.
 */
export function radiusSelectOptionsKm(effectiveKm: number): number[] {
  const opts = new Set<number>(NEAR_ME_RADIUS_OPTIONS_KM);
  opts.add(normalizeNearMeRadiusKm(effectiveKm));
  return [...opts].sort((a, b) => a - b);
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
