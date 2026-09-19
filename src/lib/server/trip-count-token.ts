import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "$env/dynamic/private";
import { parseTripCountContext, type TripCountContext } from "$lib/trip-count-context";

const DOMAIN = "birds:trip-count:v1";
const TOKEN_VERSION = 1;

export interface TripCountTokenPayload {
  version: 1;
  accountId: number;
  scopeOwnerId: number;
  context: TripCountContext;
  expiresAt: number;
}

export class TripCountTokenError extends Error {
  constructor(message = "Trip preview expired or changed — re-run the plan before saving.") {
    super(message);
    this.name = "TripCountTokenError";
  }
}

function secret(): string {
  if (!env.AUTH_SECRET) throw new Error("AUTH_SECRET is not set — cannot issue trip count snapshots");
  return env.AUTH_SECRET;
}

function sign(bytes: Buffer): Buffer {
  return createHmac("sha256", secret()).update(DOMAIN).update(bytes).digest();
}

function decode(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new TripCountTokenError();
  const bytes = Buffer.from(value, "base64url");
  if (!bytes.length || bytes.toString("base64url") !== value) throw new TripCountTokenError();
  return bytes;
}

export function issueTripCountToken(
  accountId: number,
  scopeOwnerId: number,
  context: TripCountContext,
): string {
  if (!Number.isSafeInteger(accountId) || accountId <= 0 || !Number.isSafeInteger(scopeOwnerId) || scopeOwnerId <= 0) {
    throw new TripCountTokenError("Cannot issue a trip count snapshot for this account.");
  }
  const valid = parseTripCountContext(context);
  if (!valid) throw new TripCountTokenError("Cannot issue an invalid trip count snapshot.");
  const plannedAt = Date.parse(valid.plannedAt);
  const expiresAt = plannedAt + 24 * 60 * 60 * 1000;
  const payload: TripCountTokenPayload = { version: TOKEN_VERSION, accountId, scopeOwnerId, context: valid, expiresAt };
  const bytes = Buffer.from(JSON.stringify(payload), "utf8");
  return `${bytes.toString("base64url")}.${sign(bytes).toString("base64url")}`;
}

export function verifyTripCountToken(
  token: unknown,
  accountId: number,
  scopeOwnerId: number,
  now = Date.now(),
): TripCountTokenPayload {
  if (typeof token !== "string") throw new TripCountTokenError();
  const pieces = token.split(".");
  if (pieces.length !== 2) throw new TripCountTokenError();
  const bytes = decode(pieces[0]);
  const actual = decode(pieces[1]);
  const expected = sign(bytes);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new TripCountTokenError();
  let raw: unknown;
  try { raw = JSON.parse(bytes.toString("utf8")); } catch { throw new TripCountTokenError(); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new TripCountTokenError();
  const x = raw as Record<string, unknown>;
  if (Object.keys(x).some((key) => !["version", "accountId", "scopeOwnerId", "context", "expiresAt"].includes(key))) throw new TripCountTokenError();
  if (x.version !== TOKEN_VERSION || x.accountId !== accountId || x.scopeOwnerId !== scopeOwnerId) throw new TripCountTokenError();
  if (!Number.isSafeInteger(x.expiresAt) || (x.expiresAt as number) <= now || (x.expiresAt as number) !== Date.parse(String((x.context as Record<string, unknown> | null)?.plannedAt)) + 24 * 60 * 60 * 1000) throw new TripCountTokenError();
  const context = parseTripCountContext(x.context);
  if (!context || Date.parse(context.plannedAt) + 24 * 60 * 60 * 1000 !== x.expiresAt) throw new TripCountTokenError();
  return { version: 1, accountId, scopeOwnerId, context, expiresAt: x.expiresAt as number };
}
