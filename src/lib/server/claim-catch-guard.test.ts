/**
 * td-b99b6d (spec §4.6): the catch rule for claim fencing, enforced by
 * DISCOVERY rather than a hand-kept list. Every `catch` under src/lib/server
 * (runtime code; tests and *.test-helper.ts excluded) must either rethrow a
 * lost claim as its first statement —
 *
 *   if (isStaleClaim(err)) throw err;      (other `||` terms allowed)
 *
 * — or carry a `// stale-safe: <reason>` annotation on the catch line. A
 * catch that swallows or classifies a StaleClaimError would turn a stale
 * execution's refusal into a unit failure, a failure write, or "try the next
 * source", and the execution would keep going. A binding-less `catch {}`
 * cannot rethrow, so it must be annotated.
 *
 * The same scan pins the two fence owners: `assertClaimHeldTx(` lives only in
 * job-claim.ts and tag-engine/runtime.ts (withClaimTx / withTagWriteTx), and
 * the unfenced `recordQueueEvent(` only in jobs.ts.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = new URL("../../../", import.meta.url).pathname;
const SERVER = join(ROOT, "src/lib/server");

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

/** Skip whitespace and comments from `i`; returns the index of the next code character. */
function skipTrivia(src: string, i: number): number {
  for (;;) {
    while (i < src.length && /\s/.test(src[i])) i++;
    if (src.startsWith("//", i)) {
      const nl = src.indexOf("\n", i);
      i = nl < 0 ? src.length : nl + 1;
    } else if (src.startsWith("/*", i)) {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? src.length : end + 2;
    } else return i;
  }
}

/** Every catch clause in `src` that breaks the rule, as "line N: reason". */
export function catchViolations(src: string): string[] {
  const out: string[] = [];
  const re = /(?<![.\w$])catch\s*(?:\(\s*([A-Za-z_$][\w$]*)\s*\))?\s*\{/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const line = src.slice(0, m.index).split("\n").length;
    const lineEnd = src.indexOf("\n", m.index);
    const catchLine = src.slice(m.index, lineEnd < 0 ? src.length : lineEnd);
    if (/\/\/\s*stale-safe:\s*\S/.test(catchLine)) continue;
    const id = m[1];
    if (!id) {
      out.push(
        `line ${line}: binding-less catch needs a // stale-safe: annotation`,
      );
      continue;
    }
    const body = src.slice(skipTrivia(src, m.index + m[0].length));
    const first = new RegExp(
      `^if\\s*\\((?:[^;{]*\\|\\|\\s*)?isStaleClaim\\(\\s*${id.replace(/\$/g, "\\$")}\\s*\\)(?:\\s*\\|\\|[^;{]*)?\\)\\s*throw\\s+${id.replace(/\$/g, "\\$")}\\s*;`,
    );
    if (!first.test(body))
      out.push(
        `line ${line}: first statement must be if (isStaleClaim(${id})) throw ${id};`,
      );
  }
  return out;
}

describe("catch discovery: the self-test", () => {
  it("rejects a bare catch, a late rethrow, and a swallow; accepts the rule and the annotation", () => {
    expect(catchViolations("try { a(); } catch {}")).toHaveLength(1);
    expect(
      catchViolations(
        "try { a(); } catch (e) { foo(); if (isStaleClaim(e)) throw e; }",
      ),
    ).toHaveLength(1);
    expect(
      catchViolations("try { a(); } catch (err) { log(err); }"),
    ).toHaveLength(1);
    expect(
      catchViolations(
        "try { a(); } catch (err) {\n  if (isStaleClaim(err)) throw err;\n  log(err);\n}",
      ),
    ).toEqual([]);
    expect(
      catchViolations(
        "try { a(); } catch (err) {\n  // why\n  /* and */ if (err instanceof X || isStaleClaim(err)) throw err;\n}",
      ),
    ).toEqual([]);
    expect(
      catchViolations("try { a(); } catch { // stale-safe: parse only\n}"),
    ).toEqual([]);
    expect(
      catchViolations(
        "try { a(); } catch (e) { // stale-safe: rethrows\n throw e; }",
      ),
    ).toEqual([]);
    // An annotation without a reason does not count.
    expect(
      catchViolations("try { a(); } catch { // stale-safe:\n}"),
    ).toHaveLength(1);
    // Rethrowing a different binding is not the rule.
    expect(
      catchViolations(
        "try { a(); } catch (e) { if (isStaleClaim(err)) throw err; }",
      ),
    ).toHaveLength(1);
    // Promise .catch handlers are not catch clauses.
    expect(
      catchViolations("p.catch((e) => { log(e); }); p.catch(() => {});"),
    ).toEqual([]);
  });
});

describe("catch discovery: src/lib/server", () => {
  const files = walk(SERVER).filter((p) => !isTestFile(p));

  it("finds the modules it must audit", () => {
    const rel = files.map((f) => relative(SERVER, f));
    for (const f of [
      "jobs.ts",
      "job-handlers.ts",
      "family-enrichment.ts",
      "family-source-discovery.ts",
      "tag-engine/runtime.ts",
    ])
      expect(rel).toContain(f);
  });

  /**
   * Catches in source files whose BYTES are pinned (tag-engine/preview-guard:
   * any edit needs a new PREVIEW_SOURCE_HASH plus a migration re-pinning
   * tag_preview_design; engine-guard: a new scanner_rev re-materializes every
   * species). They cannot carry an inline annotation, so they are listed here
   * by exact catch line, each with its reason. A NEW catch in these files is
   * still reported.
   */
  const PINNED: Record<string, { line: RegExp; reason: string }[]> = {
    "tag-engine/rules.ts": [
      {
        line: /^\s*\} catch \{$/,
        reason:
          "parseRuleset's JSON.stringify guard — parse only, no fenced call inside",
      },
    ],
  };

  it("every catch rethrows a lost claim first or says why it is stale-safe", () => {
    const problems = files.flatMap((f) => {
      const src = readFileSync(f, "utf8");
      const lines = src.split("\n");
      const allowed = [...(PINNED[relative(SERVER, f)] ?? [])];
      return catchViolations(src)
        .filter((v) => {
          const n = Number(/^line (\d+)/.exec(v)?.[1]);
          const i = allowed.findIndex((a) => a.line.test(lines[n - 1] ?? ""));
          if (i < 0) return true;
          allowed.splice(i, 1); // each listed catch excuses exactly one
          return false;
        })
        .map((v) => `${relative(ROOT, f)} ${v}`);
    });
    expect(problems).toEqual([]);
  });
});

describe("fence owners", () => {
  const runtime = [
    ...walk(join(ROOT, "src")),
    ...walk(join(ROOT, "scripts")),
  ].filter((p) => !isTestFile(p));
  const users = (needle: string) =>
    runtime
      .filter((f) => readFileSync(f, "utf8").includes(needle))
      .map((f) => relative(ROOT, f))
      .sort();

  it("assertClaimHeldTx( only in withClaimTx's module and withTagWriteTx's", () => {
    expect(users("assertClaimHeldTx(")).toEqual([
      "src/lib/server/job-claim.ts",
      "src/lib/server/tag-engine/runtime.ts",
    ]);
  });

  it("the unfenced recordQueueEvent( only inside the queue itself", () => {
    expect(users("recordQueueEvent(")).toEqual(["src/lib/server/jobs.ts"]);
  });
});
