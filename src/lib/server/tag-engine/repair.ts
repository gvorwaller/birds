/**
 * Generation-keyed batched repair (td-894144 Release B, plan rev 21 §B2
 * "Taxonomy name change while tags are owned").
 *
 * replaceTaxonomy (exclusive) that changes the lexicon — with or without an
 * owned tag (td-861855) — does NOT re-derive the universe in its own
 * transaction (lock budget). It
 * calls beginTagRepair: bump the generation and insert its `tag_repair` job
 * — both on the same transaction, so they commit or roll back together. The
 * job then repairs the workset (migration 0067 `tag_repair_workset`) in short
 * exclusive batches and completes the generation with a compare-and-swap
 * whose predicate is exactly "workset empty", so the loop is self-healing.
 *
 * Every write goes through withTagWriteTx (engine lock) and the definers.
 */
import { query } from '$lib/db';
import { enqueueJob, insertJobOn } from '$server/jobs';
import { lexiconFor, materializeMany } from './materialize';
import { withTagWriteTx, type TagWriteTx } from './runtime';
import { scannerRev } from './segment';

/**
 * Codes re-derived per exclusive transaction. The original 200-code batch
 * crossed the binding 1 s lock-budget gate twice on the M4 (1.18 s, 1.25 s),
 * so the reviewed production default is the largest conservative half-step.
 */
export const TAG_REPAIR_BATCH = 100;

export const tagRepairDedupKey = (generation: bigint | number) => `tag_repair:g${generation}`;

export interface TagRepairState {
	repairGeneration: bigint;
	repairedGeneration: bigint;
	target: string | null;
	lexiconHash: string;
	pending: boolean;
}

async function readState(exec: TagWriteTx['exec'] | typeof query): Promise<TagRepairState | null> {
	const r = (
		await exec<{ repair_generation: string; repaired_generation: string; target: string | null; lexicon_hash: string }>(
			`SELECT repair_generation::text, repaired_generation::text,
			        repair_target_lexicon_hash AS target, lexicon_hash
			   FROM tag_lexicon_state WHERE id = 1`
		)
	).rows[0];
	if (!r) return null;
	const repairGeneration = BigInt(r.repair_generation);
	const repairedGeneration = BigInt(r.repaired_generation);
	return {
		repairGeneration,
		repairedGeneration,
		target: r.target,
		lexiconHash: r.lexicon_hash,
		pending: repairedGeneration < repairGeneration
	};
}

/** Read-only view for the admin Tags tab and the nightly job. */
export function tagRepairState(): Promise<TagRepairState | null> {
	return readState(query);
}

/**
 * Inside replaceTaxonomy's exclusive transaction: open generation G for the
 * current lexicon and insert its job + 'enqueued' event on the SAME client.
 * The generation-qualified dedup key can never collapse onto an older
 * generation's job (CODEX1 rev-20 finalization-window race).
 */
export async function beginTagRepair(
	tx: TagWriteTx,
	target: string,
	requesterId: number
): Promise<{ generation: bigint; jobId: number | null }> {
	const generation = BigInt(
		(await tx.exec<{ g: string }>('SELECT public.begin_tag_repair($1)::text AS g', [target])).rows[0].g
	);
	const jobId = await insertJobOn(tx.client, {
		type: 'tag_repair',
		payload: { repairGeneration: Number(generation) },
		dedupKey: tagRepairDedupKey(generation),
		requestedBy: requesterId,
		label: `generation ${generation}`,
		maxAttempts: 4
	});
	return { generation, jobId };
}

/**
 * For a caller that has just re-derived the whole universe inline in the same
 * transaction (test fixtures settling the universe; replaceTaxonomy no longer
 * does, td-861855): a generation left pending by an earlier change is closed
 * here (bump + CAS) instead of being stranded with a target the lexicon has
 * moved past.
 */
export async function closePendingRepairInline(tx: TagWriteTx, target: string): Promise<bigint | null> {
	const s = await readState(tx.exec);
	if (!s?.pending) return null;
	const g = BigInt((await tx.exec<{ g: string }>('SELECT public.begin_tag_repair($1)::text AS g', [target])).rows[0].g);
	const ok = (
		await tx.exec<{ ok: boolean }>('SELECT public.complete_tag_repair($1, $2) AS ok', [g.toString(), scannerRev()])
	).rows[0].ok;
	if (!ok) throw new Error(`tag repair generation ${g} could not be closed inline`);
	return g;
}

