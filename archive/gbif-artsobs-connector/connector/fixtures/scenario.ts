/**
 * A small Nordland (NO-18) world for connector tests, built on recorded GBIF
 * records. Window: Oct 2024 – Sep 2026, fetched through 2026-10-23, GBIF's
 * last good copy on 2026-10-11 (the recorded crawl list).
 *
 * What each part exercises (counts are in-window records):
 *  - Bodø: Greylag Goose ×3 at one site (a pin), one record GBIF could only
 *    name as "Aves" (unkeyed), placed by GADM.
 *  - Narvik: Fieldfare ×1, plus one with no uncertainty, one generalized,
 *    one GBIF key that is a genus (unkeyed); one more Narvik record lies in
 *    Troms' polygon (split municipality).
 *  - Rana: four species; one record outside every polygon, placed by its
 *    municipality; 40 Goldcrests through May 2025.
 *  - Alstahaug: Red-breasted Merganser ×2, one outside every polygon.
 *  - "Norskekysten hav S": offshore, outside every polygon → unplaced.
 *  - Troms (2024 county): 50 Evenes records in Nordland's polygon (so Troms
 *    is fetched), 10 in Troms' polygon; Harstad stays in Troms; a Troms
 *    "Herøy" in Nordland's polygon clashes with Nordland's own Herøy.
 *  - Trøndelag: one record in Nordland's polygon (below the threshold, so
 *    Trøndelag is never fetched).
 *  - Recent: Bodø goose on 2026-10-08 and 2026-10-01 (after the window) and
 *    2026-09-20 (in the window but older than the newest date − 13 days).
 */
import { RECORDED, gadm, makeRecord, type GbifRecord } from './fake-gbif';

export const WINDOW = { start: '2024-10-01', end: '2026-09-30', through: '2026-10-23' };
export const TODAY = new Date('2026-10-23T12:00:00Z');
export const GENUS_KEY = 999_001;

const [goose, fieldfare, goldcrest, flycatcher, redshankNoGadm, woodcock, aves, mergNoGadm] = RECORDED;

export function nordlandRecords(): GbifRecord[] {
	const r: GbifRecord[] = [];
	type Changes = Record<string, unknown>;
	const add = (base: GbifRecord, changes: Changes | ((i: number) => Changes) = {}, n = 1) => {
		for (let i = 0; i < n; i++) r.push(makeRecord(base, typeof changes === 'function' ? changes(i) : changes));
	};
	// Spread over a month, so no single day holds more than a few records
	// (paging tests shrink GBIF's cap to 8).
	let spread = 0;
	const dayIn = (month: string) => `${month}-${String((spread++ % 28) + 1).padStart(2, '0')}`;
	// Bodø
	add(goose, {}, 3);
	add(aves);
	// Narvik
	add(fieldfare);
	add(fieldfare, { coordinateUncertaintyInMeters: null });
	add(fieldfare, { dataGeneralizations: 'Coordinates generalized to 10 km' });
	add(fieldfare, { speciesKey: GENUS_KEY, species: 'Turdus' });
	add(fieldfare, { gadm: gadm('NOR.17_1') });
	// Rana
	add(goldcrest);
	add(flycatcher);
	add(redshankNoGadm);
	add(woodcock);
	add(goldcrest, () => ({ eventDate: dayIn('2025-05') }), 40);
	// Alstahaug (one in the polygon, one outside: majority rule)
	add(mergNoGadm);
	add(mergNoGadm, { gadm: gadm('NOR.10_1') });
	// Offshore: unplaced
	add(mergNoGadm, { municipality: 'Norskekysten hav S', locality: 'Dvalin, Norskekysten hav S, Ns' });
	// Herøy (Nordland)
	add(goose, { municipality: 'Herøy', locality: 'Herøy kirke, Herøy, No', decimalLatitude: 65.98, decimalLongitude: 12.29 });
	// Troms
	const troms = () => ({ stateProvince: 'Troms', county: 'Troms', eventDate: dayIn('2025-10') });
	add(fieldfare, () => ({ ...troms(), municipality: 'Evenes', locality: 'Bogen, Evenes, Tr', gadm: gadm('NOR.10_1') }), 50);
	add(fieldfare, () => ({ ...troms(), municipality: 'Evenes', locality: 'Evenes flyplass, Evenes, Tr', gadm: gadm('NOR.17_1') }), 10);
	add(fieldfare, () => ({ ...troms(), municipality: 'Harstad', locality: 'Harstad havn, Harstad, Tr', gadm: gadm('NOR.17_1') }), 5);
	add(fieldfare, () => ({ ...troms(), municipality: 'Harstad', locality: 'Kanebogen, Harstad, Tr', gadm: {} }), 2);
	add(fieldfare, () => ({ ...troms(), municipality: 'Herøy', locality: 'Feil, Herøy, Tr', gadm: gadm('NOR.10_1') }));
	// Trøndelag (never fetched for NO-18)
	add(fieldfare, { stateProvince: 'Trøndelag', municipality: 'Bindal', gadm: gadm('NOR.10_1') });
	// Recent
	add(goose, { eventDate: '2026-10-08' });
	add(goose, { eventDate: '2026-10-01' });
	add(goose, { eventDate: '2026-09-20' });
	add(aves, { eventDate: '2026-10-07' });
	return r;
}

export const GENUS_SPECIES = { [GENUS_KEY]: { canonicalName: 'Turdus', scientificName: 'Turdus Linnaeus, 1758', rank: 'GENUS' } };
