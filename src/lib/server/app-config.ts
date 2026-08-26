/**
 * Persisted runtime configuration (td-015838): the schema's first mutable
 * config store. Generic key/value over app_config — the AI model settings are
 * the first consumers, not the last.
 *
 * FAILURE SEMANTICS (GROK P0-1 — this is the module's whole reason to be
 * careful): "DB error → compiled default" INVERTS the dropdown's purpose.
 * Once the admin selects Haiku, the compiled default IS Opus 5, so a mid-drain
 * DB blip would silently re-price the rest of a chunk at 5x while the dropdown
 * still shows Haiku. Correct semantics:
 *   - process-local LAST-KNOWN-GOOD per key, overwritten only on a successful
 *     read (an absent row is a successful read meaning "compiled default");
 *   - on a failed read, return last-known-good;
 *   - the compiled default applies only when this process has NEVER
 *     successfully read the key.
 * Reads go through queryTimed because pool.query can wait forever on checkout
 * — a hung read would wedge the worker without ever throwing, so the catch
 * would never fire and no fallback would happen at all.
 */
import { query, queryTimed } from '$lib/db';
import { SELECTABLE_MODELS } from './ai-models';

export const CONFIG_KEYS = {
	enrichmentModel: 'ai.model.enrichment',
	guidanceModel: 'ai.model.guidance'
} as const;

const READ_TIMEOUT_MS = 5_000;

/** The stored shape for ai.model.* keys. */
export interface ModelConfigValue {
	provider: 'anthropic';
	model: string;
}

/**
 * Known keys and their validators. setConfig REJECTS keys not listed here —
 * a typo'd key would otherwise persist silently and every read of the real
 * key would fall through to the default forever. New consumers add an entry.
 */
const VALIDATORS: Record<string, (value: unknown) => string | null> = {
	[CONFIG_KEYS.enrichmentModel]: validateModelValue,
	[CONFIG_KEYS.guidanceModel]: validateModelValue
};

function validateModelValue(value: unknown): string | null {
	if (value == null || typeof value !== 'object') return 'value must be an object';
	const v = value as { provider?: unknown; model?: unknown };
	if (v.provider !== 'anthropic') return `unknown provider: ${String(v.provider)}`;
	if (typeof v.model !== 'string') return 'model must be a string';
	const entry = SELECTABLE_MODELS.find((m) => m.id === v.model);
	if (!entry?.buildRequest) return `model "${v.model}" is not selectable`;
	return null;
}

// Process-local last-known-good. Present iff this process has completed at
// least one successful read of the key (value may be the compiled default when
// that read found no row).
const lastKnownGood = new Map<string, unknown>();

/** Tests only: the cache is process-global and must not leak across cases. */
export function _resetConfigCacheForTests(): void {
	lastKnownGood.clear();
}

/**
 * Read a config value. Never throws; never hangs past READ_TIMEOUT_MS.
 * Returns, in order of preference: the stored value → `compiledDefault` when
 * no row exists (a successful read) → last-known-good on a failed read →
 * `compiledDefault` only if no read has ever succeeded in this process.
 */
export async function getConfig(key: string, compiledDefault: unknown): Promise<unknown> {
	try {
		const r = await queryTimed<{ value: unknown }>(
			'SELECT value FROM app_config WHERE key = $1',
			[key],
			READ_TIMEOUT_MS
		);
		const value = r.rows.length > 0 ? r.rows[0].value : compiledDefault;
		lastKnownGood.set(key, value);
		return value;
	} catch (err) {
		if (lastKnownGood.has(key)) {
			console.error(
				`app-config: read of ${key} failed; using last-known-good`,
				err instanceof Error ? err.message : err
			);
			return lastKnownGood.get(key);
		}
		console.error(
			`app-config: read of ${key} failed with no prior successful read; using compiled default`,
			err instanceof Error ? err.message : err
		);
		return compiledDefault;
	}
}

/**
 * Persist a config value. THROWS on validation failure or DB error — writes
 * happen from admin actions, which want the error surfaced, unlike reads on
 * the AI hot path. Updates last-known-good on success so a subsequent read
 * blip cannot resurrect the pre-write value.
 */
export async function setConfig(key: string, value: unknown): Promise<void> {
	const validator = VALIDATORS[key];
	if (!validator) throw new Error(`app-config: unknown key "${key}"`);
	const problem = validator(value);
	if (problem) throw new Error(`app-config: invalid value for ${key}: ${problem}`);
	await query(
		`INSERT INTO app_config (key, value) VALUES ($1, $2::jsonb)
		 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
		[key, JSON.stringify(value)]
	);
	lastKnownGood.set(key, value);
}
