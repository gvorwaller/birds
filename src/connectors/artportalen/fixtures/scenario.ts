/**
 * A small Jönköpings län (SE-F) world for the Sweden connector's tests.
 * Window: Oct 2025 – Sep 2026 (12 months), read through 2026-10-23.
 *
 *  - Jönköping kommun (featureId 680): Coots on Visingsö by Observer A, a
 *    party of two ("Observer B, Observer C"), and one report blurred by its
 *    reporter (diffusionStatus 2) that must never keep its point.
 *  - Nässjö (682): a species aggregate ("Anser fabalis/serrirostris", not a
 *    species) and a subspecies (Motacilla flava thunbergi).
 *  - Gränna-side pairs: Mute Swan counted as 3 PAIRS (unit 13, nests) — kept
 *    as a note, never as a count.
 *  - Red-listed Goshawk (NT) with its Artfakta link.
 *  - Recent: Coots on 2026-10-08 and 2026-10-01 (after the window), and a
 *    SENSITIVE one on 2026-10-09 by Observer Y that must keep only the
 *    restricted fields (no point, locality, observer, link or remarks).
 *  - Stockholm (county 1): one report, never read for SE-F.
 */
import { makeSosRecord, type SosRecord } from './fake-sos';

export const WINDOW = { start: '2025-10-01', end: '2026-09-30', through: '2026-10-23' };
export const TODAY = new Date('2026-10-23T12:00:00Z');

export function jonkopingRecords(): SosRecord[] {
	const r: SosRecord[] = [];
	const add = (over: Record<string, unknown> = {}, n = 1) => {
		for (let i = 0; i < n; i++) r.push(makeSosRecord(over));
	};
	// Visingsö Coots, through the year.
	for (const d of ['2025-10-05', '2026-01-12', '2026-05-03', '2026-05-04', '2026-09-30']) add({ 'event.plainStartDate': d });
	add({ 'event.plainStartDate': '2026-05-10', 'occurrence.recordedBy': 'Observer B, Observer C', 'occurrence.organismQuantityInt': 7 });
	// Blurred by its reporter.
	add({
		'event.plainStartDate': '2026-05-11',
		diffusionStatus: 2,
		'location.decimalLatitude': 58.05,
		'location.decimalLongitude': 14.3,
		'location.coordinateUncertaintyInMeters': 1000,
		'location.locality': 'Hidden Lake, Jönköping',
		'occurrence.recordedBy': 'Observer Z',
		'occurrence.occurrenceRemarks': 'Nest by the old oak'
	});
	// A protected sighting, recent, by its own observer: never a point, a name or a link.
	add({ 'event.plainStartDate': '2026-10-09', sensitive: true, 'occurrence.recordedBy': 'Observer Y', 'location.locality': 'Secret Marsh' });
	// Nässjö: an aggregate and a subspecies.
	const nassjo = { 'location.municipality': { featureId: '682', name: 'Nässjö' }, 'location.locality': 'Ingsbergssjön, Nässjö, Sm', 'location.decimalLatitude': 57.65, 'location.decimalLongitude': 14.7 };
	add({ ...nassjo, 'event.plainStartDate': '2026-03-20', 'taxon.id': 6006001, 'taxon.scientificName': 'Anser fabalis/serrirostris', 'taxon.taxonRank': 'speciesAggregate', 'taxon.vernacularName': 'sädgås/tundrasädgås' });
	add({ ...nassjo, 'event.plainStartDate': '2026-05-20', 'taxon.id': 266836, 'taxon.scientificName': 'Motacilla flava thunbergi', 'taxon.taxonRank': 'subspecies', 'taxon.vernacularName': 'nordlig gulärla' });
	// Three pairs of Mute Swans: not a count of birds.
	add({ 'event.plainStartDate': '2026-04-15', 'taxon.id': 100008, 'taxon.scientificName': 'Cygnus olor', 'taxon.vernacularName': 'knölsvan', 'occurrence.organismQuantityInt': 3, 'occurrence.organismQuantityUnit': { id: 13, value: 'nests' } });
	// Red-listed.
	add({ 'event.plainStartDate': '2026-02-02', 'taxon.id': 100001, 'taxon.scientificName': 'Astur gentilis', 'taxon.vernacularName': 'duvhök', 'taxon.attributes': { redlistCategory: 'NT' } });
	// Recent, after the window.
	add({ 'event.plainStartDate': '2026-10-08' });
	add({ 'event.plainStartDate': '2026-10-01' });
	// Stockholm.
	add({ __county: 1, 'event.plainStartDate': '2026-05-01', 'location.municipality': { featureId: '180', name: 'Stockholm' } });
	return r;
}