export type TagRepairOutcome = 'converged' | 'already' | 'superseded' | 'stopped';

export interface TagRepairResult {
	generation: string;
	outcome: TagRepairOutcome;
	repaired: number;
	batches: number;
}

/**
 * Repair generation G to convergence. `shouldStop` is consulted between
 * batches (job cancel); a stop leaves the generation pending. Each batch
 * re-reads the state under the exclusive lock, so a newer generation (which
 * has its own job) supersedes this one immediately.
 */
export async function repairTagGeneration(
	generation: bigint,
	opts: { batch?: number; shouldStop?: (progress: { repaired: number; batches: number }) => Promise<boolean> } = {}
): Promise<TagRepairResult> {
	const batch = opts.batch ?? TAG_REPAIR_BATCH;
	let repaired = 0;
	let batches = 0;
	let previous: string | null = null;
	const done = (outcome: TagRepairOutcome): TagRepairResult => ({
		generation: generation.toString(),
		outcome,
		repaired,
		batches
	});
	for (;;) {
		if (batches > 0 && (await opts.shouldStop?.({ repaired, batches }))) return done('stopped');
		const step = await withTagWriteTx('exclusive', 'global:repair', 'tag_repair', async (tx) => {
			const s = await readState(tx.exec);
			if (!s || s.repairedGeneration >= generation) return { outcome: 'already' as TagRepairOutcome, repairedNow: 0 };
			if (s.repairGeneration > generation) return { outcome: 'superseded' as TagRepairOutcome, repairedNow: 0 };
			if (!s.target) throw new Error(`tag repair generation ${generation} has no target`);
			const lex = await lexiconFor(tx);
			if (lex.hash !== s.target) {
				// Only a taxonomy replacement moves the lexicon, and it opens a
				// newer generation (or closes this one inline) in the same txn.
				throw new Error(`tag repair generation ${generation}: lexicon ${lex.hash} is not the target ${s.target}`);
			}
			const codes = (
				await tx.exec<{ c: string }>('SELECT c FROM public.tag_repair_workset($1, $2, $3) c', [
					s.target,
					lex.scannerRev,
					batch
				])
			).rows.map((r) => r.c);
			if (codes.length === 0) {
				const ok = (
					await tx.exec<{ ok: boolean }>('SELECT public.complete_tag_repair($1, $2) AS ok', [
						generation.toString(),
						lex.scannerRev
					])
				).rows[0].ok;
				return { outcome: (ok ? 'converged' : 'superseded') as TagRepairOutcome, repairedNow: 0 };
			}
			const key = codes.join(',');
			if (key === previous) {
				throw new Error(`tag repair generation ${generation} made no progress on ${codes.length} codes (from ${codes[0]})`);
			}
			previous = key;
			await materializeMany(tx, codes);
			return { outcome: null, repairedNow: codes.length };
		});
		batches++;
		if (step.outcome) return done(step.outcome);
		repaired += step.repairedNow;
	}
}

/** Remaining work for progress display (read-only estimate, no lock). */
export async function tagRepairBacklog(target: string): Promise<number> {
	const r = await query<{ n: string }>(
		'SELECT count(*)::text AS n FROM public.tag_repair_workset($1, $2, 2147483647)',
		[target, scannerRev()]
	);
	return Number(r.rows[0].n);
}

/**
 * Make sure the pending generation has an active job (nightly consistency run,
 * admin "Resume repair"). Outside any tag transaction, so enqueueJob is right.
 */
export async function ensureTagRepairJob(
	requesterId: number
): Promise<{ generation: string; jobId: number; deduped: boolean } | null> {
	const s = await tagRepairState();
	if (!s?.pending) return null;
	const r = await enqueueJob({
		type: 'tag_repair',
		payload: { repairGeneration: Number(s.repairGeneration) },
		dedupKey: tagRepairDedupKey(s.repairGeneration),
		requestedBy: requesterId,
		label: `generation ${s.repairGeneration}`,
		maxAttempts: 4
	});
	return { generation: s.repairGeneration.toString(), ...r };
}
