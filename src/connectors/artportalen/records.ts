/**
 * One SOS (Artportalen) record → the shared compact record (td-99eebf). Pure.
 *
 * Fields per the 2026-11-19 probe (plan, "Phase 0 findings"):
 *   - the date is `event.plainStartDate`, the Swedish local date the report
 *     started (the slice filter selects on it too);
 *   - `occurrence.recordedBy` holds the observers, several separated by ", ";
 *   - a quantity counts birds only when its unit is none or individuals:
 *     pairs, nests and the like are kept as a note, never as a count;
 *   - `modified` carries a zone offset; the contract stores wall time with no
 *     zone, so the Swedish local time is kept as given and the offset dropped.
 *
 * Privacy (plan [C1-5]; CODEX1 code review R2 and round 2): a record keeps
 * its precise details only with explicit evidence it is safe:
 * `diffusionStatus` 0 (not blurred) AND `sensitive` false (not a protected
 * sighting), both with exactly those types. Anything else — blurred by the
 * system (1) or the reporter (2), sensitive, or either field missing or
 * mistyped — is cut down to the RESTRICTED allowlist (restricted() below):
 * its sighting number, date, species, county and kommun, and a count of
 * birds. Nothing else of it leaves this function: no point, precision,
 * locality, remarks, quantity note, behaviour or activity, validation, sex,
 * link, observers or modification time. So it never reaches the spool with
 * them, an observer ranking, a locality or a latest-reports row (those need a
 * link). The sighting number is kept: exact counting and de-duplication need
 * it, and it shows nothing Artportalen doesn't (no link to it is stored).
 */
import { cleanText, type CompactRecord, type Taxon } from '../shared/records';
import { ACTIVITY_EN, INDIVIDUAL_UNITS, SEX_EN, sightingUrl, taxonUrl } from './config';

export type SkipReason = 'undated' | 'absent';

/** Sighting numbers up to 15 digits: exact as JavaScript numbers (CODEX1 R11; today's are 9). */
const ID = /^\d{1,15}$/;
const SPECIES = /^([A-Z][a-z]+) ([a-z][a-z-]*)$/;
const TRINOMIAL = /^([A-Z][a-z]+) ([a-z][a-z-]*) ([a-z][a-z-]*)$/;
/** Dyntaxa's Feral Pigeon, the one domesticated form kept (CODEX1: no other taxon gets an inferred name). */
const FERAL_PIGEON = 'Columba livia, domesticated populations';

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : {});

/** The record's Artportalen sighting number, or null when it has none. */
export function recordId(raw: unknown): string | null {
	const r = recordIdentity(raw);
	return r === 'conflict' ? null : r;
}

/** Digits without leading zeros ("007" → "7"), or null when not 1–15 digits. */
function sightingNumber(v: string): string | null {
	return ID.test(v) ? String(Number(v)) : null;
}

/**
 * The record's one identity (CODEX1 round 6), resolved once and used for
 * every de-duplication: the sighting number in `occurrenceId` (the plan's
 * key), else `catalogNumber`, digits normalized. When both are usable and
 * disagree the record contradicts itself: 'conflict', never a guess.
 */
export function recordIdentity(raw: unknown): string | 'conflict' | null {
	const occ = obj(obj(raw).occurrence);
	const m = typeof occ.occurrenceId === 'string' ? /^urn:lsid:artportalen\.se:sighting:(\d{1,15})$/i.exec(occ.occurrenceId.trim()) : null;
	const fromUrn = m ? sightingNumber(m[1]) : null;
	const catalogText = typeof occ.catalogNumber === 'string' || typeof occ.catalogNumber === 'number' ? String(occ.catalogNumber).trim() : '';
	const fromCatalog = sightingNumber(catalogText);
	if (fromUrn && fromCatalog && fromUrn !== fromCatalog) return 'conflict';
	return fromUrn ?? fromCatalog;
}

/** A real YYYY-MM-DD date, or null. */
export function isoDate(v: unknown): string | null {
	if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v.trim())) return null;
	const iso = v.trim();
	const d = new Date(`${iso}T00:00:00Z`);
	return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === iso ? iso : null;
}

