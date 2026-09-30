/**
 * Ruleset format and loader (td-894144 Release B, plan rev 10 §B7/B8).
 *
 * A ruleset decides ONE tag. It is plain JSON so a human can read it on the
 * admin Tags tab, an AI can PROPOSE one, and a reviewer can diff it. It is
 * only ever executed after the owner approves it (B8) — this loader just
 * guarantees that whatever is executed is well-formed and bounded.
 *
 * Decision order for a species (see scanner.ts):
 *   1. taxon rules — `forbid` hit → not_assigned(taxon_forbid);
 *      `require_one_of` not met → not_assigned(requires_unmet), or
 *      unevaluated(taxon_unknown) when the species' rank value is unknown.
 *   2. support phrases in scanned sections, about the focal species,
 *      each possibly cancelled by an exclude phrase BOUND to its group.
 *   3. assigned iff at least one support match survives.
 * No weights, no regex (first release).
 */
import { foldCase, normalizeDisplay } from "./normalize";
import { tokenize, type MatcherType } from "./tokens";

export type Scope =
  | { unit: "clause" }
  | { unit: "sentence" }
  | { unit: "window"; before: number; after: number };

export interface SupportRule {
  id: string;
  group: string;
  match: { type: MatcherType; phrase: string };
  /** Why this phrase is evidence — shown to reviewers and the owner. */
  note: string;
}

export interface ExcludeRule {
  id: string;
  /** Support groups this cancels; ['*'] = every group. */
  binds: string[];
  match: { type: MatcherType; phrase: string };
  /** Where, relative to a support match, this phrase cancels it. */
  scope: Scope;
  note: string;
}

export interface TaxonRule {
  id: string;
  rank: "order" | "family";
  values: string[];
  action: "require_one_of" | "forbid";
  note: string;
}

export interface Ruleset {
  schema: 1;
  tag: string;
  /** Human revision label, e.g. "r1". Identity is the file's SHA-256. */
  rev: string;
  /** Section headings containing any of these are not scanned. */
  denySections: string[];
  /** Clause-start markers that make a clause about something else. */
  comparisonMarkers: string[];
  support: SupportRule[];
  exclude: ExcludeRule[];
  taxon: TaxonRule[];
}

export class RulesetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RulesetError";
  }
}

const LIMITS = {
  rules: 500,
  phraseChars: 80,
  phraseWords: 6,
  window: 12,
  values: 200,
  bytes: 512 * 1024,
};

function exactKeys(
  obj: unknown,
  keys: readonly string[],
  where: string,
): Record<string, unknown> {
  if (!obj || typeof obj !== "object" || Array.isArray(obj))
    throw new RulesetError(`${where}: not an object`);
  const o = obj as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => !keys.includes(k));
  if (extra.length)
    throw new RulesetError(`${where}: unknown field(s) ${extra.join(", ")}`);
  for (const k of keys)
    if (!(k in o)) throw new RulesetError(`${where}: missing ${k}`);
  return o;
}

function str(v: unknown, where: string, max = 200): string {
  if (typeof v !== "string" || !v.trim() || v.length > max)
    throw new RulesetError(`${where}: bad string`);
  return v.trim();
}

// Rule ids are persisted inside bounded species_tag_state.reason values.
// Keep this grammar identical to migration 0066's reason CHECK so every
// ruleset accepted here remains recordable by the database.
function ruleId(v: unknown, where: string): string {
  const id = str(v, where, 40);
  if (!/^[A-Za-z0-9_.-]+$/.test(id))
    throw new RulesetError(`${where}: bad rule id`);
  return id;
}

function strList(v: unknown, where: string, max: number): string[] {
  if (!Array.isArray(v) || v.length > max)
    throw new RulesetError(`${where}: bad list`);
  return v.map((x, i) => str(x, `${where}[${i}]`));
}

function phrase(
  v: unknown,
  where: string,
): { type: MatcherType; phrase: string } {
  const m = exactKeys(v, ["type", "phrase"], where);
  if (m.type !== "literal" && m.type !== "stem")
    throw new RulesetError(`${where}: matcher must be literal or stem`);
  const p = str(m.phrase, `${where}.phrase`, LIMITS.phraseChars);
  const words = tokenize(foldCase(normalizeDisplay(p))).length;
  if (words === 0) throw new RulesetError(`${where}: phrase has no tokens`);
  if (words > LIMITS.phraseWords)
    throw new RulesetError(
      `${where}: phrase longer than ${LIMITS.phraseWords} words`,
    );
  return { type: m.type, phrase: p };
}

function scope(v: unknown, where: string): Scope {
  if (!v || typeof v !== "object")
    throw new RulesetError(`${where}: bad scope`);
  const u = (v as Record<string, unknown>).unit;
  if (u === "clause" || u === "sentence") {
    exactKeys(v, ["unit"], where);
    return { unit: u };
  }
  if (u === "window") {
    const o = exactKeys(v, ["unit", "before", "after"], where);
    const ok = (n: unknown) =>
      Number.isInteger(n) &&
      (n as number) >= 0 &&
      (n as number) <= LIMITS.window;
    if (!ok(o.before) || !ok(o.after))
      throw new RulesetError(`${where}: window must be 0–${LIMITS.window}`);
    return {
      unit: "window",
      before: o.before as number,
      after: o.after as number,
    };
  }
  throw new RulesetError(`${where}: unknown scope unit`);
}

