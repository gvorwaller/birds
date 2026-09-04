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

	it('resets drillNote and selectedRegionCode inside the drill effect, keyed on ' +
		'the drill identity — before deciding cached vs. fetch (CC1 P2-3)', () => {
		const effectStart = markup.indexOf('const species = speciesCode;');
		expect(effectStart).toBeGreaterThan(-1);
		const beginAt = markup.indexOf('beginDrill(', effectStart);
		expect(beginAt).toBeGreaterThan(effectStart);
		const body = markup.slice(effectStart, beginAt);
		expect(body).toContain("drillNote = '';");
		expect(body).toContain('selectedRegionCode = null;');
		// Both resets must precede the cache/fetch decision, not follow it.
		expect(body.indexOf("drillNote = '';")).toBeLessThan(body.indexOf('const key ='));
		expect(body.indexOf('selectedRegionCode = null;')).toBeLessThan(body.indexOf('const key ='));
	});

	// GROK P3-2: the unmapped-countries warning (CODEX1 P2-10) is markup-only
	// — there's no pure function to pin, since it's a plain conditional block
	// reading `grid.meta.unmappedCountries` directly.
	it('shows an inline warning naming unmapped countries when meta.unmappedCountries is non-empty', () => {
		expect(markup).toContain('{#if grid.meta.unmappedCountries.length > 0}');
		expect(markup).toContain('Data omitted for');
		expect(markup).toContain('not yet assigned to a');
		expect(markup).toContain('{grid.meta.unmappedCountries.join(');
	});

	// CODEX1 P2-2: the tap hint must not describe whole-cell picking on a
	// phone, where a tap only ever picks a band (P1-1) — the month comes
	// from the slider. Two variants, both driven by the same `phone` flag.
	it('the tap hint has a phone variant (band + slider) and a non-phone variant (whole cell), ' +
		'in the correct branch of the SAME {#if phone} block — not merely both present somewhere', () => {
		const ifAt = markup.indexOf('{#if phone}');
		expect(ifAt).toBeGreaterThan(-1);
		const elseAt = markup.indexOf('{:else}', ifAt);
		expect(elseAt).toBeGreaterThan(ifAt);
		const endAt = markup.indexOf('{/if}', elseAt);
		expect(endAt).toBeGreaterThan(elseAt);
		const phoneBranch = markup.slice(ifAt, elseAt);
		const nonPhoneBranch = markup.slice(elseAt, endAt);
		expect(phoneBranch).toContain(
			"Choose a month with the slider, then tap a latitude row to see its reporting rate and the"
		);
		expect(phoneBranch).not.toContain("Tap a square");
		expect(nonPhoneBranch).toContain(
			"Tap a square to see that month's reporting rate and the regions behind it; darker green means"
		);
		expect(nonPhoneBranch).not.toContain('Choose a month with the slider');
	});

	// Extracts the body of the FIRST `selector { ... }` rule found at or
	// after `from` in `text` (simple one-level rules only — no nested
	// braces to balance, which is all this file's CSS ever has).
	function ruleBodyAfter(text: string, selector: string, from: number): string {
		const at = text.indexOf(selector, from);
		expect(at, `selector "${selector}" not found after offset ${from}`).toBeGreaterThan(-1);
		const braceStart = text.indexOf('{', at);
		const braceEnd = text.indexOf('}', braceStart);
		return text.slice(braceStart + 1, braceEnd);
	}

	// CC1 P2 (Safari drive of bbc9426, 390x731): 18 bands at the phone's
	// 48px touch row make the World chart 884px tall, so the readout — in
	// normal flow below the chart — sat far below the viewport after a tap.
	// Pin it to the bottom of the viewport, above the bottom nav, inside the
	// phone breakpoint specifically; the desktop sticky-top rule is separate
	// and must stay untouched.
	it('pins the readout to the bottom of the viewport, ABOVE THE BOTTOM NAV, in the phone ' +
		'breakpoint (CODEX1 re-check: --nav-h is the TOP nav, --bottomnav-h is the fixed ' +
		'phone nav that would otherwise sit on top of it)', () => {
		const phoneStart = markup.indexOf('@media (max-width: 639px)');
		const desktopStart = markup.indexOf('@media (min-width: 1024px)');
		expect(phoneStart).toBeGreaterThan(-1);
		expect(desktopStart).toBeGreaterThan(phoneStart);

		const stickyRuleAt = markup.indexOf('.rlayout > .readout', phoneStart);
		const stickyBraceStart = markup.indexOf('{', stickyRuleAt);
		const stickyBraceEnd = markup.indexOf('}', stickyBraceStart);
		const phoneReadout = markup.slice(stickyBraceStart + 1, stickyBraceEnd);
		expect(phoneReadout).toContain('position: sticky');
		expect(phoneReadout).toContain(
			'bottom: calc(var(--bottomnav-h) + env(safe-area-inset-bottom, 0px));'
		);
		expect(phoneReadout).toContain('z-index: 2;');
		expect(phoneReadout).toContain('background: var(--card);');

		// No OTHER `.readout`-touching rule inside the phone block sets its
		// own `bottom:` — the plain `.readout { font-size/line-height }`
		// tweak later in the same block must stay untouched. Search from
		// right after the sticky rule just parsed, not an unrelated brace.
		const otherReadoutRule = ruleBodyAfter(markup, '.readout {', stickyBraceEnd + 1);
		expect(otherReadoutRule).not.toContain('bottom:');
		expect(markup.indexOf('.readout {', stickyBraceEnd + 1)).toBeLessThan(desktopStart);

		// The base (non-media) `.readout` rule, above every breakpoint, must
		// never itself set `bottom:` either — only the phone override does.
		const baseReadout = ruleBodyAfter(markup, '.readout {', 0);
		expect(baseReadout).not.toContain('bottom:');

		// Desktop's sticky-TOP rule is a SEPARATE, untouched mechanism.
		const desktopReadout = ruleBodyAfter(markup, '.rlayout > .readout', desktopStart);
		expect(desktopReadout).toContain('position: sticky');
		expect(desktopReadout).toContain('top: calc(var(--nav-h) + 12px);');
		expect(desktopReadout).not.toContain('bottom:');
	});
});
