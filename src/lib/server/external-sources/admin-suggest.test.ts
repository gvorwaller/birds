/**
 * td-b856c7: the eBird species Admin → Sources offers for an unmatched
 * subspecies. Offered only, never applied without the owner.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/db', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
vi.mock('$server/species-match', () => ({ buildMatcher: vi.fn(), normalizeName: (s: string) => s }));

import { pickSuggestion, suggestionCandidates } from './admin';

const sp = (species_code: string, sci_name: string, com_name: string) => ({ species_code, sci_name, com_name });
const TAXONOMY = [
	sp('hoocro1', 'Corvus cornix', 'Hooded Crow'),
	sp('carcro1', 'Corvus corone', 'Carrion Crow'),
	sp('wilpta', 'Lagopus lagopus', 'Willow Ptarmigan'),
	sp('rocpig', 'Columba livia', 'Rock Pigeon'),
	sp('twin1', 'Twinus dupla', 'Twin A'),
	sp('twin2', 'Twinus dupla', 'Twin B')
];

describe('suggested species for an unmatched taxon', () => {
	it('tries the subspecies as its own species first, then its parent species', () => {
		expect(suggestionCandidates('Corvus corone cornix')).toEqual(['Corvus cornix', 'Corvus corone']);
		expect(suggestionCandidates('Lagopus lagopus lagopus')).toEqual(['Lagopus lagopus']);
		expect(suggestionCandidates(' Columba  livia domestica ')).toEqual(['Columba domestica', 'Columba livia']);
	});

	it('offers nothing for a binomial or a longer name', () => {
		expect(suggestionCandidates('Nonexistus fakeus')).toEqual([]);
		expect(suggestionCandidates('Laridae')).toEqual([]);
		expect(suggestionCandidates('A b c d')).toEqual([]);
	});

	it('picks the first candidate naming exactly one eBird species', () => {
		expect(pickSuggestion('Corvus corone cornix', TAXONOMY)).toEqual({ code: 'hoocro1', comName: 'Hooded Crow', sciName: 'Corvus cornix' });
		expect(pickSuggestion('Corvus corone corone', TAXONOMY)?.code).toBe('carcro1');
		expect(pickSuggestion('Columba livia domestica', TAXONOMY)?.code).toBe('rocpig');
	});

	it('never offers an ambiguous name, and offers nothing when no candidate exists', () => {
		expect(pickSuggestion('Twinus dupla minor', TAXONOMY)).toBeNull();
		expect(pickSuggestion('Nucifraga caryocatactes macrorhynchos', TAXONOMY)).toBeNull();
	});
});
