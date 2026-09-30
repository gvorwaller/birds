/**
 * Tokens and phrase matching for the tag engine.
 *
 * A token is a run of Unicode letters or digits; an apostrophe or hyphen
 * BETWEEN two letters/digits stays inside the token ("sea-going", "o'clock").
 * Tokens carry UTF-16 offsets into the (folded) text they came from.
 *
 * Matchers (plan §B7, deliberately small):
 *   literal — every phrase token equals the text token exactly.
 *   stem    — every phrase token equals the text token OR a regular English
 *             inflection of it: -s, -es, -ies (for -y), -ed, -d, -ing
 *             (including a doubled final consonant: "dive"/"diving",
 *             "stop"/"stopped"). No dictionary, no irregular forms: the
 *             ruleset lists irregular forms explicitly as extra phrases.
 *             This replaces the plan's Porter2 stemmer — no new dependency,
 *             fully deterministic, and conservative (fewer false matches).
 */

import { foldCase, normalizeDisplay } from "./normalize";

export interface Token {
  text: string;
  start: number;
  end: number;
}

const TOKEN = /[\p{L}\p{N}]+(?:['-][\p{L}\p{N}]+)*/gu;

export function tokenize(folded: string, base = 0): Token[] {
  const out: Token[] = [];
  for (const m of folded.matchAll(TOKEN)) {
    const start = base + (m.index ?? 0);
    out.push({ text: m[0], start, end: start + m[0].length });
  }
  return out;
}

/** Inflected forms a `stem` matcher accepts for one phrase word. */
export function inflections(word: string): Set<string> {
  const forms = new Set([word]);
  if (word.length < 3 || !/^[\p{L}]+$/u.test(word)) return forms;
  forms.add(word + "s");
  forms.add(word + "es");
  if (/[^aeiou]y$/.test(word)) {
    forms.add(word.slice(0, -1) + "ies");
    forms.add(word.slice(0, -1) + "ied");
  }
  const stemE = word.endsWith("e") ? word.slice(0, -1) : word;
  forms.add(stemE + "ing");
  forms.add(stemE + "ed");
  if (word.endsWith("e")) forms.add(word + "d");
  // Doubled final consonant after a single vowel: stop → stopping/stopped.
  if (/[^aeiou][aeiou][bdfgklmnprtvz]$/.test(word)) {
    const last = word[word.length - 1];
    forms.add(word + last + "ing");
    forms.add(word + last + "ed");
  }
  return forms;
}

export type MatcherType = "literal" | "stem";

/** Compile a phrase into per-position accepted token sets. */
export function compilePhrase(
  phrase: string,
  type: MatcherType,
): Set<string>[] {
  const words = tokenize(foldCase(normalizeDisplay(phrase))).map((t) => t.text);
  return words.map((w) => (type === "stem" ? inflections(w) : new Set([w])));
}

/** Every token index where `compiled` matches consecutive tokens. */
export function findPhrase(
  tokens: readonly Token[],
  compiled: readonly Set<string>[],
): number[] {
  const hits: number[] = [];
  if (compiled.length === 0) return hits;
  outer: for (let i = 0; i + compiled.length <= tokens.length; i++) {
    for (let j = 0; j < compiled.length; j++) {
      if (!compiled[j].has(tokens[i + j].text)) continue outer;
    }
    hits.push(i);
  }
  return hits;
}