/** "2026-10-01T07:27:10.997+02:00" → "2026-10-01T07:27:10.997" (local wall time); null when unreadable. */
export function modifiedAt(v: unknown): string | null {
	const m = typeof v === 'string' ? /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/.exec(v.trim()) : null;
	if (!m || !isoDate(m[1])) return null;
	const [h, mi, s] = m[2].split(':').map(Number);
	if (h > 23 || mi > 59 || s > 59) return null;
	return `${m[1]}T${m[2]}${m[3] ? m[3].slice(0, 7) : ''}`;
}

/** Observers in "A, B, C": trimmed, empty and over-long names dropped, each once. */
export function observerNames(v: unknown): string[] {
	if (typeof v !== 'string') return [];
	const out: string[] = [];
	for (const part of v.split(',')) {
		const name = cleanText(part);
		if (name && name.length <= 200 && !out.includes(name)) out.push(name);
	}
	return out;
}

/**
 * A species or subspecies by Dyntaxa's own rank; anything else (genus,
 * aggregates, hybrids) is not one. A domesticated form (Feral Pigeon, ~70
 * reports a month in Jönköping alone) is kept as the form "<binomial>
 * domestica" under its species, so Admin → Sources can match it the way eBird
 * files it (Rock Pigeon) instead of it never counting.
 */
export function classifyTaxon(id: string | null, name: string | null, rank: unknown): Taxon | null {
	if (!id || !name) return null;
	if (name === FERAL_PIGEON && rank === 'unranked') return { id, canonical: 'Columba livia domestica', raw: name, rank: 'SUBSPECIES', binomial: 'Columba livia' };
	if (rank === 'species' && SPECIES.test(name)) return { id, canonical: name, raw: name, rank: 'SPECIES', binomial: name };
	const tri = rank === 'subspecies' ? TRINOMIAL.exec(name) : null;
	if (tri) return { id, canonical: name, raw: name, rank: 'SUBSPECIES', binomial: `${tri[1]} ${tri[2]}` };
	return null;
}

function vocabId(v: unknown): number | null {
	const id = obj(v).id;
	return typeof id === 'number' && Number.isInteger(id) ? id : null;
}

