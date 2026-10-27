/**
 * A fake Artskart public API for connector tests, serving records built from
 * real recorded Artskart records (fixtures/records.json; observer names
 * replaced, notes removed). It answers `observations/list` the way the real
 * one did in the 2026-10-26 probe: filtered by county, inclusive dates,
 * ordered by date, paged, with TotalCount/TotalPages.
 */
import recorded from './records.json';

export type ArtskartRecord = Record<string, unknown> & { Id: string; CollectedDate: string; __county: number };

export const RECORDED = recorded as unknown as Record<string, Omit<ArtskartRecord, '__county'>>;

let serial = 0;

/** A copy of a recorded record with a new id (and the changes), in county 18 unless changed. */
export function makeRecord(base: Omit<ArtskartRecord, '__county'>, changes: Record<string, unknown> = {}): ArtskartRecord {
	serial++;
	return {
		...base,
		Id: `urn:uuid:00000000-0000-4000-8000-${String(serial).padStart(12, '0')}`,
		CatalogNumber: String(90_000_000 + serial),
		__county: 18,
		...changes
	} as unknown as ArtskartRecord;
}

/** dd.mm.yyyy for an ISO date. */
export function ddmmyyyy(iso: string): string {
	return `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
}

const isoOf = (d: string) => `${d.slice(6, 10)}-${d.slice(3, 5)}-${d.slice(0, 2)}`;

export interface FakeOptions {
	records: ArtskartRecord[];
	/**
	 * Called before each request is answered; may change `records` (a report
	 * added or moved mid-read) or return a Response to send instead.
	 */
	intercept?: (url: URL, records: ArtskartRecord[]) => Response | null | void;
	/** Rows Artskart repeats on a page (the real API does, ~0.1%): page index → count. */
	repeatRows?: (url: URL) => number;
}

export function fakeArtskart(opts: FakeOptions) {
	const calls: URL[] = [];
	const records = opts.records;
	const fetch = async (input: string): Promise<Response> => {
		const url = new URL(input);
		calls.push(url);
		const forced = opts.intercept?.(url, records);
		if (forced) return forced;
		if (!url.pathname.endsWith('/publicapi/api/observations/list')) return new Response('not found', { status: 404 });
		const county = Number(url.searchParams.get('countys[]'));
		const from = url.searchParams.get('fromDate')!;
		const to = url.searchParams.get('toDate')!;
		const pageSize = Number(url.searchParams.get('pageSize'));
		const pageIndex = Number(url.searchParams.get('pageIndex'));
		if (url.searchParams.get('taxongroups[]') !== '8' || url.searchParams.get('collections[]') !== 'so2-birds') {
			return new Response('{"Message":"unexpected filter"}', { status: 500 });
		}
		const hits = records
			.filter((r) => r.__county === county)
			.filter((r) => {
				const d = isoOf(r.CollectedDate);
				return d >= from && d <= to;
			})
			.sort((a, b) => isoOf(a.CollectedDate).localeCompare(isoOf(b.CollectedDate)) || a.Id.localeCompare(b.Id));
		const page = hits.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize).map(({ __county: _c, ...r }) => r);
		const repeat = Math.min(opts.repeatRows?.(url) ?? 0, page.length);
		const rows = [...page, ...page.slice(0, repeat)];
		return Response.json({
			Observations: rows,
			PageIndex: pageIndex,
			PageSize: pageSize,
			TotalCount: hits.length,
			TotalPages: Math.ceil(hits.length / pageSize)
		});
	};
	return { fetch, calls, records };
}
