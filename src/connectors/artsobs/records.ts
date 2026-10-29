/**
 * One Artskart record → the compact form the connector counts (td-eec7db
 * Phase 2 rev B). Pure: no I/O.
 *
 * Fields are Artskart's (probe 2026-10-26): `CollectedDate` is dd.mm.yyyy,
 * coordinates use a decimal comma, `Precision` is metres, and `Collector`
 * holds the party separated by "|". Observer names are kept (owner,
 * 2026-10-26); nothing else personal is read.
 *
 * Every detail of a report is kept since td-769300 (owner 2026-10-28: "keep
 * the records"). Field fill rates in a 3,000-record Nordland sample
 * (2026-10-28): Name 99.7%, Red List 98%, Count 94%, Notes 79% (structured
 * "Activity: …." and "Validationstatus: …"), Behavior 68%, Sex 10%, photos
 * 9%, DatasetName 0.7%. IdentifiedBy, Habitat and Info were never filled.
 */
import { sightingUrl } from './config';

export type TaxonRank = 'SPECIES' | 'SUBSPECIES';

export interface Taxon {
	/** Artskart's TaxonId. */
	id: string;
	/** "Genus species" or "Genus species x". */
	canonical: string;
	/** The name as Artskart sent it, spaces collapsed. */
	raw: string;
	rank: TaxonRank;
	/** "Genus species": what an observer's species count counts. */
	binomial: string;
}

export interface CompactRecord {
	id: string;
	/** YYYY-MM-DD */
	date: string;
	month: number;
	/** Null: not a species or subspecies (genus or family reports, hybrids). */
	taxon: Taxon | null;
	/** The name of a non-species record, for the connector notes. */
	otherName: string | null;
	municipality: string | null;
	locality: string | null;
	lat: number | null;
	lon: number | null;
	uncertainty: number | null;
	count: number | null;
	observers: string[];
	url: string | null;
	/** Artskart's TaxonId, also for a record that is not a species. */
	taxonId: string | null;
	/** The Norwegian name ("grågås"). */
	localName: string | null;
	/** Norsk Rødliste 2021 (mainland) category and its page. */
	redList: string | null;
	redListUrl: string | null;
	municipalityId: string | null;
	behaviour: string[];
	activity: string | null;
	validation: string | null;
	notes: string | null;
	sex: string | null;
	photos: { url: string; by: string | null }[] | null;
	dataset: string | null;
	/** TrackDateTime as given (no zone stated), cut to microseconds. */
	modifiedAt: string | null;
}

export type SkipReason = 'undated';

const ID = /^[A-Za-z0-9._:-]{1,64}$/;
const SPECIES = /^([A-Z][a-z]+) ([a-z][a-z-]*)$/;
const INFRA = /^([A-Z][a-z]+) ([a-z][a-z-]*) (?:subsp\.|var\.|f\.) ([a-z][a-z/-]*)$/;

/** Trimmed, inner spaces collapsed ("Astur gentilis " arrives with a trailing space). */
export function cleanText(v: unknown): string | null {
	if (typeof v !== 'string') return null;
	const s = v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
	return s.length > 0 ? s : null;
}

export function classifyName(id: string | null, name: string | null): Taxon | null {
	if (!id || !name || !/^[A-Za-z0-9._:-]{1,64}$/.test(id)) return null;
	const sp = SPECIES.exec(name);
	if (sp) return { id, canonical: name, raw: name, rank: 'SPECIES', binomial: name };
	const infra = INFRA.exec(name);
	if (infra) {
		const binomial = `${infra[1]} ${infra[2]}`;
		return { id, canonical: `${binomial} ${infra[3]}`, raw: name, rank: 'SUBSPECIES', binomial };
	}
	return null;
}

/** "15,4558" or 15.4558 → 15.4558; null when absent or unreadable. */
export function decimal(v: unknown): number | null {
	if (typeof v === 'number') return Number.isFinite(v) ? v : null;
	if (typeof v !== 'string' || v.trim() === '') return null;
	const n = Number(v.trim().replace(',', '.'));
	return Number.isFinite(n) ? n : null;
}

/** dd.mm.yyyy → YYYY-MM-DD, only for a real calendar date. */
export function isoDate(v: unknown): string | null {
	const m = typeof v === 'string' ? /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(v.trim()) : null;
	if (!m) return null;
	const iso = `${m[3]}-${m[2]}-${m[1]}`;
	const d = new Date(`${iso}T00:00:00Z`);
	return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === iso ? iso : null;
}

/** Names in the party: split on "|", spaces collapsed, empty and over-long names dropped, each once. */
export function observerNames(v: unknown): string[] {
	if (typeof v !== 'string') return [];
	const out: string[] = [];
	for (const part of v.split('|')) {
		const name = cleanText(part);
		if (name && name.length <= 200 && !out.includes(name)) out.push(name);
	}
	return out;
}

/**
 * The record's id, or null when it has none (a broken answer: the slice
 * can't be checked whole without ids).
 */
export function recordId(raw: unknown): string | null {
	const id = (raw as { Id?: unknown } | null)?.Id;
	return typeof id === 'string' && ID.test(id) ? id : null;
}

const RED_LIST_TYPE = 'Norsk Rødliste 2021';

