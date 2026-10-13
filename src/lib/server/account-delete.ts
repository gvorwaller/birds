/**
 * Settings → User admin → Delete account (td-12bd33).
 *
 * Deleting a `users` row cascades to everything the account owns (life list,
 * trips, eBird sign-in, alerts, sessions, searches, viewed history and its
 * visit receipts, usage days). The finished jobs it requested stay as history with no requester
 * (migration 0087). Refused when:
 * - the admin targets their own account;
 * - a viewer displays this account's life list (it would silently fall back to
 *   the viewer's own empty data) — reassign or delete the viewer first;
 * - one of its jobs is running (the worker is using its eBird key);
 * - it owns the app's scheduled background jobs (the lowest-id admin).
 * Its other pending jobs are cancelled in the same transaction. The job rows
 * are locked first, so the worker's SKIP LOCKED claim cannot start one
 * between the check and the delete; any job that slips past still fails the
 * 0087 CHECK and rolls the whole delete back.
 *
 * It holds job rows, so it is capped like every other job-row holder below
 * the queue's H = 120 s (job-claim.ts CLAIM_BOUNDS): a short lock wait and a
 * 30 s transaction cap. A lock it cannot get (a running cascade, a job row
 * another writer holds) rolls everything back as "busy, try again". After the
 * commit, this process's eBird web session for the account is dropped.
 */
import { withTransaction } from "$lib/db";
import { RECURRING_TYPES } from "$server/jobs";
import { invalidateEbirdSession } from "$server/ebird-account";

export type DeleteAccountRefusal =
  | { reason: "self" }
  | { reason: "not_found" }
  | { reason: "confirm" }
  | { reason: "viewers"; viewers: string[] }
  | { reason: "running" }
  | { reason: "system_jobs" }
  | { reason: "busy" };

export type DeleteAccountResult =
  | { ok: true; username: string; displayName: string; cancelledJobs: number }
  | ({ ok: false } & DeleteAccountRefusal);

/** Raised inside the transaction so it rolls back; carries the refusal out. */
class Refused extends Error {
  constructor(readonly refusal: DeleteAccountRefusal) {
    super(refusal.reason);
  }
}

const BUSY_CODES = new Set([
  "23514", // check_violation: a job became live under the account (0087)
  "23503", // foreign_key_violation
  "40P01", // deadlock_detected
  "55P03", // lock_not_available: lock_timeout
  "25P04", // transaction_timeout: Postgres ended the transaction, nothing committed
]);

export const DELETE_BOUNDS = Object.freeze({ lockTimeoutMs: 5_000, txTimeoutMs: 30_000 });

export async function deleteAccount(
  actorId: number,
  targetId: number,
  typedUsername: string,
  bounds: { lockTimeoutMs: number; txTimeoutMs: number } = DELETE_BOUNDS,
): Promise<DeleteAccountResult> {
  if (targetId === actorId) return { ok: false, reason: "self" };
  try {
    const result = await withTransaction(async (client) => {
      await client.query(`SET LOCAL lock_timeout = '${Math.round(bounds.lockTimeoutMs)}ms'`);
      await client.query(`SET LOCAL transaction_timeout = '${Math.round(bounds.txTimeoutMs)}ms'`);
      const target = await client.query<{ username: string; display_name: string }>(
        "SELECT username, display_name FROM users WHERE id = $1 FOR UPDATE",
        [targetId],
      );
      const row = target.rows[0];
      if (!row) throw new Refused({ reason: "not_found" });
      if (typedUsername.trim().toLowerCase() !== row.username) {
        throw new Refused({ reason: "confirm" });
      }
      const viewers = await client.query<{ display_name: string }>(
        "SELECT display_name FROM users WHERE views_user_id = $1 ORDER BY display_name",
        [targetId],
      );
      if (viewers.rowCount) {
        throw new Refused({ reason: "viewers", viewers: viewers.rows.map((v) => v.display_name) });
      }
      const live = await client.query<{ id: string; type: string; status: string }>(
        `SELECT id, type, status FROM jobs
          WHERE requested_by = $1 AND status IN ('pending', 'running')
          ORDER BY id FOR UPDATE`,
        [targetId],
      );
      if (live.rows.some((j) => j.status === "running")) throw new Refused({ reason: "running" });
      if (live.rows.some((j) => RECURRING_TYPES.has(j.type))) {
        throw new Refused({ reason: "system_jobs" });
      }
      const pendingIds = live.rows.map((j) => j.id);
      if (pendingIds.length) {
        await client.query(
          `UPDATE jobs SET status = 'cancelled', finished_at = NOW()
            WHERE id = ANY($1::bigint[]) AND status = 'pending'`,
          [pendingIds],
        );
        await client.query(
          `INSERT INTO job_events (job_id, action, details)
           SELECT id, 'cancelled', $2::jsonb FROM unnest($1::bigint[]) AS id`,
          [pendingIds, JSON.stringify({ when: "pending", requestedBy: actorId, reason: "account_deleted" })],
        );
      }
      await client.query("DELETE FROM users WHERE id = $1", [targetId]);
      return {
        ok: true as const,
        username: row.username,
        displayName: row.display_name,
        cancelledJobs: pendingIds.length,
      };
    });
    invalidateEbirdSession(targetId);
    return result;
  } catch (err) {
    if (err instanceof Refused) return { ok: false, ...err.refusal };
    const code = (err as { code?: string }).code;
    if (code && BUSY_CODES.has(code)) return { ok: false, reason: "busy" };
    throw err;
  }
}
