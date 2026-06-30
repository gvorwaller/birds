export const BACK_OPTIONS = [1, 7, 14, 30] as const;

export type BackOption = (typeof BACK_OPTIONS)[number];

export const DEFAULT_BACK_DAYS: BackOption = 7;
export const SPECIES_DEFAULT_BACK_DAYS: BackOption = 14;

export function parseBackDays(
  value: string | number | null | undefined,
  fallback: BackOption = DEFAULT_BACK_DAYS,
): BackOption {
  const n = typeof value === "number" ? value : Number(value);
  return BACK_OPTIONS.includes(n as BackOption) ? (n as BackOption) : fallback;
}

export function backOptionLabel(days: number): string {
  return days === 1 ? "Last 24 hours" : `Last ${days} days`;
}

export function windowPhrase(days: number): string {
  return days === 1 ? "last 24 hours" : `last ${days} days`;
}
