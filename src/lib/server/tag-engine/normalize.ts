/**
 * Text normalization for the tag engine (td-894144 Release B, plan rev 10 §B7).
 *
 * Two forms of every text:
 *   display  — NFC, with dashes, quotes and whitespace unified. Evidence is
 *              quoted from this form, so it keeps the article's own casing.
 *   folded   — the display form lower-cased ONE UTF-16 unit at a time, so it
 *              has exactly the same length and every offset maps 1:1 back to
 *              the display form. Matching runs on the folded form.
 *
 * Offsets are UTF-16 indices (JavaScript string indices) into the display
 * form; `display.slice(start, end)` is the quoted evidence.
 */
import { createHash } from "node:crypto";

const HYPHENS = /[\u2010\u2011]/g; // true hyphens, inside words
const DASHES = /[\u2012\u2013\u2014\u2015\u2212]/g; // clause-level dashes
const SINGLE_QUOTES = /[\u2018\u2019\u201A\u201B\u2032]/g; // curly/prime single quotes
const DOUBLE_QUOTES = /[\u201C\u201D\u201E\u201F\u2033]/g; // curly/prime double quotes
const SPACES = /[\s\u00A0\u2000-\u200B\u202F\u205F\u3000]+/g;

/** NFC, unified punctuation and single spaces, trimmed. */
export function normalizeDisplay(text: string): string {
  return text
    .normalize("NFC")
    .replace(HYPHENS, "-") // true hyphens stay word-internal: "sea-going"
    .replace(DASHES, "\u2014") // every clause-level dash becomes an em dash
    .replace(SINGLE_QUOTES, "'")
    .replace(DOUBLE_QUOTES, '"')
    .replace(SPACES, " ")
    .trim();
}

/**
 * Lower-case per UTF-16 unit, keeping the length identical. A unit whose
 * lower-case form is longer (e.g. U+0130 İ → "i̇") is kept as is; that only
 * affects matching of that one letter, never offsets.
 */
export function foldCase(display: string): string {
  let out = "";
  for (let i = 0; i < display.length; i++) {
    const ch = display[i];
    const lower = ch.toLowerCase();
    out += lower.length === 1 ? lower : ch;
  }
  return out;
}

/** SHA-256 hex of a canonical JSON value. */
export function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
