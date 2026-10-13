/**
 * td-fb6948: `state = { ...state, [key]: await x }` copies `state` BEFORE the
 * await and writes that stale copy back after it, wiping every key another
 * request added in between. On Hotspots & data that left groups stuck on
 * "Loading …" forever whenever many were open at once. Await first, then
 * spread the CURRENT state.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(process.cwd(), "src");
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return files(p);
    return /\.(svelte|ts)$/.test(name) && !/\.test\.ts$/.test(name) ? [p] : [];
  });
}

describe("no state spread across an await (td-fb6948)", () => {
  it("never assigns `x = { ...x, … await … }`", () => {
    const offenders: string[] = [];
    for (const f of files(ROOT)) {
      const text = readFileSync(f, "utf8");
      for (const m of text.matchAll(/\b([A-Za-z_$][\w$]*)\s*=\s*\{\s*\.\.\.\1\b[^;]*?\bawait\b/g)) {
        const line = text.slice(0, m.index).split("\n").length;
        offenders.push(`${relative(process.cwd(), f)}:${line}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the guard catches the original Hotspots & data line", () => {
    const bad = "groupDetail = { ...groupDetail, [code]: (await res.json()) as GroupDetail };";
    expect(/\b([A-Za-z_$][\w$]*)\s*=\s*\{\s*\.\.\.\1\b[^;]*?\bawait\b/.test(bad)).toBe(true);
    const good = "const detail = (await res.json()) as GroupDetail;\ngroupDetail = { ...groupDetail, [code]: detail };";
    expect(/\b([A-Za-z_$][\w$]*)\s*=\s*\{\s*\.\.\.\1\b[^;]*?\bawait\b/.test(good)).toBe(false);
  });
});
