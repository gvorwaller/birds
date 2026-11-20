/**
 * The compact record every connector counts (td-99eebf; moved from
 * artsobs/records.ts). Each connector maps its source's records into this
 * shape; the shared aggregate never sees a source's own fields.
 */

export type TaxonRank = 'SPECIES' | 'SUBSPECIES';

export interface Taxon {
	/** The source's taxon id. */
	id: string;
	/** "Genus species" or "Genus species x". */
	canonical: string;
	/** The name as the source sent it, spaces collapsed. */
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
	/** The source's taxon id, also for a record that is not a species. */
	taxonId: string | null;
	/** The local-language name ("grågås", "sothöna"). */
	localName: string | null;
	/** The national Red List category and its page. */
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
	/** Last change at the source, local wall time with no zone, to microseconds. */
	modifiedAt: string | null;
}

/** Trimmed, inner spaces collapsed ("Astur gentilis " arrives with a trailing space). */
export function cleanText(v: unknown): string | null {
	if (typeof v !== 'string') return null;
	const s = v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
	return s.length > 0 ? s : null;
}
