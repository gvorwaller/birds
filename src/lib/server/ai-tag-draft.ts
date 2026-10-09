/**
 * AI DRAFTING of evidence rules for one tag (td-894144 Release B4, plan rev 22
 * §B4b). The model writes a PROPOSAL only: this module returns raw JSON and
 * never validates, stores, approves or executes anything. The worker handler
 * validates it with the rules loader and inserts a `proposed` row; a
 * cross-check and the owner's approval stand between it and any tag.
 *
 * A static guard keeps this module (like every ai-*.ts) away from the tag
 * engine, the tag vocabulary and the approval/activation routines — the tag
 * name and definition arrive as plain strings from the caller.
 */
import { env } from "$env/dynamic/private";
import { parseRetryAfterMs } from "$server/wikidata";
import {
  anthropicHeaders,
  extractEnvelope,
  type AiCallEnvelope,
  type ModelEntry,
} from "./ai-models";

/** Opus with adaptive thinking at high effort on a 12k-token answer can run
 * several minutes; drafting is a rare, owner-pressed job, so be generous. */
export const TAG_DRAFT_TIMEOUT_MS = 420_000;
const TAG_DRAFT_ANSWER_TOKENS = 12_000;

export interface AuthoringExample {
  name: string;
  order: string | null;
  family: string | null;
  /** Sentences from the species' article containing a cue word. */
  sentences: string[];
}

export interface TagDraftInput {
  tag: string;
  definition: string;
  examples: readonly AuthoringExample[];
  /** A rejected earlier attempt's loader error, for the one retry. */
  previousError?: string | null;
}

export class TagDraftAiError extends Error {
  envelope?: AiCallEnvelope;
  constructor(
    message: string,
    readonly status: number,
    readonly rateLimited: boolean,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "TagDraftAiError";
  }
}

const SYSTEM = `You write EVIDENCE RULES that decide one bird tag from a species' Wikipedia article.

Your rules are a proposal. A second reviewer checks them and the owner approves them before they ever run, then a blind test measures them. Aim for HIGH PRECISION: a species gets the tag only when its own article plainly says so. A missed species is an accepted cost; a wrong tag is not.

How the engine applies a rule set to one species:
1. Taxon rules run first. "require_one_of" is a NECESSARY condition only (the species' order or family must be one of the values); "forbid" rejects matching orders/families. Use them only where the definition makes a taxon impossible, never as a shortcut for "probably". EVERY taxon rule must hold at once: two "require_one_of" rules are ANDed, so a family rule and an order rule that no species satisfies together (e.g. family Alcidae AND order Procellariiformes) reject every species. To allow several taxa, list them all in the "values" of ONE rule of one rank. Usually prefer "forbid" for taxa that can never qualify and leave the rest to the support phrases. A rule set whose taxon rules no species can satisfy is refused.
2. Support phrases are matched in the article's sections (except denied sections), and only in sentences about the species itself (sentences about named other species are skipped automatically).
3. An exclude phrase cancels a support match when it appears in the given scope around it: the same clause, the same sentence, or a word window (before/after, 0–12 words). "binds" lists the support groups it cancels, or ["*"] for all.
4. The tag is assigned when at least one support match survives. There are no weights.

Matching: "literal" matches the exact words (case-insensitive); "stem" also matches regular inflections (ocean/oceans, cross/crosses/crossing). Phrases are 1–6 words, plain words only — no regex, wildcards or punctuation tricks.

Write rules that generalize across the whole family of birds the definition covers. Cover the common ways articles phrase the habit, and add exclusions for the traps: migration or sea crossings, vagrants and storm-blown records, negation ("never", "not", "rarely"), hypotheticals ("may"), historical statements ("formerly"), comparisons with other birds, and land birds on oceanic islands. Deny sections that are not about the species' habits (taxonomy, etymology, similar species, in culture, subspecies).

Output one JSON object with exactly these keys:
- "schema": 1
- "tag": the tag name given
- "rev": a short label such as "ai-draft-1"
- "denySections": heading words whose sections are not read (e.g. "taxonomy")
- "comparisonMarkers": clause-start phrases that make a clause about something else (e.g. "unlike", "like other")
- "support": [{ "id", "group", "match": { "type", "phrase" }, "note" }] — at least one; the note says why the phrase is evidence
- "exclude": [{ "id", "binds", "match": { "type", "phrase" }, "scope", "note" }] — scope is {"unit":"clause"}, {"unit":"sentence"} or {"unit":"window","before":N,"after":N}
- "taxon": [{ "id", "rank": "order"|"family", "values": [...], "action": "require_one_of"|"forbid", "note" }]
Ids are unique across the whole rule set and use only letters, digits, "_", "." and "-" (max 40 chars). Use exact scientific order/family names (e.g. "Procellariiformes", "Alcidae").`;

function buildUser(input: TagDraftInput): string {
  const lines: string[] = [];
  lines.push(`Tag: ${input.tag}`);
  lines.push(`Definition: ${input.definition}`);
  lines.push("");
  lines.push(
    `Authoring examples (${input.examples.length} species; sentences are quoted from each article and contain a sea/ocean cue word — some describe the habit, some are traps):`,
  );
  for (const ex of input.examples) {
    lines.push("");
    lines.push(
      `## ${ex.name} — order ${ex.order ?? "unknown"}, family ${ex.family ?? "unknown"}`,
    );
    if (ex.sentences.length === 0) lines.push("(no cue sentences)");
    for (const s of ex.sentences) lines.push(`- ${s}`);
  }
  if (input.previousError) {
    lines.push("");
    lines.push(
      `Your previous rule set was rejected by the loader with this error — fix it and return the whole rule set again: ${input.previousError}`,
    );
  }
  return lines.join("\n");
}

