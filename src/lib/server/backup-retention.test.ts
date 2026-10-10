/**
 * td-cf46cf: dated retention for the nightly prod pg_dump
 * (scripts/lib/backup-retention.sh, sourced by scripts/backup-pg.sh). Runs the
 * real bash functions against a temp directory — no database, no SSH.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const LIB = path.resolve(__dirname, "../../../scripts/lib/backup-retention.sh");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function sh(script: string, ...args: string[]) {
  return execFileSync("bash", ["-c", `set -euo pipefail; source "$0"; ${script}`, LIB, ...args], {
    encoding: "utf8",
  });
}

/** Every day from `from` back `n` days, as yyyy-mm-dd (UTC). */
function daysBack(from: string, n: number): string[] {
  const t = Date.parse(`${from}T00:00:00Z`);
  return Array.from({ length: n }, (_, i) => new Date(t - i * 86_400_000).toISOString().slice(0, 10));
}

describe("backup retention (td-cf46cf)", () => {
  it("keeps the last 7 days plus Sundays younger than 35 days; leaves other files alone", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "birds-retention-"));
    dirs.push(dir);
    const today = "2026-10-10"; // a Saturday
    for (const d of daysBack(today, 60)) writeFileSync(path.join(dir, `birds-${d}.pgdump`), d);
    writeFileSync(path.join(dir, "notes.txt"), "not a dump");
    writeFileSync(path.join(dir, "birds-latest.pgdump"), "not dated");

    sh('prune_dated_dumps "$1" "$2"', dir, today);

    const kept = readdirSync(dir).sort();
    expect(kept).toEqual(
      [
        // last 7 days (age 0-6)
        ...daysBack(today, 7).map((d) => `birds-${d}.pgdump`),
        // Sundays aged 7-34: Oct 4 is age 6 (already above); Sep 27, 20, 13, 6
        "birds-2026-09-27.pgdump",
        "birds-2026-09-20.pgdump",
        "birds-2026-09-13.pgdump",
        "birds-2026-09-06.pgdump",
        "birds-latest.pgdump",
        "notes.txt",
      ].sort(),
    );
  });

  it("keep_dated_dump hard-links the verified dump, so a later replacement keeps the old bytes", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "birds-retention-"));
    dirs.push(dir);
    const dump = path.join(dir, "birds.pgdump");
    writeFileSync(dump, "night one");
    sh('keep_dated_dump "$1" "$2" "$3"', dump, path.join(dir, "history"), "2026-10-09");
    const linked = path.join(dir, "history", "birds-2026-10-09.pgdump");
    expect(statSync(linked).ino).toBe(statSync(dump).ino);
    // backup-pg.sh writes the next dump to a .tmp and mv's it into place.
    writeFileSync(`${dump}.tmp`, "night two");
    execFileSync("mv", ["-f", `${dump}.tmp`, dump]);
    expect(execFileSync("cat", [linked], { encoding: "utf8" })).toBe("night one");
    // Re-running the same day replaces that day's link (idempotent).
    sh('keep_dated_dump "$1" "$2" "$3"', dump, path.join(dir, "history"), "2026-10-09");
    expect(execFileSync("cat", [linked], { encoding: "utf8" })).toBe("night two");
  });

  it("a dump that can't be removed makes pruning fail, even when later files prune fine (CODEX1)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "birds-retention-"));
    dirs.push(dir);
    for (const d of ["2026-08-01", "2026-08-02", "2026-10-10"])
      writeFileSync(path.join(dir, `birds-${d}.pgdump`), d);
    // rm fails for one old dump only; the loop still reaches the other.
    const script =
      'rm() { if [[ "$*" == *2026-08-01* ]]; then return 1; fi; command rm "$@"; }; ' +
      'if prune_dated_dumps "$1" "$2"; then echo ok; else echo failed; fi';
    expect(sh(script, dir, "2026-10-10").trim()).toBe("failed");
    expect(readdirSync(dir).sort()).toEqual(["birds-2026-08-01.pgdump", "birds-2026-10-10.pgdump"]);
  });

  it("a missing history directory is not an error", () => {
    expect(() => sh('prune_dated_dumps "$1" "$2"', "/nonexistent/birds-history", "2026-10-10")).not.toThrow();
  });
});
