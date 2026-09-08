import { queryTimed } from "$lib/db";

/** 0: in season; 1: other season; 2: unknown; 3: sampled, no historical reports.
 * Historical evidence changes probe order only; even a zero stays searchable.
 */
export type OccurrencePriority = 0 | 1 | 2 | 3;

/** Include the preceding month when the recent-report window crosses a boundary. */
export function reportMonths(at: number, back: number): number[] {
  const end = new Date(at);
  const start = new Date(at);
  start.setUTCDate(
    start.getUTCDate() - Math.min(30, Math.max(1, Math.trunc(back))),
  );
  const months = new Set<number>();
  while (start <= end) {
    months.add(start.getUTCMonth() + 1);
    start.setUTCDate(start.getUTCDate() + 1);
  }
  return [...months];
}

/**
 * One bounded query with indexed lookups for each region/species pair. Read the
 * monthly rollups, not the world-sized weekly table. Exact location matches
 * only: one loaded county/hotspot cannot establish coverage of its whole state.
 * No minimum frequency: a scarce historical report is still positive evidence.
 */
export async function nearestOccurrencePriorities(
  codes: string[],
  speciesCode: string,
  months: number[],
  timeoutMs: number,
): Promise<Map<string, OccurrencePriority>> {
  if (codes.length === 0) return new Map();
  const result = await queryTimed<{
    code: string;
    priority: OccurrencePriority;
  }>(
    `SELECT c.code,
       CASE WHEN evidence.in_season THEN 0
            WHEN evidence.any_season THEN 1
            WHEN ff.loc_code IS NULL OR ff.n_unmatched > 0
                 OR samples.covered_months < 12 THEN 2
            ELSE 3 END::int AS priority
     FROM unnest($1::text[]) AS c(code)
     LEFT JOIN frequency_fetch ff ON ff.loc_code = c.code AND ff.loc_kind = 'region'
     LEFT JOIN LATERAL (
       SELECT bool_or(smf.num > 0 AND smf.month = ANY($3::int[])) AS in_season,
              bool_or(smf.num > 0) AS any_season
       FROM species_month_freq smf
       WHERE smf.loc_code = ff.loc_code AND smf.species_code = $2
     ) evidence ON true
     LEFT JOIN LATERAL (
       SELECT count(*) FILTER (WHERE lms.n > 0) AS covered_months
       FROM loc_month_samples lms WHERE lms.loc_code = ff.loc_code
     ) samples ON true`,
    [codes, speciesCode, months],
    timeoutMs,
  );
  return new Map(result.rows.map((r) => [r.code, r.priority]));
}
