/**
 * Controlled tag vocabulary for species enrichment (plan Phase 2, v1 with
 * GROK's field-review additions; `pelagic` deliberately lives under habitat,
 * not movement). Client-safe — used by chips, the Field guide, and the
 * server-side validator. Control is enforced HERE in code: model output
 * outside the vocabulary is dropped, never trusted (CODEX1 plan review).
 *
 * Flat `dimension:value` tags so one TEXT[] + GIN serves both search
 * (tags @> ARRAY[...]) and chip grouping. NO seasonality dimension —
 * species_frequency curves answer that better regionally.
 */

export const TAG_VOCABULARY = {
	habitat: [
		'forest',
		'woodland-edge',
		'grassland',
		'shrubland',
		'desert',
		'freshwater-marsh',
		'saltmarsh',
		'mangrove',
		'mudflat',
		'beach',
		'rocky-shore',
		'jetty-pier',
		'open-ocean',
		'lake-pond',
		'river-stream',
		'riparian',
		'conifer',
		'urban-suburban',
		'farmland',
		'alpine-tundra'
	],
	forage: [
		'aerial-insectivore',
		'sallying-flycatcher',
		'foliage-gleaner',
		'ground-forager',
		'bark-forager',
		'stalking-wader',
		'probing-shorebird',
		'dabbler',
		'diver',
		'plunge-diver',
		'hunter',
		'scavenger',
		'nectar',
		'seeds-fruit'
	],
	/** Coastal/tidal species only — the td-47d6d5 payload. */
	tide: ['falling', 'low', 'rising', 'mid-tide', 'high-roost', 'tide-independent'],
	time: ['dawn-peak', 'dusk-peak', 'diurnal', 'crepuscular', 'nocturnal'],
	movement: [
		'resident',
		'short-distance-migrant',
		'long-distance-migrant',
		'altitudinal',
		'irruptive'
	],
	find: [
		'conspicuous',
		'secretive',
		'heard-more-than-seen',
		'flocking',
		'solitary',
		'feeder-visitor',
		'canopy',
		'overhead-flight'
	]
} as const;

export type TagDimension = keyof typeof TAG_VOCABULARY;

export const TAG_DIMENSIONS = Object.keys(TAG_VOCABULARY) as TagDimension[];

export const MAX_TAGS = 12;

/** Full flat set: 'habitat:mudflat', 'tide:falling', … */
export const ALL_TAGS: ReadonlySet<string> = new Set(
	TAG_DIMENSIONS.flatMap((d) => TAG_VOCABULARY[d].map((v) => `${d}:${v}`))
);

/**
 * Enforce vocabulary membership in code — anything unknown is dropped and
 * reported so vocabulary gaps surface in job events instead of bad chips.
 */
export function validateTags(raw: unknown): { tags: string[]; dropped: string[] } {
	if (!Array.isArray(raw)) return { tags: [], dropped: [] };
	const tags: string[] = [];
	const dropped: string[] = [];
	for (const t of raw) {
		if (typeof t !== 'string') continue;
		const norm = t.trim().toLowerCase();
		if (ALL_TAGS.has(norm)) {
			if (!tags.includes(norm)) tags.push(norm);
		} else if (norm) {
			dropped.push(norm.slice(0, 40));
		}
	}
	return { tags: tags.slice(0, MAX_TAGS), dropped };
}

export interface TagGroup {
	dimension: TagDimension;
	values: string[];
}

/** Group flat tags by dimension in vocabulary order (chip rendering). */
export function groupTags(tags: readonly string[]): TagGroup[] {
	const groups: TagGroup[] = [];
	for (const d of TAG_DIMENSIONS) {
		const values = tags
			.filter((t) => t.startsWith(`${d}:`))
			.map((t) => t.slice(d.length + 1))
			.filter((v) => (TAG_VOCABULARY[d] as readonly string[]).includes(v));
		if (values.length > 0) groups.push({ dimension: d, values });
	}
	return groups;
}

const DIMENSION_LABELS: Record<TagDimension, string> = {
	habitat: 'Habitat',
	forage: 'Foraging',
	tide: 'Tide',
	time: 'Time of day',
	movement: 'Movement',
	find: 'Finding'
};

export function dimensionLabel(d: TagDimension): string {
	return DIMENSION_LABELS[d];
}

/** 'woodland-edge' → 'woodland edge'; tide values get the explicit prefix. */
export function tagLabel(dimension: TagDimension, value: string): string {
	const text = value.replace(/-/g, ' ');
	return dimension === 'tide' && value !== 'tide-independent' ? `Tide: ${text}` : text;
}
