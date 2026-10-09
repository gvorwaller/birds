/**
 * td-b99b6d §4.8 (G9): the ebird_cache upsert is ordered by fetch START, so
 * an older in-flight fetch — a slow web request, or a stale worker
 * continuation — can never overwrite a row stored by a fetch that started
 * after it. The in-process coalescing map cannot see another process or
 * request, which is why the order lives in SQL. Real birds_test; one owned
 * JOBTEST: key, deleted exactly.
 */
import { afterAll, describe, expect, it } from "vitest";
import { query } from "$lib/db";
import { __cachedFetchUncoalescedForTests as fetchUncoalesced } from "./ebird";

const RUN = `${process.pid.toString(36)}${Date.now().toString(36).slice(-6)}`;
const KEY = `JOBTEST:ebird-cache:${RUN}`;
const dbUp = await query("SELECT 1")
  .then(() => true)
  .catch(() => false);
const stored = async () =>
  (
    await query<{ payload: unknown }>(
      "SELECT payload FROM ebird_cache WHERE cache_key = $1",
      [KEY],
    )
  ).rows[0]?.payload ?? null;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.runIf(dbUp).sequential("ebird_cache freshness ordering", () => {
  afterAll(async () => {
    await query("DELETE FROM ebird_cache WHERE cache_key = $1", [KEY]);
  });

  it("the fetch that started first and finished last does not overwrite the newer row", async () => {
    let releaseOld!: () => void;
    const oldGate = new Promise<void>((r) => (releaseOld = r));
    const older = fetchUncoalesced(
      KEY,
      0,
      async () => {
        await oldGate;
        return { from: "older" };
      },
      (v) => v,
    );
    await sleep(30);
    const newer = await fetchUncoalesced(
      KEY,
      0,
      async () => ({ from: "newer" }),
      (v) => v,
    );
    expect(newer.data).toEqual({ from: "newer" });
    expect(await stored()).toEqual({ from: "newer" });
    await sleep(30);
    releaseOld();
    const late = await older;
    expect(late.data).toEqual({ from: "older" }); // the caller still gets what it fetched
    expect(await stored()).toEqual({ from: "newer" }); // …but the newer row stands
  });

  it("an ordinary refresh of an older row still overwrites it", async () => {
    await query(
      "UPDATE ebird_cache SET fetched_at = NOW() - interval '1 day' WHERE cache_key = $1",
      [KEY],
    );
    const fresh = await fetchUncoalesced(
      KEY,
      0,
      async () => ({ from: "refresh" }),
      (v) => v,
    );
    expect(fresh.stale).toBe(false);
    expect(await stored()).toEqual({ from: "refresh" });
  });
});
