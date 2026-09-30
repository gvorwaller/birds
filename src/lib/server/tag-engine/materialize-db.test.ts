/**
 * td-894144 Release B (B2b/B2c) — entry points, input maintenance, universe
 * membership, focal-exemption identity, and lock serialization. Owned
 * fixtures only (zztm… species with their own taxonomy rows). Nothing here
 * owns a tag outside a rolled-back transaction, so real tags are never touched.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { query } from '$lib/db';
import { markWikiError, markWikiNoArticle, upsertWikiOk } from '../species-enrichment';
import { withOwnerClient } from '../tag-fixtures.test-helper';
import { __resetTagEngineCachesForTests, materializeMany } from './materialize';
import { withTagWriteTx } from './runtime';

const dbUp = await query('SELECT 1').then(() => true).catch(() => false);
const migrated = dbUp
	? await query(`SELECT to_regclass('public.species_tag_input') IS NOT NULL AS ok`).then((r) => r.rows[0].ok === true)
	: false;

const RUN = String(process.pid % 100000).padStart(5, '0');
const A = `zztm${RUN}a`;
const B = `zztm${RUN}b`;
const N = `zztm${RUN}n`; // never in taxonomy → never a member
const ALL = [A, B, N];
const art = (rev: number, extract: string) => ({ title: `Fixture ${RUN}`, revId: rev, extract, sections: [] });

async function cleanup() {
	await query('DELETE FROM species_enrichment WHERE species_code = ANY($1)', [ALL]);
	await query('DELETE FROM taxonomy_cache WHERE species_code = ANY($1)', [ALL]);
	await withOwnerClient((c) => c.query('DELETE FROM tag_materialization_failure WHERE key LIKE $1', [`%zztm${RUN}%`]));
}

async function taxon(code: string, com: string, sci: string) {
	await query(
		`INSERT INTO taxonomy_cache (species_code, com_name, sci_name, category, family, order_name, family_sci_name)
		 VALUES ($1, $2, $3, 'species', 'Fixture family', 'Procellariiformes', 'Fixturidae')
		 ON CONFLICT (species_code) DO UPDATE SET com_name = $2, sci_name = $3`,
		[code, com, sci]
	);
}

const input = async (code: string) =>
	(await query<{ input_hash: string; focal_exempt_hash: string; lexicon_hash: string }>(
		'SELECT input_hash, focal_exempt_hash, lexicon_hash FROM species_tag_input WHERE species_code = $1',
		[code]
	)).rows[0] ?? null;

describe.runIf(migrated)('entry points maintain the input pointer (universe = stored article + species)', () => {
	beforeAll(async () => {
		await cleanup();
		__resetTagEngineCachesForTests();
		await taxon(A, `Zztm Petrel ${RUN}`, `Zztmia alpha${RUN}`);
	});
	afterAll(cleanup);

	it('a member gets an input; re-saving identical text keeps the hash; new text changes it', async () => {
		await upsertWikiOk(A, art(1, 'A pelagic fixture petrel.'));
		const first = await input(A);
		expect(first?.input_hash).toMatch(/^[0-9a-f]{64}$/);
		await upsertWikiOk(A, art(2, 'A pelagic fixture petrel.'));
		expect((await input(A))?.input_hash).toBe(first!.input_hash);
		await upsertWikiOk(A, art(3, 'A coastal fixture petrel.'));
		expect((await input(A))?.input_hash).not.toBe(first!.input_hash);
	});

	it('markWikiError keeps the last-good article AND membership; no-article removes it', async () => {
		const before = await input(A);
		await markWikiError(A, 'transient');
		expect((await input(A))?.input_hash).toBe(before!.input_hash);
		await markWikiNoArticle(A);
		expect(await input(A)).toBeNull();
	});

	it('a species with an article but no species taxonomy row is not a member', async () => {
		await upsertWikiOk(N, art(1, 'A pelagic mystery bird.'));
		expect(await input(N)).toBeNull();
	});

	it('a successful entry point clears its failure key', async () => {
		await upsertWikiOk(A, art(4, 'Back again.'));
		const f = (await query<{ cleared: boolean }>(
			'SELECT cleared_at IS NOT NULL AS cleared FROM tag_materialization_failure WHERE key = $1',
			[A]
		)).rows[0];
		expect(f?.cleared).toBe(true);
	});
});

describe.runIf(migrated)('focal-exemption identity (name swap with an unchanged global key set)', () => {
	beforeAll(async () => {
		await cleanup();
		__resetTagEngineCachesForTests();
		await taxon(A, `Zztm Alpha ${RUN}`, `Zztmia alpha${RUN}`);
		await taxon(B, `Zztm Beta ${RUN}`, `Zztmib beta${RUN}`);
		await upsertWikiOk(A, art(1, 'A pelagic fixture.'));
		await upsertWikiOk(B, art(1, 'A pelagic fixture.'));
	});
	afterAll(cleanup);

	it('swapping two species\' common names keeps the lexicon hash but changes each input_hash', async () => {
		const a0 = await input(A);
		const b0 = await input(B);
		await withTagWriteTx('exclusive', `global:test-swap-zztm${RUN}`, 'test', async (tx) => {
			await tx.exec(`UPDATE taxonomy_cache SET com_name = CASE species_code WHEN $1 THEN $3 ELSE $4 END WHERE species_code IN ($1, $2)`, [
				A,
				B,
				`Zztm Beta ${RUN}`,
				`Zztm Alpha ${RUN}`
			]);
			await materializeMany(tx, [A, B], { rebuildLexicon: true });
		});
		const a1 = await input(A);
		const b1 = await input(B);
		expect(a1!.lexicon_hash).toBe(a0!.lexicon_hash); // same global name set
		expect(a1!.focal_exempt_hash).not.toBe(a0!.focal_exempt_hash);
		expect(a1!.input_hash).not.toBe(a0!.input_hash);
		expect(b1!.input_hash).not.toBe(b0!.input_hash);
	});
});

describe.runIf(migrated)('lock serialization (two sessions)', () => {
	beforeAll(async () => {
		await cleanup();
		__resetTagEngineCachesForTests();
		await taxon(A, `Zztm Petrel ${RUN}`, `Zztmia alpha${RUN}`);
		await upsertWikiOk(A, art(1, 'A pelagic fixture.'));
	});
	afterAll(cleanup);

	it('a wiki write waits for an exclusive taxonomy transaction and then derives from the NEW taxonomy', async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		let exclusiveHeld!: () => void;
		const held = new Promise<void>((r) => (exclusiveHeld = r));
		const exclusive = withTagWriteTx('exclusive', `global:test-race-zztm${RUN}`, 'test', async (tx) => {
			await tx.exec('UPDATE taxonomy_cache SET order_name = $2 WHERE species_code = $1', [A, 'Sphenisciformes']);
			exclusiveHeld();
			await gate; // "paused after writing the candidate taxonomy"
			await materializeMany(tx, [A]);
		});
		await held;
		let wikiDone = false;
		const wiki = upsertWikiOk(A, art(2, 'A pelagic fixture, rewritten.')).then(() => (wikiDone = true));
		await new Promise((r) => setTimeout(r, 400));
		expect(wikiDone).toBe(false); // blocked on the shared lock
		release();
		await exclusive;
		await wiki;
		const i = (await query<{ order_name: string }>('SELECT order_name FROM species_tag_input WHERE species_code = $1', [A]))
			.rows[0];
		expect(i.order_name).toBe('Sphenisciformes'); // never an old-taxonomy input after the replacement
	});

	it('different species run concurrently under the shared lock', async () => {
		await taxon(B, `Zztm Beta ${RUN}`, `Zztmib beta${RUN}`);
		const t0 = Date.now();
		await Promise.all([upsertWikiOk(A, art(5, 'x one.')), upsertWikiOk(B, art(5, 'x two.'))]);
		expect(Date.now() - t0).toBeLessThan(10_000);
		expect(await input(B)).not.toBeNull();
	});

	it('a shared acquirer times out (lock_timeout) instead of hanging, and records via the PRE token', async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		let held!: () => void;
		const isHeld = new Promise<void>((r) => (held = r));
		const blocker = withTagWriteTx('exclusive', `global:test-block-zztm${RUN}`, 'test', async () => {
			held();
			await gate;
		});
		await isHeld;
		const t0 = Date.now();
		await expect(upsertWikiOk(A, art(9, 'blocked.'))).rejects.toThrow(/lock timeout/i);
		expect(Date.now() - t0).toBeGreaterThanOrEqual(9_000);
		release();
		await blocker;
		const f = (await query<{ cleared: boolean; last_attempt_no: string }>(
			'SELECT cleared_at IS NOT NULL AS cleared, last_attempt_no FROM tag_materialization_failure WHERE key = $1',
			[A]
		)).rows[0];
		expect(f.cleared).toBe(false);
	}, 30_000);

	const K = () => `zztm${RUN}-key`;
	const failRow = async () =>
		(await query<{ cleared: boolean }>(
			'SELECT cleared_at IS NOT NULL AS cleared FROM tag_materialization_failure WHERE key = $1',
			[K()]
		)).rows[0];
	function deferred() {
		let resolve!: () => void;
		const p = new Promise<void>((r) => (resolve = r));
		return { p, resolve };
	}

	it('same key, shared writers: A succeeds then B fails → B\'s failure stays uncleared', async () => {
		const aIn = deferred();
		const aGo = deferred();
		const a = withTagWriteTx('shared', K(), 'test', async () => {
			aIn.resolve();
			await aGo.p;
		});
		await aIn.p;
		const b = withTagWriteTx('shared', K(), 'test', async () => {
			throw new Error('B fails');
		});
		await new Promise((r) => setTimeout(r, 200)); // B is queued on the key lock
		aGo.resolve();
		await a;
		await expect(b).rejects.toThrow('B fails');
		expect((await failRow()).cleared).toBe(false);
	});

	it('same key, shared writers: A fails then B succeeds → cleared', async () => {
		const aIn = deferred();
		const aGo = deferred();
		const a = withTagWriteTx('shared', K(), 'test', async () => {
			aIn.resolve();
			await aGo.p;
			throw new Error('A fails');
		});
		await aIn.p;
		const b = withTagWriteTx('shared', K(), 'test', async () => {});
		await new Promise((r) => setTimeout(r, 200));
		aGo.resolve();
		await expect(a).rejects.toThrow('A fails');
		await b;
		expect((await failRow()).cleared).toBe(true);
	});

	it('engine lock acquired but the same-key lock times out → recorded via the PRE token, no secondary error', async () => {
		const xIn = deferred();
		const xGo = deferred();
		const x = withTagWriteTx('shared', K(), 'test', async () => {
			xIn.resolve();
			await xGo.p;
		});
		await xIn.p;
		await expect(withTagWriteTx('shared', K(), 'test-y', async () => {})).rejects.toThrow(/lock timeout/i);
		const f = (await query<{ entry_point: string; cleared: boolean }>(
			'SELECT entry_point, cleared_at IS NOT NULL AS cleared FROM tag_materialization_failure WHERE key = $1',
			[K()]
		)).rows[0];
		expect(f).toEqual({ entry_point: 'test-y', cleared: false });
		xGo.resolve();
		await x;
	}, 30_000);
});
