/**
 * td-894144 static guard — REGRESSION defense for "AI never changes a tag".
 * The database grants (migration 0065, tag-safety-db.test.ts) are the
 * security control; this catches a code change that would reintroduce a
 * tags write before it ever reaches a database.
 *
 * Scope: non-test runtime source in src/ and scripts/ (TypeScript,
 * JavaScript—including ESM/CommonJS—and Svelte),
 * excluding test files and *.test-helper.ts fixtures. Migrations are not
 * runtime code and are excluded.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = new URL("../../../", import.meta.url).pathname;
const PROTECTED = ["tags", "legacy_tags", "search_tsv"];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(?:[cm]?[jt]s|svelte)$/.test(name)) out.push(p);
  }
  return out;
}

const isTestFile = (p: string) =>
  /\.test\.(ts|js)$/.test(p) || /\.test-helper\.ts$/.test(p);
const runtimeFiles = [
  ...walk(join(ROOT, "src")),
  ...walk(join(ROOT, "scripts")),
].filter((p) => !isTestFile(p));

/** Every template/quoted string literal in a file that mentions species_enrichment. */
function sqlStrings(src: string): string[] {
  const out: string[] = [];
  const re = /`[^`]*`|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    if (/species_enrichment/i.test(m[0])) out.push(m[0]);
  }
  return out;
}

/** Protected columns named as INSERT targets or UPDATE SET targets. */
export function protectedWrites(sql: string): string[] {
  const hits: string[] = [];
  const flat = sql.replace(/\s+/g, " ");
  for (const m of flat.matchAll(
    /insert\s+into\s+(?:public\.)?species_enrichment\s*(?:as\s+\w+\s*)?\(([^)]*)\)/gi,
  )) {
    for (const col of m[1]
      .split(",")
      .map((c) => c.trim().replace(/"/g, "").toLowerCase())) {
      if (PROTECTED.includes(col)) hits.push(`insert:${col}`);
    }
  }
  // SET targets: "SET col =" or ", col =" (optionally alias-qualified), in any
  // UPDATE of species_enrichment or an ON CONFLICT DO UPDATE on it.
  if (/update\s+(?:public\.)?species_enrichment|on\s+conflict/i.test(flat)) {
    for (const m of flat.matchAll(
      /(?:\bset\b|,)\s*(?:\w+\.)?"?(tags|legacy_tags|search_tsv)"?\s*=(?!=)/gi,
    )) {
      hits.push(`set:${m[1].toLowerCase()}`);
    }
  }
  return hits;
}

describe("td-894144 static guard", () => {
  it("the detector itself catches the shapes it must (self-test)", () => {
    expect(
      protectedWrites(
        "INSERT INTO species_enrichment (species_code, tags) VALUES ($1,$2)",
      ),
    ).toEqual(["insert:tags"]);
    expect(
      protectedWrites(
        `UPDATE species_enrichment SET\n  field_craft = $2,\n  TAGS = $3`,
      ),
    ).toEqual(["set:tags"]);
    expect(
      protectedWrites("UPDATE species_enrichment se SET se.search_tsv = x"),
    ).toEqual(["set:search_tsv"]);
    expect(
      protectedWrites(
        "INSERT INTO species_enrichment (species_code) VALUES ($1) ON CONFLICT (species_code) DO UPDATE SET legacy_tags = $2",
      ),
    ).toEqual(["set:legacy_tags"]);
    // Reads and comparisons are fine.
    expect(
      protectedWrites("SELECT tags FROM species_enrichment WHERE tags @> $1"),
    ).toEqual([]);
    expect(
      protectedWrites(
        "UPDATE species_enrichment SET wiki_status = 'ok' WHERE tags IS NULL",
      ),
    ).toEqual([]);
  });

  it("scans every runtime script extension used by the repository", () => {
    const scriptExtensions = new Set(
      walk(join(ROOT, "scripts")).map((p) =>
        p.slice(p.lastIndexOf(".")).toLowerCase(),
      ),
    );
    for (const ext of [".js", ".mjs"]) {
      if (scriptExtensions.has(ext)) {
        expect(
          runtimeFiles.some(
            (p) => p.startsWith(join(ROOT, "scripts")) && p.endsWith(ext),
          ),
        ).toBe(true);
      }
    }
  });

  it("no runtime SQL writes tags, legacy_tags or search_tsv", () => {
    const offenders: string[] = [];
    for (const f of runtimeFiles) {
      for (const s of sqlStrings(readFileSync(f, "utf8"))) {
        for (const hit of protectedWrites(s))
          offenders.push(`${relative(ROOT, f)} ${hit}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("AI modules import nothing from the tag vocabulary or validation", () => {
    const aiModules = runtimeFiles.filter((f) =>
      /\/(ai-[\w-]+|family-enrichment-ai)\.ts$/.test(f),
    );
    expect(aiModules.length).toBeGreaterThan(3);
    for (const f of aiModules) {
      const src = readFileSync(f, "utf8");
      expect(src, relative(ROOT, f)).not.toMatch(
        /from ['"][^'"]*species-tags['"]/,
      );
      expect(src, relative(ROOT, f)).not.toMatch(
        /\b(validateTags|TAG_VOCABULARY|ALL_TAGS)\b/,
      );
    }
  });

  it("test-helper fixtures are imported only by test files", () => {
    const offenders = runtimeFiles.filter((f) =>
      /test-helper/.test(readFileSync(f, "utf8")),
    );
    expect(offenders.map((f) => relative(ROOT, f))).toEqual([]);
  });
});
