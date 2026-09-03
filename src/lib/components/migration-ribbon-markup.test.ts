/**
 * Static markup assertions for MigrationRibbon.svelte (td-59c2d0 build spec,
 * TD-C). This repo has no component-render harness, so ARIA/structure
 * contracts are pinned by reading the source file directly (bottom-nav-ios,
 * about-route.test.ts precedent) rather than mounting the component.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const markup = readFileSync(resolve('src/lib/components/MigrationRibbon.svelte'), 'utf8');

describe('MigrationRibbon.svelte markup', () => {
	it('the ribbon is a labeled, described custom widget', () => {
		expect(markup).toContain('role="group"');
		expect(markup).toContain('aria-roledescription="migration ribbon"');
		expect(markup).toContain('aria-labelledby="ribh"');
	});

	it('has a live announcement region for user-initiated selection changes', () => {
		expect(markup).toContain('aria-live="polite"');
	});

	it('the chart SVG carries a computed aria-label', () => {
		expect(markup).toMatch(/<svg[^>]*\baria-label=\{/);
	});

	it('the drill panel is a native, collapsible <details>', () => {
		expect(markup).toContain('<details');
		expect(markup).toContain('drilld');
	});

	it('attributes eBird by name and link', () => {
		expect(markup).toContain('Data from <a href="https://ebird.org">eBird.org</a>');
	});

	it('hides Play and samples the reduced-motion query', () => {
		expect(markup).toContain('prefers-reduced-motion');
	});

	it('follows the 1024px breakpoint for World vs. By continent (CODEX1 P2-5)', () => {
		expect(markup).toContain('(min-width: 1024px)');
	});

	it('never imports server code', () => {
		expect(markup).not.toContain('$server');
	});

	it('never reintroduces the un-fixed mockup accent literal (CODEX1: use --accent/--rb-5)', () => {
		expect(markup).not.toContain('#0a5c43');
	});

	it('never reintroduces the mockup coverage-preview feature (out of scope)', () => {
		expect(markup.toLowerCase()).not.toContain('preview');
	});

	it('never restricts native touch/scroll behavior (cs.md + CODEX1 P1-7)', () => {
		expect(markup).not.toContain('touch-action');
	});

	it('never reintroduces the rejected 720px breakpoint (cs.md: 640/1024 only)', () => {
		expect(markup).not.toContain('720px');
	});

	it('uses only the two cs.md breakpoints (640/1024)', () => {
		const mediaQueries = [...markup.matchAll(/@media\s*\(([^)]+)\)/g)].map((m) => m[1]);
		expect(mediaQueries.length).toBeGreaterThan(0);
		for (const q of mediaQueries) {
			expect(q === 'max-width: 639px' || q === 'min-width: 640px' || q === 'min-width: 1024px').toBe(
				true
			);
		}
	});

	it('every tap target class declares a >=48px minimum height', () => {
		expect(markup).toMatch(/\.btn\s*\{[^}]*min-height:\s*48px/);
		expect(markup).toMatch(/\.seg button\s*\{[^}]*min-height:\s*48px/);
		expect(markup).toMatch(/\.drow\s*\{[^}]*min-height:\s*48px/);
	});

	it('colour tokens are declared, and --rb-5 IS --accent (build spec)', () => {
		expect(markup).toContain('--rb-0: #eceff1');
		expect(markup).toContain('--rb-5: var(--accent)');
	});

	it('Play runs on a 750ms interval with $effect cleanup (NavProgress pattern)', () => {
		expect(markup).toContain('PLAY_MS');
		expect(markup).toMatch(/setInterval\([\s\S]*?PLAY_MS\)/);
		expect(markup).toMatch(/return \(\) => clearInterval\(/);
	});

	it('pointer selection uses no pointer capture and a movement threshold', () => {
		expect(markup).not.toContain('setPointerCapture');
		expect(markup).toContain('moved >= 8');
	});

	it('every svelte-ignore is justified by a comment immediately above it (CC1 P2-2)', () => {
		const ignoreLines = markup
			.split('\n')
			.map((line, i) => ({ line, i }))
			.filter(({ line }) => line.includes('<!-- svelte-ignore'));
		expect(ignoreLines.length).toBeGreaterThan(0);
		const lines = markup.split('\n');
		for (const { i } of ignoreLines) {
			// The line directly above a svelte-ignore comment must itself close a
			// (justification) HTML comment — never blank, never the element itself.
			const above = lines[i - 1]?.trim() ?? '';
			expect(above.endsWith('-->')).toBe(true);
			expect(above).not.toBe('-->'); // the comment must carry actual prose, not stand alone
		}
	});
});
