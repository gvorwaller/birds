/**
 * td-894144 Release B (B2a) — migration 0066 contract, as the runtime role
 * (birds_app) and, where noted, the owner. Owned fixtures only (zztb…),
 * removed with the birds_test-only fixture flags. Plan rev 18 §B2.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { query } from '$lib/db';
import { withOwnerClient } from '../tag-fixtures.test-helper';

const dbUp = await query('SELECT 1').then(() => true).catch(() => false);
const migrated = dbUp
	? await query(`SELECT to_regclass('public.species_tag_state') IS NOT NULL AS ok`).then((r) => r.rows[0].ok === true)
	: false;

const RUN = String(process.pid % 100000).padStart(5, '0');
const CODE = `zztb${RUN}a`;
const CODE2 = `zztb${RUN}b`;
const TAG = 'habitat:open-ocean';
const ENGINE_KEY = 894144n;
const hex = (s: string) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
const H = (n: number) => hex(`fixture-${RUN}-${n}`);

let adminId = 0;
let userId = 0;
const proposals: string[] = [];

async function asOwner<T>(sql: string, params: unknown[] = []): Promise<T[]> {
	return withOwnerClient(async (c) => {
		await c.query('BEGIN');
		try {
			await c.query(`SELECT set_config('birds.tag_fixture', 'on', true)`);
			const r = await c.query(sql, params);
			await c.query('COMMIT');
			return r.rows as T[];
		} catch (e) {
			await c.query('ROLLBACK');
			throw e;
		}
	});
}

async function cleanup() {
	await asOwner(
		`WITH p AS (SELECT id FROM tag_rule_proposal WHERE id = ANY($1::uuid[])),
		      r AS (SELECT id FROM tag_revision WHERE proposal_id IN (SELECT id FROM p)),
		      d1 AS (DELETE FROM species_tag_state WHERE revision_id IN (SELECT id FROM r)),
		      d2 AS (DELETE FROM tag_report WHERE revision_id IN (SELECT id FROM r))
		 SELECT 1`,
		[proposals]
	);
	await asOwner(
		`WITH p AS (SELECT id FROM tag_rule_proposal WHERE id = ANY($1::uuid[])),
		      r AS (SELECT id FROM tag_revision WHERE proposal_id IN (SELECT id FROM p))
		 DELETE FROM tag_revision WHERE id IN (SELECT id FROM r)`,
		[proposals]
	);
	await asOwner(`DELETE FROM tag_crosscheck WHERE proposal_id = ANY($1::uuid[])`, [proposals]);
	await asOwner(`DELETE FROM tag_rule_proposal WHERE id = ANY($1::uuid[])`, [proposals]);
	await asOwner(`DELETE FROM tag_materialization_failure WHERE key LIKE $1`, [`zztb${RUN}%`]);
	await query('DELETE FROM species_enrichment WHERE species_code = ANY($1)', [[CODE, CODE2]]);
}

async function proposal(artifact: unknown, tag = TAG): Promise<{ id: string; sha: string; text: string }> {
	const r = await query<{ id: string; artifact_sha256: string; artifact_text: string }>(
		`INSERT INTO tag_rule_proposal (tag, artifact, source) VALUES ($1, $2::jsonb, 'human')
		 RETURNING id, artifact_sha256, artifact::text AS artifact_text`,
		[tag, JSON.stringify(artifact)]
	);
	proposals.push(r.rows[0].id);
	return { id: r.rows[0].id, sha: r.rows[0].artifact_sha256, text: r.rows[0].artifact_text };
}

const ARTIFACT = { schema: 1, tag: TAG, rev: `fixture-${RUN}`, note: 'Ω "quoted" \\ back', n: [1, 1.0, 1e3] };

describe.runIf(migrated)('0066: grants (undo inherited defaults)', () => {
	it('every new table: birds_app has SELECT only, except column INSERT on proposals', async () => {
		const r = await query<{ table_name: string; privs: string }>(
			`SELECT table_name, string_agg(privilege_type, ',' ORDER BY privilege_type) AS privs
			   FROM information_schema.role_table_grants
			  WHERE grantee = 'birds_app' AND table_name IN (
			    'tag_lexicon_state','species_tag_input','tag_rule_proposal','tag_crosscheck','tag_revision',
			    'tag_report','tag_activation','tag_ownership','species_tag_state',
			    'tag_materialization_failure','tag_consistency_run')
			  GROUP BY table_name ORDER BY table_name`
		);
		expect(r.rows.length).toBe(11);
		for (const row of r.rows) expect(row.privs, row.table_name).toBe('SELECT');
		const cols = await query<{ column_name: string }>(
			`SELECT column_name FROM information_schema.column_privileges
			  WHERE grantee = 'birds_app' AND table_name = 'tag_rule_proposal' AND privilege_type = 'INSERT'
			  ORDER BY column_name`
		);
		expect(cols.rows.map((c) => c.column_name)).toEqual(['ai_usage_call_id', 'artifact', 'source', 'tag']);
	});

	it('no sequence privileges; definers executable by birds_app but not PUBLIC', async () => {
		const seq = await query<{ n: number }>(
			`SELECT count(*)::int AS n FROM pg_class c
			  WHERE c.relkind = 'S' AND (c.relname = 'tag_attempt_seq' OR c.relname LIKE 'tag\\_%' OR c.relname LIKE 'species\\_tag\\_%')
			    AND (has_sequence_privilege('birds_app', c.oid, 'USAGE') OR has_sequence_privilege('birds_app', c.oid, 'SELECT'))`
		);
		expect(seq.rows[0].n).toBe(0);
		const fn = await query<{ proname: string; app: boolean; pub: boolean }>(
			`SELECT p.proname,
			        has_function_privilege('birds_app', p.oid, 'EXECUTE') AS app,
			        EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
			                 WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS pub
			   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
			  WHERE n.nspname = 'public' AND p.proname IN ('begin_tag_attempt','record_tag_state','record_tag_input',
			        'apply_effective_tags','approve_tag_proposal','switch_tag_ownership','rollback_tag',
			        'record_materialization_failure','clear_materialization_failure','record_tag_report')`
		);
		expect(fn.rows.length).toBe(10);
		for (const f of fn.rows) expect([f.proname, f.app, f.pub]).toEqual([f.proname, true, false]);
	});
});

describe.runIf(migrated)('0066: proposals and the hash-byte contract', () => {
	beforeAll(cleanup);
	afterAll(cleanup);

	it('the trigger sets artifact_sha256 from artifact::text bytes; status is forced to proposed', async () => {
		const p = await proposal(ARTIFACT);
		expect(p.sha).toBe(hex(p.text)); // TS hashes the exact stored text, never re-serializes
		const row = (await query<{ status: string }>(`SELECT status FROM tag_rule_proposal WHERE id = $1`, [p.id])).rows[0];
		expect(row.status).toBe('proposed');
	});

	it('jsonb storage identity: key order/whitespace normalize, numeric scale does not', async () => {
		const r = await query<{ a: string; b: string; c: string }>(
			`SELECT tag_artifact_sha256('{"b":1,"a":2}'::jsonb) AS a,
			        tag_artifact_sha256('{ "a" : 2 , "b" : 1 }'::jsonb) AS b,
			        tag_artifact_sha256('{"a":2.0,"b":1}'::jsonb) AS c`
		);
		expect(r.rows[0].a).toBe(r.rows[0].b);
		expect(r.rows[0].c).not.toBe(r.rows[0].a);
	});

	it('artifact, hash, tag and source are immutable; deletes are refused (owner too)', async () => {
		const p = await proposal(ARTIFACT);
		await expect(
			withOwnerClient((c) => c.query(`UPDATE tag_rule_proposal SET artifact = '{}'::jsonb WHERE id = $1`, [p.id]))
		).rejects.toThrow(/only status may change/);
		await expect(
			withOwnerClient((c) => c.query(`DELETE FROM tag_rule_proposal WHERE id = $1`, [p.id]))
		).rejects.toThrow(/immutable/);
		await expect(query(`UPDATE tag_rule_proposal SET status = 'approved' WHERE id = $1`, [p.id])).rejects.toThrow(
			/permission denied/
		);
	});
});

describe.runIf(migrated)('0066: approve_tag_proposal refusals', () => {
	beforeAll(async () => {
		await cleanup();
		adminId = (await query<{ id: number }>(`SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1`)).rows[0].id;
		userId = (await query<{ id: number }>(`SELECT id FROM users WHERE role <> 'admin' ORDER BY id LIMIT 1`)).rows[0]?.id ?? -1;
	});
	afterAll(cleanup);

	const crosscheck = (id: string, sha: string, verdict = 'approve') =>
		asOwner(
			`INSERT INTO tag_crosscheck (proposal_id, reviewer, verdict, text, reviewed_sha256) VALUES ($1, 'CODEX1', $2, 'fixture', $3)`,
			[id, verdict, sha]
		);

	it('refuses: no cross-check, wrong-hash cross-check, non-approve verdict, non-admin, tag mismatch', async () => {
		const p = await proposal(ARTIFACT);
		await expect(query(`SELECT approve_tag_proposal($1, $2)`, [p.id, adminId])).rejects.toThrow(/no approving cross-check/);
		await crosscheck(p.id, H(1));
		await expect(query(`SELECT approve_tag_proposal($1, $2)`, [p.id, adminId])).rejects.toThrow(/no approving cross-check/);
		await crosscheck(p.id, p.sha, 'changes');
		await expect(query(`SELECT approve_tag_proposal($1, $2)`, [p.id, adminId])).rejects.toThrow(/no approving cross-check/);
		await crosscheck(p.id, p.sha, 'approve');
		if (userId > 0)
			await expect(query(`SELECT approve_tag_proposal($1, $2)`, [p.id, userId])).rejects.toThrow(/not an admin/);
		const bad = await proposal({ ...ARTIFACT, tag: 'habitat:beach' }, TAG);
		await crosscheck(bad.id, bad.sha, 'approve');
		await expect(query(`SELECT approve_tag_proposal($1, $2)`, [bad.id, adminId])).rejects.toThrow(/does not match artifact tag/);
	});

	it('approves the exact cross-checked artifact into an immutable revision', async () => {
		const p = await proposal(ARTIFACT);
		await crosscheck(p.id, p.sha, 'approve');
		const rev = Number((await query<{ id: string }>(`SELECT approve_tag_proposal($1, $2) AS id`, [p.id, adminId])).rows[0].id);
		const r = (await query<{ artifact_sha256: string; tag: string }>(`SELECT artifact_sha256, tag FROM tag_revision WHERE id = $1`, [rev])).rows[0];
		expect(r).toEqual({ artifact_sha256: p.sha, tag: TAG });
		await expect(withOwnerClient((c) => c.query(`UPDATE tag_revision SET tag = 'x' WHERE id = $1`, [rev]))).rejects.toThrow(/immutable/);
		await expect(query(`SELECT approve_tag_proposal($1, $2)`, [p.id, adminId])).rejects.toThrow(/proposal is approved/);
	});
});

describe.runIf(migrated)('0066: inputs, states and the effective-tag merge', () => {
	let rev = 0;
	beforeAll(async () => {
		await cleanup();
		const p = await proposal(ARTIFACT);
		await asOwner(
			`INSERT INTO tag_crosscheck (proposal_id, reviewer, verdict, text, reviewed_sha256) VALUES ($1, 'CODEX1', 'approve', 'fixture', $2)`,
			[p.id, p.sha]
		);
		rev = Number((await query<{ id: string }>(`SELECT approve_tag_proposal($1, $2) AS id`, [p.id, adminId || 1])).rows[0].id);
		await query(`INSERT INTO species_enrichment (species_code, wikipedia_extract) VALUES ($1, 'A pelagic fixture.')`, [CODE]);
	});
	afterAll(cleanup);

	const input = (n: number) =>
		query<{ h: string }>(`SELECT record_tag_input($1, $2, 'Procellariiformes', 'Hydrobatidae', $3, $4, 'engine-1|test') AS h`, [
			CODE,
			H(n),
			H(100),
			H(200)
		]).then((r) => r.rows[0].h);

	it('input_hash is computed in SQL; re-recording the same input is a no-op', async () => {
		const a = await input(1);
		expect(a).toMatch(/^[0-9a-f]{64}$/);
		expect(await input(1)).toBe(a);
		expect(await input(2)).not.toBe(a);
	});

	it('state: stale input refused; identical re-record OK; conflicting re-record raises; shape enforced', async () => {
		const cur = await input(3);
		const ev = JSON.stringify([{ section: '', sentence: 'A pelagic fixture.', matchStart: 2, matchEnd: 9, ruleId: 's1' }]);
		const rec = (h: string, status: string, reason: string | null, evidence = '[]') =>
			query(`SELECT record_tag_state($1, $2, $3, $4, $5, $6, $7::jsonb, 'engine-1|test')`, [CODE, rev, TAG, h, status, reason, evidence]);
		await expect(rec(H(9), 'assigned', null, ev)).rejects.toThrow(/stale or missing input/);
		await expect(
			query(`SELECT record_tag_state($1, $2, $3, $4, 'not_assigned', 'no_support', '[]'::jsonb, 'wrong-scanner')`, [
				CODE,
				rev,
				TAG,
				cur
			])
		).rejects.toThrow(/scanner revision does not match current input/);
		await rec(cur, 'assigned', null, ev);
		await rec(cur, 'assigned', null, ev); // identical: fine
		await expect(rec(cur, 'not_assigned', 'no_support')).rejects.toThrow(/conflicting result/);
		const cur2 = await input(4);
		await expect(rec(cur2, 'assigned', 'no_support', ev)).rejects.toThrow(/check constraint/);
		await expect(rec(cur2, 'unevaluated', 'made_up')).rejects.toThrow(/check constraint/);
		await expect(
			query(`SELECT record_tag_state($1, $2, 'habitat:beach', $3, 'not_assigned', 'no_support', '[]'::jsonb, 'engine-1|test')`, [CODE, rev, cur2])
		).rejects.toThrow(/foreign key/);
		await expect(withOwnerClient((c) => c.query(`UPDATE species_tag_state SET status = 'not_assigned' WHERE species_code = $1`, [CODE]))).rejects.toThrow(/immutable/);
	});

	it('apply_effective_tags with nothing owned leaves tags unchanged', async () => {
		await withOwnerClient(async (c) => {
			await c.query('BEGIN');
			await c.query(`SELECT set_config('birds.legacy_fixture', 'on', true)`);
			await c.query(`UPDATE species_enrichment SET tags = ARRAY['habitat:beach','time:diurnal'] WHERE species_code = $1`, [CODE]);
			await c.query('COMMIT');
		});
		const owned = (await query<{ n: number }>(`SELECT count(*)::int AS n FROM tag_ownership WHERE tag = $1`, [TAG])).rows[0].n;
		if (owned > 0) return; // a real activation exists on this cluster; the owned case is covered by the switch test
		await query(`SELECT apply_effective_tags($1)`, [CODE]);
		const t = (await query<{ tags: string[] }>(`SELECT tags FROM species_enrichment WHERE species_code = $1`, [CODE])).rows[0].tags;
		expect(t).toEqual(['habitat:beach', 'time:diurnal']);
	});
});

describe.runIf(migrated)('0066: failure log is monotone by attempt number', () => {
	const K = `zztb${RUN}fail`;
	beforeAll(cleanup);
	afterAll(cleanup);
	const next = async () => BigInt((await query<{ n: string }>(`SELECT begin_tag_attempt() AS n`)).rows[0].n);
	const rec = (k: string, n: bigint) =>
		query(`SELECT record_materialization_failure($1, NULL, 'test', 'boom', $2)`, [k, n.toString()]);
	const clr = (k: string, n: bigint) => query(`SELECT clear_materialization_failure($1, $2)`, [k, n.toString()]);
	const state = async (k: string) =>
		(await query<{ cleared: boolean }>(`SELECT cleared_at IS NOT NULL AS cleared FROM tag_materialization_failure WHERE key = $1`, [k])).rows[0];

	it('A fails, B succeeds, A stamps late (no pre-existing row): stays cleared', async () => {
		const k = `${K}1`;
		const a = await next();
		const b = await next();
		await clr(k, b);
		await rec(k, a);
		expect((await state(k)).cleared).toBe(true);
	});

	it('same, with a pre-existing failure row', async () => {
		const k = `${K}2`;
		await rec(k, await next());
		const a = await next();
		const b = await next();
		await clr(k, b);
		await rec(k, a);
		expect((await state(k)).cleared).toBe(true);
	});

	it('inverse: B clears first, then A (later token) fails: the failure stays uncleared', async () => {
		const k = `${K}3`;
		const b = await next();
		await clr(k, b);
		const aPost = await next();
		await rec(k, aPost);
		expect((await state(k)).cleared).toBe(false);
	});

	it('birds_app cannot draw from the sequence directly', async () => {
		await expect(query(`SELECT nextval('tag_attempt_seq')`)).rejects.toThrow(/permission denied/);
	});
});

describe.runIf(migrated)('0066: switch and rollback require the exclusive engine lock', () => {
	it('refuse without the lock', async () => {
		await expect(
			query(`SELECT switch_tag_ownership($1, 1, 1, 1, 1, $2)`, [TAG, ENGINE_KEY.toString()])
		).rejects.toThrow(/exclusive tag_engine lock not held/);
		await expect(query(`SELECT rollback_tag($1, 1, $2)`, [TAG, ENGINE_KEY.toString()])).rejects.toThrow(
			/exclusive tag_engine lock not held/
		);
	});

	it('an unrelated caller-selected advisory lock cannot satisfy the engine-lock guard', async () => {
		await withOwnerClient(async (c) => {
			await c.query('BEGIN');
			try {
				await c.query(`SELECT pg_advisory_xact_lock(12345::bigint)`);
				await expect(c.query(`SELECT rollback_tag('fixture:wrong-lock', 1, 12345)`)).rejects.toThrow(
					/wrong tag_engine lock key/
				);
			} finally {
				await c.query('ROLLBACK');
			}
		});
	});

	it('rollback to legacy removes the retired engine tag when no legacy snapshot exists', async () => {
		const code = `zztb${RUN}rollback`;
		const tag = `fixture:rollback-${RUN}`;
		await withOwnerClient(async (c) => {
			await c.query('BEGIN');
			try {
				await c.query(`INSERT INTO species_enrichment (species_code, tags) VALUES ($1, ARRAY[$2])`, [code, tag]);
				const rev = (
					await c.query<{ id: string }>(
						`INSERT INTO tag_revision (tag, source, artifact, artifact_sha256, approved_by)
						 VALUES ($1::text, 'rules', jsonb_build_object('tag', $1::text),
						         tag_artifact_sha256(jsonb_build_object('tag', $1::text)), 1)
						 RETURNING id::text`,
						[tag]
					)
				).rows[0].id;
				const act = (
					await c.query<{ id: string }>(
						`INSERT INTO tag_activation (tag, revision_id, action, activated_by)
						 VALUES ($1, $2, 'activate', 1) RETURNING id::text`,
						[tag, rev]
					)
				).rows[0].id;
				await c.query(`INSERT INTO tag_ownership (tag, activation_id) VALUES ($1, $2)`, [tag, act]);
				await c.query(`SELECT pg_advisory_xact_lock($1::bigint)`, [ENGINE_KEY.toString()]);
				await c.query(`SELECT rollback_tag($1, 1, $2)`, [tag, ENGINE_KEY.toString()]);
				const row = (await c.query<{ tags: string[] }>(`SELECT tags FROM species_enrichment WHERE species_code = $1`, [code]))
					.rows[0];
				expect(row.tags).toEqual([]);
			} finally {
				await c.query('ROLLBACK');
			}
		});
	});
});
