import type { RibbonGridClient } from './components/migration-ribbon';

/** The grid is plain JSON data. Encoding it as one page-data string avoids
 * devalue's per-number reference table, which exceeds the ribbon byte budget
 * on broad species. JSON preserves these finite numbers without rounding or
 * dropping cells. Decode once per page-data update, during SSR and hydration. */
export function encodeRibbonGrid(grid: RibbonGridClient | null): string | null {
	return grid === null ? null : JSON.stringify(grid);
}

export function decodeRibbonGrid(payload: string | null): RibbonGridClient | null {
	return payload === null ? null : JSON.parse(payload) as RibbonGridClient;
}