const MATCH = {
  type: "object",
  additionalProperties: false,
  required: ["type", "phrase"],
  properties: {
    type: { type: "string", enum: ["literal", "stem"] },
    phrase: { type: "string" },
  },
};

/** Mirrors the loader's shape; the loader remains the only authority. */
export function tagDraftSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "schema",
      "tag",
      "rev",
      "denySections",
      "comparisonMarkers",
      "support",
      "exclude",
      "taxon",
    ],
    properties: {
      schema: { type: "integer", enum: [1] },
      tag: { type: "string" },
      rev: { type: "string" },
      denySections: { type: "array", items: { type: "string" } },
      comparisonMarkers: { type: "array", items: { type: "string" } },
      support: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "group", "match", "note"],
          properties: {
            id: { type: "string" },
            group: { type: "string" },
            match: MATCH,
            note: { type: "string" },
          },
        },
      },
      exclude: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "binds", "match", "scope", "note"],
          properties: {
            id: { type: "string" },
            binds: { type: "array", items: { type: "string" } },
            match: MATCH,
            scope: {
              anyOf: [
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["unit"],
                  properties: {
                    unit: { type: "string", enum: ["clause", "sentence"] },
                  },
                },
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["unit", "before", "after"],
                  properties: {
                    unit: { type: "string", enum: ["window"] },
                    before: { type: "integer" },
                    after: { type: "integer" },
                  },
                },
              ],
            },
            note: { type: "string" },
          },
        },
      },
      taxon: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "rank", "values", "action", "note"],
          properties: {
            id: { type: "string" },
            rank: { type: "string", enum: ["order", "family"] },
            values: { type: "array", items: { type: "string" } },
            action: { type: "string", enum: ["require_one_of", "forbid"] },
            note: { type: "string" },
          },
        },
      },
    },
  };
}

type Fetcher = typeof fetch;

/** One metered-call body: returns the model's JSON (unvalidated) and the envelope. */
export async function draftTagRules(
  input: TagDraftInput,
  model: ModelEntry,
  opts: { fetcher?: Fetcher; signal?: AbortSignal } = {},
): Promise<{ raw: unknown; envelope: AiCallEnvelope }> {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey)
    throw new TagDraftAiError(
      "AI drafting is not configured (no API key set).",
      0,
      false,
    );
  if (!model.buildRequest)
    throw new TagDraftAiError(
      `Model ${model.id} cannot build requests.`,
      0,
      false,
    );
  const built = model.buildRequest({
    system: SYSTEM,
    user: buildUser(input),
    schema: tagDraftSchema(),
    maxOutputTokens: TAG_DRAFT_ANSWER_TOKENS,
    effort: "high",
  });
  const fetcher = opts.fetcher ?? fetch;
  let res: Response;
  try {
    res = await fetcher("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: anthropicHeaders(apiKey, built.headers),
      body: JSON.stringify(built.body),
      signal: opts.signal ?? AbortSignal.timeout(TAG_DRAFT_TIMEOUT_MS),
    });
  } catch (err) { // stale-safe: wraps the provider transport error; no fenced call inside
    if (
      err instanceof Error &&
      (err.name === "TimeoutError" || err.name === "AbortError")
    )
      throw new TagDraftAiError(
        "AI request timed out before a response arrived.",
        0,
        false,
      );
    throw new TagDraftAiError("Could not reach the AI service.", 0, false);
  }
  const envelope: AiCallEnvelope = {
    requestId: res.headers.get("request-id"),
    httpStatus: res.status,
    providerErrorType: null,
    attempts: [],
  };
  const fail = (e: TagDraftAiError): never => {
    e.envelope = envelope;
    throw e;
  };
  /* eslint-disable @typescript-eslint/no-explicit-any */
  if (!res.ok) {
    envelope.providerErrorType = await res
      .json()
      .then((b: any) =>
        typeof b?.error?.type === "string" ? b.error.type : null,
      )
      .catch(() => null);
    if (
      res.status === 429 ||
      res.status === 529 ||
      envelope.providerErrorType === "overloaded_error"
    )
      fail(
        new TagDraftAiError(
          "AI service rate-limited.",
          res.status,
          true,
          parseRetryAfterMs(res.headers.get("retry-after")),
        ),
      );
    fail(
      new TagDraftAiError(
        `AI service error (${res.status}).`,
        res.status,
        false,
      ),
    );
  }
  let data: any;
  try {
    data = await res.json();
  } catch { // stale-safe: parse only
    fail(new TagDraftAiError("AI response body was not JSON.", 0, false));
  }
  envelope.attempts = extractEnvelope(data);
  if (data.stop_reason === "refusal")
    fail(new TagDraftAiError("The AI declined to draft rules.", 0, false));
  if (data.stop_reason === "max_tokens")
    fail(
      new TagDraftAiError("The AI draft was cut off (output limit).", 0, false),
    );
  const text: string = (data.content ?? [])
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("")
    .trim();
  /* eslint-enable @typescript-eslint/no-explicit-any */
  try {
    return { raw: JSON.parse(text), envelope };
  } catch { // stale-safe: parse only
    return fail(
      new TagDraftAiError("The AI draft was not valid JSON.", 0, false),
    );
  }
}

export const __forTests = { SYSTEM, buildUser };
