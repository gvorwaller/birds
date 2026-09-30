/**
 * td-894144 (plan rev 14, CODEX1 P2): a semantic change to the engine must
 * ship with a new scanner_rev. This recomputes SHA-256 over the engine's
 * semantic sources and fails if segment.ts's ENGINE_SOURCE_HASH is stale —
 * update the constant to the value printed here. A new scanner_rev changes
 * every input_hash, so the consistency job re-materializes everything.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ENGINE_SOURCE_HASH, scannerRev } from './segment';

const FILES = ['normalize.ts', 'tokens.ts', 'segment.ts', 'rules.ts', 'scanner.ts'];

/** Source with comments, blank lines and the constant's own line removed. */
export function semanticSource(src: string): string {
	return src
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.split('\n')
		.map((l) => l.replace(/^\s*\/\/.*$/, '').trim())
		.filter((l) => l !== '' && !l.startsWith('export const ENGINE_SOURCE_HASH'))
		.join('\n');
}

export function engineSourceHash(): string {
	const h = createHash('sha256');
	for (const f of FILES) {
		h.update(f + '\n');
		h.update(semanticSource(readFileSync(new URL(`./${f}`, import.meta.url), 'utf8')));
		h.update('\n');
	}
	return h.digest('hex');
}

describe('engine source guard', () => {
	it('ENGINE_SOURCE_HASH matches the semantic sources (bump it on any engine change)', () => {
		const actual = engineSourceHash();
		expect(ENGINE_SOURCE_HASH, `set ENGINE_SOURCE_HASH = '${actual}' in segment.ts`).toBe(actual);
	});
	it('comment-only edits do not change the hash; code edits do', () => {
		// Whole-line and block comments are ignored (trailing // is kept on
		// purpose: stripping it would corrupt strings containing "//").
		expect(semanticSource('/* block */\n// line\nconst a = 1;\n\n')).toBe(semanticSource('const a = 1;'));
		expect(semanticSource('const a = 1;')).not.toBe(semanticSource('const a = 2;'));
	});
	it('scanner_rev carries the engine hash and runtime versions', () => {
		expect(scannerRev()).toMatch(new RegExp(`^engine-1\\+${ENGINE_SOURCE_HASH.slice(0, 12)}\\|node-.*\\|icu-.*\\|unicode-`));
	});
});
