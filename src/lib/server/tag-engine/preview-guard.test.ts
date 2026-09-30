/**
 * td-894144 B5 (plan §3m/§3y): a code change to Preview or the engine must
 * ship with a new PREVIEW_SOURCE_HASH and a migration re-pinning
 * tag_preview_design — otherwise an old Preview would stay "current" after
 * the code that made it changed. Raw bytes (not comment-stripped: a regex
 * comment stripper also eats comment-looking text inside string literals).
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { query } from "$lib/db";
import { tagEvalDesign } from "./eval-design";
import { PREVIEW_SOURCE_HASH, previewDesignHash } from "./preview";

const FILES = [
  "normalize.ts",
  "tokens.ts",
  "segment.ts",
  "rules.ts",
  "scanner.ts",
  "taxon-check.ts",
  "preview.ts",
];
const DECL = /^export const PREVIEW_SOURCE_HASH = '[0-9a-f]{64}';$/;

/** Remove exactly one declaration line (and its terminator); throw on 0 or >1. */
export function withoutDeclaration(src: string): string {
  const lines = src.split("\n");
  const hits = lines
    .map((l, i) => (DECL.test(l.replace(/\r$/, "")) ? i : -1))
    .filter((i) => i >= 0);
  if (hits.length !== 1)
    throw new Error(
      `preview.ts must declare PREVIEW_SOURCE_HASH exactly once (found ${hits.length})`,
    );
  lines.splice(hits[0], 1);
  return lines.join("\n");
}

export function previewSourceHash(
  read: (f: string) => string = (f) =>
    readFileSync(new URL(`./${f}`, import.meta.url), "utf8"),
): string {
  const h = createHash("sha256");
  for (const f of FILES) {
    h.update(f + "\n", "utf8");
    const src = read(f);
    h.update(f === "preview.ts" ? withoutDeclaration(src) : src, "utf8");
  }
  return h.digest("hex");
}

describe("preview source guard", () => {
  it("PREVIEW_SOURCE_HASH matches the sources (update it AND re-pin tag_preview_design on any change)", () => {
    const actual = previewSourceHash();
    expect(
      PREVIEW_SOURCE_HASH,
      `set PREVIEW_SOURCE_HASH = '${actual}' in preview.ts, then re-pin tag_preview_design in a migration`,
    ).toBe(actual);
  });

  it("any byte change counts — comments and comment-looking text in literals included", () => {
    const real = (f: string) =>
      readFileSync(new URL(`./${f}`, import.meta.url), "utf8");
    const base = previewSourceHash(real);
    const edit = (patch: (s: string) => string) => (f: string) =>
      f === "scanner.ts" ? patch(real(f)) : real(f);
    expect(previewSourceHash(edit((s) => s + "\n// a comment"))).not.toBe(base);
    expect(
      previewSourceHash(edit((s) => s + '\nconst x = "/* not a comment */";')),
    ).not.toBe(base);
    const other = (f: string) =>
      f === "preview.ts"
        ? real(f).replace(
            /^export const PREVIEW_SOURCE_HASH = '[0-9a-f]{64}';$/m,
            `export const PREVIEW_SOURCE_HASH = '${"0".repeat(64)}';`,
          )
        : real(f);
    expect(previewSourceHash(other)).toBe(base);
  });

  it("the declaration must appear exactly once", () => {
    expect(() => withoutDeclaration("const a = 1;")).toThrow(/exactly once/);
    const d = `export const PREVIEW_SOURCE_HASH = '${"a".repeat(64)}';`;
    expect(() => withoutDeclaration(`${d}\n${d}`)).toThrow(/found 2/);
    expect(withoutDeclaration(`x\n${d}\ny`)).toBe("x\ny");
    expect(withoutDeclaration(`x\r\n${d}\r\ny`)).toBe("x\r\ny");
  });
});

const dbUp = await query("SELECT to_regclass('public.tag_preview_design') IS NOT NULL AS ok")
  .then((r) => r.rows[0].ok === true)
  .catch(() => false);

describe.runIf(dbUp)("preview design pin", () => {
  it("the SQL-pinned design hash is exactly what this code computes (open ocean)", async () => {
    const tag = "habitat:open-ocean";
    const pinned = (
      await query<{ design_hash: string }>(
        "SELECT design_hash FROM tag_preview_design WHERE tag = $1",
        [tag],
      )
    ).rows[0]?.design_hash;
    const actual = previewDesignHash(tag, tagEvalDesign(tag)!);
    expect(pinned, `re-pin tag_preview_design for ${tag} to '${actual}' in a migration`).toBe(actual);
  });
});
