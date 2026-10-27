/**
 * A small Nordland (NO-18) world for connector tests, built on recorded
 * Artskart records. Window: Oct 2024 – Sep 2026, read through 2026-10-23.
 *
 * What each part exercises (counts are in-window records):
 *  - Bodø: Greylag Goose ×3 at one site (a pin), by Observer A; one Mew Gull
 *    with no count.
 *  - Narvik: Fieldfare ×2 by Observer A, plus one with no precision.
 *  - Rana: Goldcrest ×40 through May 2025 by Observer D (40 days out); one
 *    Northern Goshawk whose name arrives with a trailing space.
 *  - Røst: Green-winged Teal reported as the subspecies "Anas crecca subsp.
 *    carolinensis" (eBird groups it under Green-winged Teal).
 *  - Lurøy: one "Laridae" report (a family, not a species: unkeyed).
 *  - Nesna: Oystercatcher by a party of two (Observer B|Observer C).
 *  - Saltdal: Willow Ptarmigan at 10 km precision (never a pin).
 *  - County level: one record with no municipality.
 *  - Troms (county 19): one Fieldfare, never read for NO-18.
 *  - Recent: Bodø goose on 2026-10-08 and 2026-10-01 (after the window) and
 *    2026-09-20 (in the window but older than the newest date − 13 days).
 */
import { RECORDED, ddmmyyyy, makeRecord, type ArtskartRecord } from './fake-artskart';

export const WINDOW = { start: '2024-10-01', end: '2026-09-30', through: '2026-10-23' };
export const TODAY = new Date('2026-10-23T12:00:00Z');

export function nordlandRecords(): ArtskartRecord[] {
	const r: ArtskartRecord[] = [];
	type Changes = Record<string, unknown>;
	const add = (base: (typeof RECORDED)[string], changes: Changes | ((i: number) => Changes) = {}, n = 1) => {
		for (let i = 0; i < n; i++) r.push(makeRecord(base, typeof changes === 'function' ? changes(i) : changes));
	};
	const { species: goose, species2: fieldfare, species3: goldcrest, subsp, genus, trailing, party, nullcount, bigprec } = RECORDED;
	// Bodø
	add(goose, {}, 3);
	add(nullcount);
	// Narvik
	add(fieldfare, {}, 2);
	add(fieldfare, { Precision: null });
	// Rana: 40 Goldcrests on 40 different days through April–May 2025.
	add(goldcrest, (i) => ({ CollectedDate: ddmmyyyy(`2025-0${4 + Math.floor(i / 28)}-${String((i % 28) + 1).padStart(2, '0')}`), Collector: 'Observer D' }), 40);
	add(trailing);
	add(subsp);
	add(genus);
	add(party);
	add(bigprec);
	// County level only.
	add(goose, { Municipality: null, MunicipalityId: null, Locality: 'Vestfjorden' });
	// Troms: another county.
	add(fieldfare, { __county: 19, Municipality: 'Harstad', County: 'Troms', CountyId: 55 });
	// Recent
	add(goose, { CollectedDate: '08.10.2026' });
	add(goose, { CollectedDate: '01.10.2026' });
	add(goose, { CollectedDate: '20.09.2026' });
	return r;
}
