/**
 * td-894144 Release B3 — the admin Tags tab read models and proposal
 * decisions against real birds_test SQL. Owned fixtures (zza…) through the
 * shared engine fixture (one real vocabulary tag owned for the file's life,
 * every affected real row restored exactly).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { query } from '$lib/db';
import { ALL_TAGS } from '$lib/species-tags';
import { tagEngineFixture } from './tag-engine/engine-fixture.test-helper';
import { tagRepairState } from './tag-engine/repair';
import { rejectProposal, tagDetail, tagsHealth, tagsOverview, tagWhy } from './tag-admin';

const dbUp = await query('SELECT 1').then(() => true).catch(() => false);
const migrated = dbUp
	? await query(`SELECT to_regprocedure('public.reject_tag_proposal(uuid, integer)') IS NOT NULL AS ok`).then(
			(r) => r.rows[0].ok === true
		)
	: false;

const fx = tagEngineFixture('zza');
const S: Record<string, string> = {};
let T = '';

describe.runIf(migrated).sequential('admin Tags tab read models', () => {
	beforeAll(async () => {
		if ((await tagRepairState())?.pending) throw new Error('refusing to run while a repair is pending');
		await fx.setup(1);
		T = fx.tags[0];
		S.yes = await fx.addSpecies('yes');
		S.no = await fx.addSpecies('no', { text: 'A quiet fixture shorebird.' });
		await fx.settleUniverse();
		await fx.approveAndActivate(T);
	}, 240_000);

	afterAll(async () => {
		await fx.cleanup();
	}, 240_000);

	it('overview: one row per vocabulary tag; the owned tag shows its revision and rule counts', async () => {
		const o = await tagsOverview();
		expect(o.rows).toHaveLength(ALL_TAGS.size);
		const row = o.rows.find((r) => r.tag === T)!;
		expect(row.owned?.revisionId).toBe(fx.revisions[T]);
		expect(row.assigned).toBeGreaterThanOrEqual(1);
		expect(row.notAssigned).toBeGreaterThanOrEqual(1);
		expect(row.unknown).toBe(0);
		expect(row.lastActivation?.action).toBe('activate');
		const other = o.rows.find((r) => r.tag !== T && !r.owned)!;
		expect(other).toMatchObject({ owned: null, assigned: null, unknown: null });
		expect(o.universe).toBeGreaterThan(0);
	});

	it('health: runs, schedule, failures and repair state read without error', async () => {
		const h = await tagsHealth();
		expect(Array.isArray(h.runs)).toBe(true);
		expect(h.unclearedCount).toBeGreaterThanOrEqual(0);
		expect(h.repair?.pending).toBe(false);
	});

	it('detail: history, revision, cross-checked proposal and samples; unknown tag → null', async () => {
		const d = (await tagDetail(T))!;
		expect(d.owned?.revisionId).toBe(fx.revisions[T]);
		expect(d.history[0]).toMatchObject({ action: 'activate', revisionId: fx.revisions[T] });
		expect(d.revisions.map((r) => r.id)).toContain(fx.revisions[T]);
		expect(d.proposals[0]).toMatchObject({ status: 'approved', crosscheck: { verdict: 'approve', matches: true } });
		expect(d.samples.assigned.map((s) => s.code)).toContain(S.yes);
		expect(d.samples.notAssigned.length).toBeGreaterThan(0); // a pseudo-random sample of the whole universe
		expect(await tagDetail('habitat:nowhere')).toBeNull();
	});

	it('why: explains an assigned and a not-assigned species; rejects junk queries', async () => {
		const y = (await tagWhy(T, S.yes))!;
		expect(y).toMatchObject({ code: S.yes, member: true, carries: true, legacy: 'no_baseline', state: { status: 'assigned' } });
		expect(y.state!.evidence[0].sentence).toContain(fx.signal);
		const n = (await tagWhy(T, S.no))!;
		expect(n).toMatchObject({ carries: false, state: { status: 'not_assigned', reason: 'no_support' } });
		expect(await tagWhy(T, 'x')).toBeNull();
		expect(await tagWhy('habitat:nowhere', S.yes)).toBeNull();
		const byName = (await tagWhy(T, `zza ${S.no}`))!;
		expect(byName.code).toBe(S.no);
	});

	it('reject: a proposal becomes rejected once; an approved one cannot be rejected', async () => {
		const p = (
			await query<{ id: string }>(
				`INSERT INTO tag_rule_proposal (tag, artifact, source) VALUES ($1, $2::jsonb, 'human') RETURNING id`,
				[T, JSON.stringify({ schema: 1, tag: T, rev: `reject-${fx.RUN}` })]
			)
		).rows[0].id;
		fx.proposals.push(p);
		await rejectProposal(p, fx.adminId);
		expect((await query<{ status: string }>('SELECT status FROM tag_rule_proposal WHERE id = $1', [p])).rows[0].status).toBe(
			'rejected'
		);
		await expect(rejectProposal(p, fx.adminId)).rejects.toThrow(/proposal is rejected/);
		const approved = (await tagDetail(T))!.proposals.find((x) => x.status === 'approved')!;
		await expect(rejectProposal(approved.id, fx.adminId)).rejects.toThrow(/proposal is approved/);
	});
});
