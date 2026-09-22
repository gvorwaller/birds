/**
 * Species loader returns the signed-in account's stored alert reports for
 * this species (td-48c22e). The row is owned by a disposable user.
 */
import { afterAll, describe, expect, it } from "vitest";
import { query } from "$lib/db";
import { load } from "./+page.server";

const dbUp = await query("SELECT 1")
  .then(() => true)
  .catch(() => false);
const CODE = "zalrt1";
const USER = `alert-evidence-${CODE}`;
let userId = 0;

async function cleanup() {
  if (userId) await query("DELETE FROM users WHERE id = $1", [userId]);
  await query("DELETE FROM taxonomy_cache WHERE species_code = $1", [CODE]);
}

describe.runIf(dbUp)("species loader stored alert reports", () => {
  afterAll(cleanup);

  it("returns the in-window checklist stored on the alert", async () => {
    await cleanup();
    const user = await query<{ id: number }>(
      `INSERT INTO users (username, display_name, password_hash, role)
       VALUES ($1, 'Alert evidence', '!unset', 'user') RETURNING id`,
      [USER],
    );
    userId = user.rows[0].id;
    await query(
      `INSERT INTO taxonomy_cache (species_code, com_name, sci_name, category, family)
       VALUES ($1, 'Alert Test Hawk', 'Testus alertus', 'species', 'Testidae')`,
      [CODE],
    );
    const seen = new Date();
    seen.setUTCDate(seen.getUTCDate() - 1);
    const obsDt = `${seen.toISOString().slice(0, 10)} 06:57`;
    await query(
      `INSERT INTO need_alert_log (user_id, species_code, title, body, url, reports)
       VALUES ($1, $2, 'Lifer nearby: Alert Test Hawk (unconfirmed)', 'body',
               'https://ebird.org/checklist/S123', $3::jsonb)`,
      [
        userId,
        CODE,
        JSON.stringify([
          {
            subId: "S123",
            locName: "Omni Amelia Island Plantation Resort",
            obsDt,
            distanceMi: 23,
          },
        ]),
      ],
    );

    const data = (await load({
      locals: { scopeId: userId, user: { id: userId, role: "user" } },
      params: { code: CODE },
      url: new URL(`http://127.0.0.1/species/${CODE}`),
      request: new Request(`http://127.0.0.1/species/${CODE}`),
      depends: () => {},
    } as unknown as Parameters<typeof load>[0])) as {
      alertReports: { subId: string; distanceMi: number; locName: string }[];
    };

    expect(data.alertReports).toEqual([
      expect.objectContaining({
        subId: "S123",
        locName: "Omni Amelia Island Plantation Resort",
        distanceMi: 23,
        obsDt,
      }),
    ]);
  });
});