/** Validate untrusted JSON into a Ruleset. Throws RulesetError. */
export function parseRuleset(
  raw: unknown,
  allTags: ReadonlySet<string>,
): Ruleset {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(raw);
  } catch {
    throw new RulesetError("ruleset: not a JSON value");
  }
  if (
    encoded === undefined ||
    new TextEncoder().encode(encoded).byteLength > LIMITS.bytes
  )
    throw new RulesetError(`ruleset: larger than ${LIMITS.bytes} bytes`);
  const r = exactKeys(
    raw,
    [
      "schema",
      "tag",
      "rev",
      "denySections",
      "comparisonMarkers",
      "support",
      "exclude",
      "taxon",
    ],
    "ruleset",
  );
  if (r.schema !== 1) throw new RulesetError("ruleset: unsupported schema");
  const tag = str(r.tag, "ruleset.tag");
  if (!allTags.has(tag)) throw new RulesetError(`ruleset: unknown tag ${tag}`);
  const ids = new Set<string>();
  const claim = (id: string, where: string) => {
    if (ids.has(id)) throw new RulesetError(`${where}: duplicate id ${id}`);
    ids.add(id);
    return id;
  };
  if (
    !Array.isArray(r.support) ||
    !Array.isArray(r.exclude) ||
    !Array.isArray(r.taxon)
  )
    throw new RulesetError("ruleset: support/exclude/taxon must be lists");
  if (r.support.length + r.exclude.length + r.taxon.length > LIMITS.rules)
    throw new RulesetError(`ruleset: more than ${LIMITS.rules} rules`);
  if (r.support.length === 0)
    throw new RulesetError("ruleset: needs at least one support rule");

  const support = r.support.map((s, i) => {
    const o = exactKeys(s, ["id", "group", "match", "note"], `support[${i}]`);
    return {
      id: claim(ruleId(o.id, `support[${i}].id`), `support[${i}]`),
      group: str(o.group, `support[${i}].group`, 40),
      match: phrase(o.match, `support[${i}].match`),
      note: str(o.note, `support[${i}].note`, 400),
    };
  });
  const groups = new Set(support.map((s) => s.group));
  const exclude = r.exclude.map((x, i) => {
    const o = exactKeys(
      x,
      ["id", "binds", "match", "scope", "note"],
      `exclude[${i}]`,
    );
    const binds = strList(o.binds, `exclude[${i}].binds`, 50);
    if (binds.length === 0)
      throw new RulesetError(`exclude[${i}]: binds no support group`);
    if (new Set(binds).size !== binds.length)
      throw new RulesetError(`exclude[${i}]: duplicate bind`);
    for (const b of binds)
      if (b !== "*" && !groups.has(b))
        throw new RulesetError(`exclude[${i}]: binds unknown group ${b}`);
    return {
      id: claim(ruleId(o.id, `exclude[${i}].id`), `exclude[${i}]`),
      binds,
      match: phrase(o.match, `exclude[${i}].match`),
      scope: scope(o.scope, `exclude[${i}].scope`),
      note: str(o.note, `exclude[${i}].note`, 400),
    };
  });
  const taxon = r.taxon.map((t, i) => {
    const o = exactKeys(
      t,
      ["id", "rank", "values", "action", "note"],
      `taxon[${i}]`,
    );
    if (o.rank !== "order" && o.rank !== "family")
      throw new RulesetError(`taxon[${i}]: rank must be order or family`);
    if (o.action !== "require_one_of" && o.action !== "forbid")
      throw new RulesetError(`taxon[${i}]: bad action`);
    const values = strList(o.values, `taxon[${i}].values`, LIMITS.values);
    if (values.length === 0) throw new RulesetError(`taxon[${i}]: no values`);
    return {
      id: claim(ruleId(o.id, `taxon[${i}].id`), `taxon[${i}]`),
      rank: o.rank,
      values,
      action: o.action,
      note: str(o.note, `taxon[${i}].note`, 400),
    } as TaxonRule;
  });
  const denySections = strList(r.denySections, "ruleset.denySections", 50).map(
    (s) => foldCase(normalizeDisplay(s)),
  );
  const comparisonMarkers = strList(
    r.comparisonMarkers,
    "ruleset.comparisonMarkers",
    50,
  ).map((s, i) => {
    const marker = foldCase(normalizeDisplay(s));
    if (tokenize(marker).length === 0)
      throw new RulesetError(
        `ruleset.comparisonMarkers[${i}]: marker has no tokens`,
      );
    return marker;
  });
  return {
    schema: 1,
    tag,
    rev: str(r.rev, "ruleset.rev", 40),
    denySections,
    comparisonMarkers,
    support,
    exclude,
    taxon,
  };
}
