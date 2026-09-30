/**
 * Materialization: a species' stored article + taxonomy → its input context,
 * and — for every OWNED tag — the approved ruleset's result, recorded
 * through the definer routines; then apply_effective_tags (td-894144
 * Release B, plan rev 18 §B2). Every function here takes a TagWriteTx, so it
 * can only run inside withTagWriteTx (engine lock held).
 *
 * Universe: a stored article (wikipedia_extract NOT NULL) + a current
 * category='species' taxonomy row. Non-members lose their input pointer, so
 * every owned tag reads as unknown for them.
 */
import { createHash } from 'node:crypto';
import { ALL_TAGS } from '$lib/species-tags';
import { parseRuleset, type Ruleset } from './rules';
import { buildLexicon, evaluateTag, lexiconKey, type TaxonLexicon } from './scanner';
import { scannerRev, segmentArticle } from './segment';
import type { TagWriteTx } from './runtime';

const sha256 = (s: string) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');

// ── lexicon (other-taxon names), cached per process by its hash ────────────
interface LexiconCtx {
	hash: string;
	scannerRev: string;
	lexicon: TaxonLexicon;
}
let cachedLexicon: LexiconCtx | null = null;

function lexiconNames(rows: readonly { com_name: string; sci_name: string; family: string | null }[]): string[] {
	const names: string[] = [];
	for (const r of rows) {
		names.push(r.com_name, r.sci_name.split(' ')[0]);
		if (r.family) names.push(r.family);
	}
	return names;
}

/** Build the lexicon from the taxonomy visible in this transaction. */
async function buildLexiconCtx(tx: TagWriteTx): Promise<LexiconCtx> {
	const rows = (
		await tx.exec<{ com_name: string; sci_name: string; family: string | null }>(
			`SELECT com_name, sci_name, family FROM taxonomy_cache WHERE category = 'species'`
		)
	).rows;
	const names = lexiconNames(rows);
	const keys = [...new Set(names.map(lexiconKey).filter(Boolean))].sort();
	return { hash: sha256(JSON.stringify(keys)), scannerRev: scannerRev(), lexicon: buildLexicon(names) };
}

/**
 * The lexicon for this transaction. Under the SHARED lock the taxonomy cannot
 * change (replaceTaxonomy is exclusive), so a stored state whose hash matches
 * the process cache is trusted; otherwise it is rebuilt and the state row
 * written (idempotent — concurrent shared writers compute the same value).
 */
export async function lexiconFor(tx: TagWriteTx, opts: { rebuild?: boolean } = {}): Promise<LexiconCtx> {
	const rev = scannerRev();
	if (!opts.rebuild) {
		const s = (
			await tx.exec<{ lexicon_hash: string; scanner_rev: string }>(
				'SELECT lexicon_hash, scanner_rev FROM tag_lexicon_state WHERE id = 1'
			)
		).rows[0];
		if (s && s.scanner_rev === rev && cachedLexicon?.hash === s.lexicon_hash && cachedLexicon.scannerRev === rev)
			return cachedLexicon;
	}
	const ctx = await buildLexiconCtx(tx);
	await tx.exec('SELECT public.set_tag_lexicon_state($1, $2)', [ctx.hash, ctx.scannerRev]);
	cachedLexicon = ctx;
	return ctx;
}

// ── owned revisions (approved rulesets), verified by hash ───────────────────
interface OwnedRevision {
	tag: string;
	revisionId: string;
	ruleset: Ruleset;
}
const rulesetCache = new Map<string, Ruleset>();

export async function ownedRevisions(tx: TagWriteTx): Promise<OwnedRevision[]> {
	const rows = (
		await tx.exec<{ tag: string; revision_id: string; artifact_text: string; artifact_sha256: string }>(
			`SELECT o.tag, a.revision_id::text, r.artifact::text AS artifact_text, r.artifact_sha256
			   FROM tag_ownership o
			   JOIN tag_activation a ON a.id = o.activation_id AND a.revision_id IS NOT NULL
			   JOIN tag_revision r ON r.id = a.revision_id AND r.tag = o.tag
			  ORDER BY o.tag`
		)
	).rows;
	return rows.map((r) => {
		// Hash the exact stored text (hash-byte contract), never a re-serialization.
		if (sha256(r.artifact_text) !== r.artifact_sha256)
			throw new Error(`tag revision ${r.revision_id}: artifact hash mismatch (integrity)`);
		const key = `${r.revision_id}:${r.artifact_sha256}`;
		let ruleset = rulesetCache.get(key);
		if (!ruleset) {
			ruleset = parseRuleset(JSON.parse(r.artifact_text), ALL_TAGS);
			if (ruleset.tag !== r.tag) throw new Error(`tag revision ${r.revision_id}: ruleset tag mismatch`);
			rulesetCache.set(key, ruleset);
		}
		return { tag: r.tag, revisionId: r.revision_id, ruleset };
	});
}

// ── one species ───────────────────────────────────────────────────────────
interface SpeciesRow {
	species_code: string;
	wikipedia_extract: string | null;
	wikipedia_sections: { title: string; text: string }[] | null;
	category: string | null;
	order_name: string | null;
	family_sci_name: string | null;
	com_name: string | null;
	sci_name: string | null;
	family: string | null;
}

const SPECIES_SELECT = `
	SELECT se.species_code, se.wikipedia_extract, se.wikipedia_sections,
	       tc.category, tc.order_name, tc.family_sci_name, tc.com_name, tc.sci_name, tc.family
	  FROM species_enrichment se
	  LEFT JOIN taxonomy_cache tc ON tc.species_code = se.species_code`;

