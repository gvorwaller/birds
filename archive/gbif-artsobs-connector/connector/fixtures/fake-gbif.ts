/**
 * Test-only stand-in for the GBIF API (td-eec7db Phase 2): serves search,
 * facets, dataset crawls and species from an in-memory record list built on
 * the recorded responses in this folder. Observer names were removed from
 * the recorded records before they were committed.
 */
import recordedPage from './search-page.json';
import recordedProcess from './dataset-process.json';
import { DATASET_KEY } from '../config';
import type { FetchFn } from '../gbif';

export type GbifRecord = Record<string, unknown>;

export const RECORDED: GbifRecord[] = (recordedPage as { results: GbifRecord[] }).results;

let nextKey = 9_000_000_000;

/** A copy of a recorded record with a fresh key and the given changes. */
export function makeRecord(base: GbifRecord, changes: Record<string, unknown> = {}): GbifRecord {
	const r = structuredClone(base);
	r.key = nextKey++;
	r.gbifID = String(r.key);
	r.catalogNumber = String(40_000_000 + (nextKey % 1_000_000));
	if (typeof changes.eventDate === 'string') {
		const [y, m, d] = changes.eventDate.split('-').map(Number);
		Object.assign(r, { year: y, month: m, day: d });
	}
	return Object.assign(r, changes);
}

export const gadm = (gid: string | null) => (gid ? { level0: { gid: 'NOR', name: 'Norway' }, level1: { gid, name: 'x' } } : {});

export interface FakeGbif {
	fetch: FetchFn;
	calls: URL[];
	records: GbifRecord[];
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

export function fakeGbif(opts: {
	records: GbifRecord[];
	species?: Record<number, { canonicalName: string; scientificName: string; rank: string }>;
	crawls?: unknown;
	pubDate?: string;
	/** Return a response to answer a call instead of the normal one (e.g. a 503). */
	intercept?: (url: URL, call: number) => Response | null;
}): FakeGbif {
	const calls: URL[] = [];
	const fake: FakeGbif = {
		calls,
		records: opts.records,
		fetch: async (input) => {
			const url = new URL(input);
			calls.push(url);
			const forced = opts.intercept?.(url, calls.length);
			if (forced) return forced;
			const path = url.pathname.replace(/^\/v1\//, '');
			if (path === `dataset/${DATASET_KEY}/process`) return json(opts.crawls ?? recordedProcess);
			if (path === `dataset/${DATASET_KEY}`) return json({ key: DATASET_KEY, pubDate: opts.pubDate ?? '2026-10-10T00:00:00.000+00:00' });
			const sp = /^species\/(\d+)$/.exec(path);
			if (sp) {
				const key = Number(sp[1]);
				const known = opts.species?.[key];
				if (known) return json({ key, ...known });
				const r = fake.records.find((x) => x.speciesKey === key);
				if (!r) return json({ error: 'not found' }, 404);
				return json({ key, canonicalName: r.species, scientificName: r.taxonKey === key ? r.scientificName : r.species, rank: 'SPECIES' });
			}
			if (path !== 'occurrence/search') return json({ error: 'unknown path' }, 404);
			const q = url.searchParams;
			if (q.get('datasetKey') !== DATASET_KEY || q.get('taxonKey') !== '212' || q.get('occurrenceStatus') !== 'PRESENT') {
				return json({ error: 'the connector must always send the dataset, birds and PRESENT filters' }, 400);
			}
			const [from, to] = (q.get('eventDate') ?? ',').split(',');
			const matches = fake.records
				.filter((r) => {
					// An interval matches every range it overlaps.
					const [start, end = start] = String(r.eventDate).split('/').map((x) => x.slice(0, 10));
					if (from && end < from) return false;
					if (to && start > to) return false;
					if (q.has('stateProvince') && r.stateProvince !== q.get('stateProvince')) return false;
					const gid = (r.gadm as { level1?: { gid?: string } } | undefined)?.level1?.gid;
					if (q.has('gadmLevel1Gid') && gid !== q.get('gadmLevel1Gid')) return false;
					return true;
				})
				.sort((a, b) => Number(a.key) - Number(b.key));
			const facet = q.get('facet');
			if (facet) {
				if (facet !== 'stateProvince') return json({ error: `facet ${facet} not faked` }, 400);
				const counts = new Map<string, number>();
				for (const r of matches) counts.set(String(r.stateProvince), (counts.get(String(r.stateProvince)) ?? 0) + 1);
				const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));
				const off = Number(q.get('facetOffset') ?? 0);
				const lim = Number(q.get('facetLimit') ?? 10);
				return json({ offset: 0, limit: 0, endOfRecords: false, count: matches.length, results: [], facets: [{ field: 'STATE_PROVINCE', counts: sorted.slice(off, off + lim) }] });
			}
			const offset = Number(q.get('offset') ?? 0);
			const limit = Number(q.get('limit') ?? 20);
			const results = matches.slice(offset, offset + limit);
			return json({ offset, limit, endOfRecords: offset + limit >= matches.length, count: matches.length, results, facets: [] });
		}
	};
	return fake;
}