/** English behaviour words for the contract's short lower-case list. */
function behaviourWords(activity: number | null, behavior: number | null): string[] {
	const out: string[] = [];
	for (const id of [behavior, activity]) {
		const en = id === null ? undefined : ACTIVITY_EN[id];
		if (!en) continue;
		const word = en.toLowerCase().replace(/[^a-z0-9_ -]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
		if (/^[a-z][a-z0-9_ -]{0,39}$/.test(word) && !out.includes(word)) out.push(word);
	}
	return out;
}

function shortText(v: unknown, max: number): string | null {
	const t = cleanText(v);
	return t && t.length <= max ? t : null;
}

function finite(v: unknown): number | null {
	return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Explicit evidence a record may keep its precise details: not blurred and not sensitive. */
export function isPrecise(r: Record<string, unknown>): boolean {
	return r.diffusionStatus === 0 && r.sensitive === false;
}

export function compactRecord(raw: unknown): CompactRecord | SkipReason {
	const r = obj(raw);
	const occ = obj(r.occurrence);
	const ev = obj(r.event);
	const loc = obj(r.location);
	const tax = obj(r.taxon);
	const id = recordId(raw)!;
	if (occ.isPositiveObservation === false) return 'absent';
	const date = isoDate(ev.plainStartDate);
	if (!date) return 'undated';

	const taxonId = typeof tax.id === 'number' && Number.isInteger(tax.id) ? String(tax.id) : null;
	const name = cleanText(tax.scientificName);
	const taxon = classifyTaxon(taxonId, name, tax.taxonRank);

	// Privacy screen first: nothing below sees a restricted record's details.
	const exact = isPrecise(r);
	let lat = exact ? finite(loc.decimalLatitude) : null;
	let lon = exact ? finite(loc.decimalLongitude) : null;
	if (lat === null || lon === null || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
		lat = null;
		lon = null;
	}
	const unc = exact ? finite(loc.coordinateUncertaintyInMeters) : null;
	const uncertainty = unc !== null && unc >= 0 && unc <= 2_147_483_647 ? Math.round(unc) : null;

	const muni = obj(loc.municipality);
	const municipality = shortText(muni.name, 100);
	const municipalityId = typeof muni.featureId === 'string' || typeof muni.featureId === 'number' ? String(muni.featureId).trim() : '';

	const qty = finite(occ.organismQuantityInt);
	const unitId = vocabId(occ.organismQuantityUnit);
	// Birds only when no unit is given at all, or a known individuals id is
	// (CODEX1 R7): a unit object without a usable id ({value: 'nests'}) is not.
	const noUnit = occ.organismQuantityUnit === undefined || occ.organismQuantityUnit === null;
	const unitIsBirds = noUnit || (unitId !== null && INDIVIDUAL_UNITS.has(unitId));
	const count = qty !== null && Number.isInteger(qty) && qty >= 0 && qty <= 999_999_999 && unitIsBirds ? qty : null;
	const unitText = shortText(obj(occ.organismQuantityUnit).value, 40);
	const quantityNote = qty !== null && !unitIsBirds ? `Quantity: ${qty} ${unitText ?? `(unit ${unitId})`}` : null;
	const remarks = exact ? cleanText(occ.occurrenceRemarks) : null;
	const notes = [quantityNote, remarks].filter(Boolean).join('. ').slice(0, 500) || null;

	const activityId = vocabId(occ.activity);
	const sexId = vocabId(occ.sex);
	// The link is always built from the record's own resolved identity, never
	// copied from the provider's url field, so a record can't point at another
	// sighting (CODEX1 round 7). Restricted records get none.
	const url = exact ? sightingUrl(id) : null;
	const redList = typeof obj(tax.attributes).redlistCategory === 'string' ? (obj(tax.attributes).redlistCategory as string).trim() : '';

	const full: CompactRecord = {
		id,
		date,
		month: Number(date.slice(5, 7)),
		taxon,
		otherName: taxon ? null : (name ?? '(no name)').slice(0, 200),
		municipality,
		locality: exact ? (cleanText(loc.locality)?.slice(0, 300) ?? null) : null,
		lat: lat === null ? null : Math.round(lat * 1e6) / 1e6,
		lon: lon === null ? null : Math.round(lon * 1e6) / 1e6,
		uncertainty,
		count,
		observers: exact ? observerNames(occ.recordedBy) : [],
		url,
		taxonId: taxonId,
		localName: shortText(tax.vernacularName, 200),
		redList: /^[A-Z]{2}$/.test(redList) ? redList : null,
		redListUrl: taxonId && /^[A-Z]{2}$/.test(redList) ? taxonUrl(taxonId) : null,
		municipalityId: /^\d{1,10}$/.test(municipalityId) ? municipalityId : null,
		behaviour: behaviourWords(activityId, vocabId(occ.behavior)),
		activity: activityId !== null ? (ACTIVITY_EN[activityId] ?? null) : null,
		validation: shortText(obj(obj(r.identification).verificationStatus).value, 100),
		notes,
		sex: sexId !== null ? (SEX_EN[sexId] ?? null) : null,
		photos: null,
		dataset: null,
		modifiedAt: modifiedAt(r.modified)
	};
	return exact ? full : restricted(full);
}

/**
 * The restricted allowlist (see the header): every field named, nothing
 * copied by spread, so a field added to CompactRecord later stays out until
 * it is listed here on purpose.
 */
export function restricted(r: CompactRecord): CompactRecord {
	return {
		id: r.id,
		date: r.date,
		month: r.month,
		taxon: r.taxon,
		otherName: r.otherName,
		municipality: r.municipality,
		municipalityId: r.municipalityId,
		count: r.count,
		taxonId: r.taxonId,
		localName: r.localName,
		redList: r.redList,
		redListUrl: r.redListUrl,
		locality: null,
		lat: null,
		lon: null,
		uncertainty: null,
		observers: [],
		url: null,
		behaviour: [],
		activity: null,
		validation: null,
		notes: null,
		sex: null,
		photos: null,
		dataset: null,
		modifiedAt: null
	};
}