export function focalExemptions(row: Pick<SpeciesRow, 'com_name' | 'sci_name' | 'family'>): string[] {
	return [row.com_name ?? '', (row.sci_name ?? '').split(' ')[0], row.family ?? ''].filter(Boolean);
}

interface MemberInput {
	row: SpeciesRow;
	article: { extract: string | null; sections: { title: string; text: string }[] };
	exempt: string[];
	textHash: string;
	focalHash: string;
}

/**
 * Batched materialization: one round trip each for the input upserts, the
 * non-member deletions, every owned tag's states, and the effective-tag
 * merge — regardless of batch size (plan rev 13/14: keep the exclusive hold
 * short). Semantics are identical to doing it one species at a time.
 */
async function materializeRows(
	tx: TagWriteTx,
	rows: readonly SpeciesRow[],
	lex: LexiconCtx,
	owned: readonly OwnedRevision[]
): Promise<void> {
	if (rows.length === 0) return;
	const members: MemberInput[] = [];
	const nonMembers: string[] = [];
	for (const row of rows) {
		if (row.wikipedia_extract != null && row.category === 'species') {
			const article = { extract: row.wikipedia_extract, sections: row.wikipedia_sections ?? [] };
			const exempt = focalExemptions(row);
			members.push({
				row,
				article,
				exempt,
				textHash: segmentArticle(article).textHash,
				focalHash: sha256(JSON.stringify([...new Set(exempt.map(lexiconKey).filter(Boolean))].sort()))
			});
		} else nonMembers.push(row.species_code);
	}
	if (nonMembers.length)
		await tx.exec('SELECT public.delete_tag_input(c) FROM unnest($1::text[]) c', [nonMembers]);
	const hashes = new Map<string, string>();
	if (members.length) {
		const r = await tx.exec<{ code: string; h: string }>(
			`SELECT x.code, public.record_tag_input(x.code, x.text_hash, x.order_name, x.family_sci_name,
			          $2, x.focal_hash, $3) AS h
			   FROM jsonb_to_recordset($1::jsonb)
			     AS x(code text, text_hash text, order_name text, family_sci_name text, focal_hash text)`,
			[
				JSON.stringify(
					members.map((m) => ({
						code: m.row.species_code,
						text_hash: m.textHash,
						order_name: m.row.order_name,
						family_sci_name: m.row.family_sci_name,
						focal_hash: m.focalHash
					}))
				),
				lex.hash,
				lex.scannerRev
			]
		);
		for (const x of r.rows) hashes.set(x.code, x.h);
	}
	for (const o of owned) {
		if (!members.length) break;
		const results = members.map((m) => {
			const res = evaluateTag(
				{
					article: m.article,
					taxon: { order: m.row.order_name, family: m.row.family_sci_name },
					lexicon: lex.lexicon,
					exempt: m.exempt
				},
				o.ruleset
			);
			return {
				code: m.row.species_code,
				input_hash: hashes.get(m.row.species_code),
				status: res.status,
				reason: res.reason,
				evidence: res.evidence,
				scanner_rev: res.scannerRev
			};
		});
		await tx.exec(
			`SELECT public.record_tag_state(x.code, $2::bigint, $3, x.input_hash, x.status, x.reason, x.evidence, x.scanner_rev)
			   FROM jsonb_to_recordset($1::jsonb)
			     AS x(code text, input_hash text, status text, reason text, evidence jsonb, scanner_rev text)`,
			[JSON.stringify(results), o.revisionId, o.tag]
		);
	}
	await tx.exec('SELECT public.apply_effective_tags(c) FROM unnest($1::text[]) c', [
		rows.map((r) => r.species_code)
	]);
}

/** Re-derive one species' input and owned-tag state (wiki entry points). */
export async function materializeSpecies(tx: TagWriteTx, code: string): Promise<void> {
	const rows = (await tx.exec<SpeciesRow>(`${SPECIES_SELECT} WHERE se.species_code = $1`, [code])).rows;
	await materializeRows(tx, rows, await lexiconFor(tx), await ownedRevisions(tx));
}

/**
 * Re-derive many species (replaceTaxonomy, bootstrap, consistency). `codes`
 * null = every species_enrichment row. The code list is read once, then rows
 * are loaded and written in batches (bounded memory, few round trips).
 */
export async function materializeMany(
	tx: TagWriteTx,
	codes: readonly string[] | null,
	opts: { rebuildLexicon?: boolean; batch?: number } = {}
): Promise<number> {
	const lex = await lexiconFor(tx, { rebuild: opts.rebuildLexicon });
	const owned = await ownedRevisions(tx);
	const batch = opts.batch ?? 500;
	const all =
		codes ??
		(await tx.exec<{ c: string }>('SELECT species_code AS c FROM species_enrichment ORDER BY species_code')).rows.map(
			(r) => r.c
		);
	for (let i = 0; i < all.length; i += batch) {
		const rows = (
			await tx.exec<SpeciesRow>(`${SPECIES_SELECT} WHERE se.species_code = ANY($1::text[]) ORDER BY se.species_code`, [
				all.slice(i, i + batch)
			])
		).rows;
		await materializeRows(tx, rows, lex, owned);
	}
	return all.length;
}

/** Test hook: forget the per-process lexicon cache. */
export function __resetTagEngineCachesForTests(): void {
	cachedLexicon = null;
	rulesetCache.clear();
}
