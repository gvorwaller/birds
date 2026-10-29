import { describe, expect, it } from 'vitest';
import { findTaxa, foldText } from './taxon-find';

type Row = { local: string | null; sci: string; com: string | null; code: string };
const ROWS: Row[] = [
	{ local: 'kråke', sci: 'Corvus corone', com: 'Carrion Crow', code: 'carcro1' },
	{ local: 'svartkråke', sci: 'Corvus corone corone', com: 'Carrion Crow', code: 'carcro1' },
	{ local: 'gråkråke', sci: 'Corvus corone cornix', com: 'Hooded Crow', code: 'hoocro1' },
	{ local: 'ravn', sci: 'Corvus corax', com: 'Common Raven', code: 'comrav' },
	{ local: 'lirype', sci: 'Lagopus lagopus', com: 'Willow Ptarmigan', code: 'wilpta' },
	{ local: 'sjøorre', sci: 'Melanitta fusca', com: 'Velvet Scoter', code: 'velsco1' },
	{ local: 'ærfugl', sci: 'Somateria mollissima', com: 'Common Eider', code: 'comeid' },
	{ local: null, sci: 'Acanthis flammea', com: 'Redpoll', code: 'redpol1' }
];
const names = (r: Row) => [r.local, r.sci, r.com, r.code];
const find = (q: string) => {
	const r = findTaxa(ROWS, q, names);
	return { mode: r.mode, shown: ROWS.filter((x) => r.shown.has(x)).map((x) => x.local ?? x.sci) };
};

describe('Find a taxon (td-e5b164)', () => {
	it('shows every row when nothing is typed', () => {
		expect(find('  ')).toEqual({ mode: 'all', shown: ROWS.map((x) => x.local ?? x.sci) });
	});

	it('finds names containing the text, any case', () => {
		expect(find('Kråke')).toEqual({ mode: 'contains', shown: ['kråke', 'svartkråke', 'gråkråke'] });
		expect(find('hooded')).toEqual({ mode: 'contains', shown: ['gråkråke'] });
		expect(find('CORAX')).toEqual({ mode: 'contains', shown: ['ravn'] });
	});

	it('ignores accents and spells ø and æ as typed without them', () => {
		expect(foldText('Sjøorre Ærfugl Kråke')).toBe('sjoorre aerfugl krake');
		expect(find('krake')).toEqual({ mode: 'contains', shown: ['kråke', 'svartkråke', 'gråkråke'] });
		expect(find('sjoorre')).toEqual({ mode: 'contains', shown: ['sjøorre'] });
		expect(find('aerfugl')).toEqual({ mode: 'contains', shown: ['ærfugl'] });
	});

	it('offers words starting like the text when nothing contains it (Kråka → kråke)', () => {
		expect(find('Kråka')).toEqual({ mode: 'close', shown: ['kråke'] });
		expect(find('Lirypa')).toEqual({ mode: 'close', shown: ['lirype'] });
		expect(find('Redpoli')).toEqual({ mode: 'close', shown: ['Acanthis flammea'] });
	});

	it('finds nothing rather than guessing from too short a start', () => {
		expect(find('kx')).toEqual({ mode: 'none', shown: [] });
		expect(find('krx')).toEqual({ mode: 'none', shown: [] });
		expect(find('zebra')).toEqual({ mode: 'none', shown: [] });
	});
});
