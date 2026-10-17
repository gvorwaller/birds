/**
 * td-a47c0d slice 1b: the backup marker. The shell half
 * (scripts/lib/backup-marker.sh, sourced by backup-pg.sh) runs as real bash
 * with no SSH; the SQL it prints is then run against birds_test as the
 * migration owner (prod runs it as postgres), and the Server health card
 * reads it back as the app role. The one 'backup' row is snapshotted and
 * restored, so a restored prod snapshot keeps its own marker.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { query } from "$lib/db";
import { BACKUP_STALE_HOURS, backupStatus, lastBackup } from "$server/system-health";

const LIB = path.resolve(__dirname, "../../../scripts/lib/backup-marker.sh");
function sh(script: string, ...args: string[]): string {
  return execFileSync("bash", ["-c", `set -euo pipefail; source "$0"; ${script}`, LIB, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 20_000,
  });
}

describe("backup_marker_sql", () => {
  it("prints one upsert of the backup row with the dump size", () => {
    expect(sh('backup_marker_sql "$1"', "6512345678")).toBe(
      "INSERT INTO ops_markers (name, at, bytes) VALUES ('backup', now(), 6512345678) " +
        "ON CONFLICT (name) DO UPDATE SET at = EXCLUDED.at, bytes = EXCLUDED.bytes;",
    );
  });

  it("accepts wc -c's padded count", () => {
    expect(sh('backup_marker_sql "$1"', "   42\n")).toContain("now(), 42)");
  });

  it.each(["", "12a", "1; DROP TABLE users", "-5"])("refuses a size that is not digits: %j", (bad) => {
    expect(() => sh('backup_marker_sql "$1"', bad)).toThrow();
  });

  it("refuses a bad port or database name before any SSH", () => {
    // `ssh` is shadowed so a regression that reached it would fail loudly.
    for (const [port, db] of [["54x", "birds"], ["5436", "birds; rm"]]) {
      expect(() =>
        sh('ssh() { echo "ssh reached" >&2; exit 99; }; record_backup_marker 1 host "$1" "$2"', port, db),
      ).toThrow(/status 1\b|Command failed/);
    }
  });
});

describe("run_with_deadline and the caller", () => {
  it("kills a command that outlives its deadline", () => {
    const started = Date.now();
    expect(() => sh("run_with_deadline 1 sleep 30")).toThrow();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(sh("run_with_deadline 5 true; echo ok").trim()).toBe("ok");
  });

  it("a hung marker write ends in a warning and the backup still succeeds", () => {
    // backup-pg.sh's own shape: set -euo pipefail, the call inside an if.
    const started = Date.now();
    const out = sh(
      `ssh() { exec sleep 30; }
       BACKUP_MARKER_DEADLINE_S=1
       if record_backup_marker 42 host 5436 birds -o BatchMode=yes; then echo recorded; else echo WARN; fi
       echo backup-ok`,
    );
    expect(out.trim().split("\n")).toEqual(["WARN", "backup-ok"]);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe("backupStatus", () => {
  const now = new Date("2026-10-17T12:00:00Z");
  it("is stale with no record", () => {
    expect(backupStatus(undefined, now)).toEqual({ at: null, bytes: null, stale: true, staleAfterHours: BACKUP_STALE_HOURS });
  });
  it("is current inside 26 hours and stale after", () => {
    expect(backupStatus({ at: "2026-10-16T11:00:00Z", bytes: "10" }, now)).toMatchObject({ stale: false, bytes: 10 });
    expect(backupStatus({ at: "2026-10-16T09:59:00Z", bytes: null }, now)).toMatchObject({ stale: true, bytes: null });
  });
});

const dbUp = await query("SELECT 1")
  .then(() => true)
  .catch(() => false);

function envTest(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(path.resolve(__dirname, "../../../.env.test"), "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
  }
  return out;
}

describe.skipIf(!dbUp)("ops_markers on birds_test", () => {
  const e = dbUp ? envTest() : {};
  const ownerClient = () =>
    new pg.Client({
      host: e.PGHOST ?? "127.0.0.1",
      port: Number(e.PGPORT ?? 15436),
      database: e.PGDATABASE ?? "birds_test",
      user: e.MIGRATION_PGUSER ?? "birds_owner",
      password: e.MIGRATION_PGPASSWORD,
    });
  let owner: InstanceType<typeof pg.Client> | null = null;
  // Restore or delete only after the snapshot was actually read: a failed
  // setup must never touch a real marker.
  let snapshot: { captured: false } | { captured: true; row: { at: string; bytes: string | null } | undefined } = {
    captured: false,
  };

  beforeAll(async () => {
    const c = ownerClient();
    await c.connect();
    owner = c;
    // Text, not a JS Date: restores the exact microseconds.
    const r = await c.query<{ at: string; bytes: string | null }>(
      `SELECT at::text AS at, bytes::text AS bytes FROM ops_markers WHERE name = 'backup'`,
    );
    snapshot = { captured: true, row: r.rows[0] };
  });

  afterAll(async () => {
    if (!owner) return;
    try {
      if (snapshot.captured && snapshot.row) {
        await owner.query(
          `INSERT INTO ops_markers (name, at, bytes) VALUES ('backup', $1::timestamptz, $2::bigint)
           ON CONFLICT (name) DO UPDATE SET at = EXCLUDED.at, bytes = EXCLUDED.bytes`,
          [snapshot.row.at, snapshot.row.bytes],
        );
      } else if (snapshot.captured) {
        await owner.query(`DELETE FROM ops_markers WHERE name = 'backup'`);
      }
    } finally {
      await owner.end();
    }
  });

  it("is read-only for the app role", async () => {
    await expect(
      query(`INSERT INTO ops_markers (name, at) VALUES ('backup', now()) ON CONFLICT (name) DO NOTHING`),
    ).rejects.toThrow(/permission denied/);
  });

  it("allows only known marker names", async () => {
    await expect(owner!.query(`INSERT INTO ops_markers (name, at) VALUES ('other', now())`)).rejects.toThrow(
      /check constraint/,
    );
  });

  it("reads back what the backup script writes, replacing the previous row", async () => {
    // The exact statement the script sends, timeouts included.
    await owner!.query(sh('backup_marker_remote_sql "$1"', "111"));
    await owner!.query(sh('backup_marker_remote_sql "$1"', "6512345678"));
    const b = await lastBackup();
    expect(b.bytes).toBe(6_512_345_678);
    expect(b.stale).toBe(false);
    expect(Date.now() - Date.parse(b.at!)).toBeLessThan(60_000);
    const n = await owner!.query(`SELECT COUNT(*)::int AS n FROM ops_markers`);
    expect(n.rows[0].n).toBe(1);
  });

  it("fails fast instead of waiting when another session holds the row", async () => {
    const holder = ownerClient();
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(`LOCK TABLE ops_markers IN ACCESS EXCLUSIVE MODE`);
      const started = Date.now();
      await expect(owner!.query(sh('backup_marker_remote_sql "$1"', "7"))).rejects.toThrow(/lock timeout/);
      expect(Date.now() - started).toBeLessThan(10_000);
      // The session's timeouts must not outlive the statement for this client.
      await owner!.query("RESET lock_timeout; RESET statement_timeout");
    } finally {
      await holder.query("ROLLBACK").catch(() => {});
      await holder.end();
    }
  }, 20_000);
});
