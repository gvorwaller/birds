/**
 * A fake SOS for connector tests (td-99eebf). Record shapes are the real
 * ones from the 2026-11-19 probe (Jönköping county, October 2026), with every
 * person replaced by "Observer A/B/C" and sighting numbers made up: no real
 * birder names or ids live in the repo.
 *
 * It answers POST Observations/Count and Observations/SearchByCursor for the
 * one selection the connector sends (county + start-date range), pages by an
 * opaque cursor, and lets a test intercept any call to break it.
 */
import { randomUUID } from 'node:crypto';

export type SosRecord = Record<string, unknown> & { __county: number };

let next = 900_000_001;

/** One realistic Artportalen bird record; `over` replaces fields by dotted path. */
export function makeSosRecord(over: Record<string, unknown> = {}): SosRecord {
	const id = String(next++);
	const r: SosRecord = {
		__county: 6,
		dataProviderId: 1,
		diffusionStatus: 0,
		sensitive: false,
		modified: '2026-10-01T07:27:10.997+02:00',
		event: { plainStartDate: '2026-10-01' },
		identification: { verificationStatus: { id: 10, value: 'Ovaliderad' } },
		location: {
			decimalLatitude: 58.04,
			decimalLongitude: 14.33,
			coordinateUncertaintyInMeters: 25,
			locality: 'Kumlaby, Visingsö, Sm',
			county: { featureId: '6', name: 'Jönköping' },
			municipality: { featureId: '680', name: 'Jönköping' }
		},
		occurrence: {
			occurrenceId: `urn:lsid:artportalen.se:sighting:${id}`,
			catalogNumber: id,
			url: `https://www.artportalen.se/sighting/${id}`,
			recordedBy: 'Observer A',
			organismQuantityInt: 2,
			isPositiveObservation: true,
			activity: { id: 25, value: 'födosökande' }
		},
		taxon: {
			id: 102949,
			scientificName: 'Fulica atra',
			vernacularName: 'sothöna',
			taxonRank: 'species',
			attributes: { redlistCategory: 'LC' }
		}
	};
	for (const [path, value] of Object.entries(over)) {
		if (path === '__county') {
			r.__county = value as number;
			continue;
		}
		const keys = path.split('.');
		let o = r as Record<string, unknown>;
		for (const k of keys.slice(0, -1)) o = (o[k] ??= {}) as Record<string, unknown>;
		if (value === undefined) delete o[keys.at(-1)!];
		else o[keys.at(-1)!] = value;
	}
	return r;
}

export interface SosCall {
	kind: 'count' | 'page';
	county: number;
	from: string;
	to: string;
	cursor: string | null;
	take: number;
}

export interface FakeSos {
	fetch: (input: string, init?: RequestInit) => Promise<Response>;
	calls: SosCall[];
	records: SosRecord[];
}

/**
 * `intercept` may return a Response to send instead, or mutate `records`
 * between calls (a report added or re-dated mid-read).
 */
export function fakeSos(opts: { records: SosRecord[]; intercept?: (call: SosCall, n: number, fake: FakeSos) => Response | void }): FakeSos {
	const cursors = new Map<string, number>();
	const fake: FakeSos = {
		calls: [],
		records: opts.records,
		fetch: async (input, init) => {
			const url = new URL(input);
			const body = JSON.parse(String(init?.body ?? '{}'));
			const area = body.geographics?.areas?.[0];
			const county = Number(area?.featureId);
			const { startDate: from, endDate: to, dateFilterType } = body.date ?? {};
			if (dateFilterType !== 'OnlyStartDate' || body.dataProvider?.ids?.[0] !== 1 || body.occurrenceStatus !== 'Present') {
				return new Response('unexpected selection', { status: 400 });
			}
			const kind = url.pathname.endsWith('/Observations/Count') ? 'count' : 'page';
			const cursor = url.searchParams.get('cursor');
			const take = Number(url.searchParams.get('take') ?? 1000);
			const call: SosCall = { kind, county, from, to, cursor, take };
			fake.calls.push(call);
			const hit = opts.intercept?.(call, fake.calls.length, fake);
			if (hit) return hit;
			const matching = fake.records
				.filter((r) => r.__county === county)
				.filter((r) => {
					const d = (r.event as { plainStartDate: string }).plainStartDate;
					return d >= from && d <= to;
				});
			if (kind === 'count') return Response.json(matching.length);
			const offset = cursor ? cursors.get(cursor) : 0;
			if (offset === undefined) return new Response('unknown cursor', { status: 400 });
			const records = matching.slice(offset, offset + take).map(({ __county: _c, ...r }) => r);
			let nextCursor: string | null = null;
			if (offset + take < matching.length) {
				nextCursor = randomUUID();
				cursors.set(nextCursor, offset + take);
			}
			return Response.json({ take, totalCount: matching.length, records, nextCursor });
		}
	};
	return fake;
}
