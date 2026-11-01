/**
 * External taxa → eBird species (td-493c58): the former-name fallback of
 * resolveMatches, pure. Today's taxonomy, the overrides and the backups'
 * rows are given; nothing is read.
 */
import { describe, expect, it } from 'vitest';
import { resolveMatches, taxonKey, type MatchTaxon } from './taxa';

const sp = (species_code: string, sci_name: string): MatchTaxon => ({ species_code, sci_name, category: 'species', report_as: null });
const issf = (species_code: string, sci_name: string, report_as: string): MatchTaxon => ({
	species_code,
	sci_name,
	category: 'issf',
	report_as
});
const slash = (species_code: string, sci_name: string): MatchTaxon => ({ species_code, sci_name, category: 'slash', report_as: null });

// eBird 2026, as it reached prod on 2026-10-31 (codes and names from run 1).
const TODAY: MatchTaxon[] = [
	sp('reebun', 'Schoeniclus schoeniclus'),
	sp('winwre4', 'Nannus troglodytes'),
	sp('spofly2', 'Muscicapa striata'),
	sp('spofly3', 'Muscicapa tyrrhenica'),
	slash('spofly1', 'Muscicapa striata/tyrrhenica'),
	sp('y00960', 'Apus affinis'),
	issf('houswi1', 'Apus affinis [nipalensis Group]', 'y00960'),
	sp('eurrob1', 'Erithacus rubecula')
];
// eBird 2025 (the before-sync backup).
const BEFORE: MatchTaxon[] = [
	sp('reebun', 'Emberiza schoeniclus'),
	sp('winwre4', 'Troglodytes troglodytes'),
	sp('spofly1', 'Muscicapa striata'),
	issf('spofly9', 'Muscicapa striata tyrrhenica', 'spofly1'),
	sp('houswi1', 'Apus nipalensis'),
	sp('litswi1', 'Apus affinis'),
	sp('eurrob1', 'Erithacus rubecula')
];

function match(name: string, opts: { former?: MatchTaxon[]; current?: MatchTaxon[]; overrides?: Map<string, string> } = {}) {
	const taxa = [{ upstreamTaxonId: '1', canonicalName: name }];
	return resolveMatches(taxa, opts.current ?? TODAY, opts.overrides ?? new Map(), opts.former ?? BEFORE).get(taxonKey('1', name));
}

describe('resolveMatches: former eBird names (td-493c58)', () => {
	it("keeps a genus move on its species through eBird's former name", () => {
		expect(match('Emberiza schoeniclus')).toEqual({ code: 'reebun', method: 'former_name' });
		expect(match('Troglodytes troglodytes')).toEqual({ code: 'winwre4', method: 'former_name' });
	});

	it("prefers today's name: a split's name goes to the species that has it now, not the old code", () => {
		// Muscicapa striata was spofly1 (now the Spotted/Mediterranean slash); today it is spofly2.
		expect(match('Muscicapa striata')).toEqual({ code: 'spofly2', method: 'scientific' });
	});

	it('follows a lump: an old species that is now a group of another species', () => {
		// House Swift (houswi1, Apus nipalensis) is now an issf of Little Swift (y00960).
		expect(match('Apus nipalensis')).toEqual({ code: 'y00960', method: 'former_name' });
	});

	it('leaves unmatched a former name whose species is now a slash or was removed', () => {
		const former = [sp('oldsp1', 'Oldus nomen'), sp('gone1', 'Gonus away')];
		const current = [...TODAY, slash('oldsp1', 'Oldus nomen/alter')];
		expect(match('Oldus nomen', { former, current })).toEqual({ code: null, reason: 'no_match' });
		expect(match('Gonus away', { former, current })).toEqual({ code: null, reason: 'no_match' });
	});

	it('follows a former issf to the species it was then reported as', () => {
		// Its old parent spofly1 is a slash today: no single answer.
		expect(match('Muscicapa striata tyrrhenica')).toEqual({ code: null, reason: 'no_match' });
		const former = [issf('robsub', 'Erithacus rubecula melophilus', 'eurrob1')];
		expect(match('Erithacus rubecula melophilus', { former })).toEqual({ code: 'eurrob1', method: 'former_name' });
	});

	it('fails closed when the name was reused across backups for different species', () => {
		// V1: N was A; V2: N was B; today A and B are both species under other names.
		const current = [...TODAY, sp('aaa1', 'Alpha now'), sp('bbb1', 'Beta now')];
		const former = [sp('aaa1', 'Nomen reusum'), sp('bbb1', 'Nomen reusum')];
		expect(match('Nomen reusum', { former, current })).toEqual({ code: null, reason: 'ambiguous' });
	});

	it('matches when several backups converge on one species today', () => {
		const current = [...TODAY, sp('ccc1', 'Gamma now'), issf('ccc2', 'Gamma now minor', 'ccc1')];
		// 2024: its own species ccc2; 2025: already species ccc1. ccc2 is a group of ccc1 today.
		const former = [sp('ccc2', 'Gamma olim'), sp('ccc1', 'Gamma olim')];
		expect(match('Gamma olim', { former, current })).toEqual({ code: 'ccc1', method: 'former_name' });
	});

	it('fails closed when one backup resolves and another does not', () => {
		const current = [...TODAY, sp('ddd1', 'Delta now'), slash('ddd2', 'Delta/Epsilon')];
		const former = [sp('ddd1', 'Delta olim'), sp('ddd2', 'Delta olim')];
		expect(match('Delta olim', { former, current })).toEqual({ code: null, reason: 'ambiguous' });
	});

	it('counts a former slash with the name as unresolved evidence', () => {
		const current = [...TODAY, sp('eee1', 'Epsilon now')];
		const former = [sp('eee1', 'Epsilon olim'), slash('eee9', 'Epsilon olim')];
		expect(match('Epsilon olim', { former, current })).toEqual({ code: null, reason: 'ambiguous' });
	});

	it('never uses a former name to break an ambiguity among current names', () => {
		const current = [...TODAY, sp('fff1', 'Phi dup'), sp('fff2', 'Phi dup')];
		const former = [sp('fff1', 'Phi dup')];
		expect(match('Phi dup', { former, current })).toEqual({ code: null, reason: 'ambiguous' });
	});

	it('keeps an override first, and its missing-code reason', () => {
		const overrides = new Map([['1', 'spofly2']]);
		expect(match('Emberiza schoeniclus', { overrides })).toEqual({ code: 'spofly2', method: 'override' });
		expect(match('Emberiza schoeniclus', { overrides: new Map([['1', 'spofly1']]) })).toEqual({
			code: null,
			reason: 'override_code_missing'
		});
	});

	it('normalizes names the same way as today (case, punctuation)', () => {
		expect(match('emberiza  SCHOENICLUS')).toEqual({ code: 'reebun', method: 'former_name' });
	});

	it('is unchanged without backups: no former name, no match', () => {
		expect(match('Emberiza schoeniclus', { former: [] })).toEqual({ code: null, reason: 'no_match' });
		expect(match('Apus affinis [nipalensis Group]', { former: [] })).toEqual({ code: 'y00960', method: 'subspecies' });
	});
});