/** The mainland Red List entry; the Svalbard list is a separate entry and is not this one. */
export function redList(v: unknown): { category: string; url: string | null } | null {
	if (!Array.isArray(v)) return null;
	for (const e of v) {
		const entry = e as { Type?: unknown; LinkTekst?: unknown; Url?: unknown } | null;
		if (!entry || entry.Type !== RED_LIST_TYPE || typeof entry.LinkTekst !== 'string' || !/^[A-Z]{2}$/.test(entry.LinkTekst)) continue;
		const url = typeof entry.Url === 'string' && /^https:\/\/\S+$/.test(entry.Url) && entry.Url.length <= 500 ? entry.Url : null;
		return { category: entry.LinkTekst, url };
	}
	return null;
}

/** "Activity: Forage. Validationstatus: Approved Documented" → its two parts. */
export function noteParts(notes: string | null): { activity: string | null; validation: string | null } {
	if (!notes) return { activity: null, validation: null };
	const activity = /(?:^|\s)Activity: ([^.]{1,100})\./.exec(notes)?.[1].trim() || null;
	const validation = /(?:^|\s)Validationstatus: ([^.]{1,100})(?:\.|$)/.exec(notes)?.[1].trim() || null;
	return { activity, validation };
}

export function behaviourList(v: unknown): string[] {
	if (!Array.isArray(v)) return [];
	const out: string[] = [];
	for (const b of v) {
		const word = typeof b === 'string' ? b.trim().toLowerCase() : '';
		if (/^[a-z][a-z0-9_ -]{0,39}$/.test(word) && !out.includes(word) && out.length < 10) out.push(word);
	}
	return out;
}

export function photoList(v: unknown): { url: string; by: string | null }[] | null {
	if (!Array.isArray(v)) return null;
	const out: { url: string; by: string | null }[] = [];
	for (const p of v) {
		const photo = p as { ImageUrl?: unknown; Collector?: unknown } | null;
		const url = typeof photo?.ImageUrl === 'string' ? photo.ImageUrl.trim() : '';
		if (!/^https:\/\/\S+$/.test(url) || url.length > 500 || out.length >= 20) continue;
		out.push({ url, by: cleanText(photo?.Collector)?.slice(0, 200) ?? null });
	}
	return out.length > 0 ? out : null;
}

/** "2026-01-26T13:08:14.6031146" → "2026-01-26T13:08:14.603114"; null when unreadable. */
export function modifiedAt(v: unknown): string | null {
	const m = typeof v === 'string' ? /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?$/.exec(v.trim()) : null;
	if (!m || !isoDate(m[1].slice(0, 10).split('-').reverse().join('.'))) return null;
	return m[1] + (m[2] ? m[2].slice(0, 7) : '');
}

function shortText(v: unknown, max: number): string | null {
	const t = cleanText(v);
	return t && t.length <= max ? t : null;
}

export function compactRecord(raw: unknown): CompactRecord | SkipReason {
	const r = raw as Record<string, unknown>;
	const id = recordId(raw)!;
	const date = isoDate(r.CollectedDate);
	if (!date) return 'undated';
	const name = cleanText(r.ScientificName);
	const taxonId = r.TaxonId === null || r.TaxonId === undefined ? null : String(r.TaxonId);
	const taxon = classifyName(taxonId, name);

	let lat = decimal(r.Latitude);
	let lon = decimal(r.Longitude);
	if (lat === null || lon === null || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
		lat = null;
		lon = null;
	}
	const precision = decimal(r.Precision);
	const uncertainty = precision !== null && precision >= 0 && precision <= 2_147_483_647 ? Math.round(precision) : null;
	const countText = typeof r.Count === 'number' ? String(r.Count) : typeof r.Count === 'string' ? r.Count.trim() : '';
	const count = /^\d{1,9}$/.test(countText) ? Number(countText) : null;
	const municipality = cleanText(r.Municipality);
	const catalog = typeof r.CatalogNumber === 'string' ? r.CatalogNumber.trim() : null;
	const notes = typeof r.Notes === 'string' ? (cleanText(r.Notes)?.slice(0, 500) ?? null) : null;
	const red = redList(r.PropertyUrls);
	const municipalityId = typeof r.MunicipalityId === 'number' || typeof r.MunicipalityId === 'string' ? String(r.MunicipalityId).trim() : '';

	return {
		id,
		date,
		month: Number(date.slice(5, 7)),
		taxon,
		otherName: taxon ? null : (name ?? '(no name)').slice(0, 200),
		municipality: municipality && municipality.length <= 100 ? municipality : null,
		locality: cleanText(r.Locality)?.slice(0, 300) ?? null,
		lat: lat === null ? null : Math.round(lat * 1e6) / 1e6,
		lon: lon === null ? null : Math.round(lon * 1e6) / 1e6,
		uncertainty,
		count,
		observers: observerNames(r.Collector),
		url: sightingUrl(catalog, typeof r.ObsUrl === 'string' ? r.ObsUrl : null),
		taxonId: taxonId && ID.test(taxonId) ? taxonId : null,
		localName: shortText(r.Name, 200),
		redList: red?.category ?? null,
		redListUrl: red?.url ?? null,
		municipalityId: /^\d{1,10}$/.test(municipalityId) ? municipalityId : null,
		behaviour: behaviourList(r.Behavior),
		...noteParts(notes),
		notes,
		sex: shortText(r.Sex, 50),
		photos: photoList(r.ThumbImgUrls),
		dataset: shortText(r.DatasetName, 200),
		modifiedAt: modifiedAt(r.TrackDateTime)
	};
}
