/** Honor the app's existing pause and service-cooldown controls during operator work. */
import { execFileSync } from "node:child_process";
let lastCheck = 0,
  paused = false;
export class QualityRunPaused extends Error {}
export async function qualityRunPaused() {
  if (Date.now() - lastCheck < 5000) return paused;
  if (!process.env.BIRDS_DROPLET_SSH)
    throw new QualityRunPaused("Production control connection is required");
  const code = `import pg from 'pg';const c=new pg.Client({options:'-c default_transaction_read_only=on'});await c.connect();try{const r=(await c.query("SELECT f.paused OR coalesce(f.blocked_until>NOW(),false) OR w.pause_requested AS paused FROM family_enrichment_control f CROSS JOIN worker_status w")).rows[0];if(!r)throw Error('Missing pause controls');console.log(JSON.stringify(r));}finally{await c.end();}`;
  try {
    paused = JSON.parse(
      execFileSync(
        "ssh",
        [
          process.env.BIRDS_DROPLET_SSH,
          "cd /opt/birds && node --env-file=.env --input-type=module",
        ],
        {
          input: code,
          encoding: "utf8",
          timeout: 15000,
          stdio: ["pipe", "pipe", "pipe"],
        },
      ),
    ).paused;
    lastCheck = Date.now();
    return paused;
  } catch {
    throw new QualityRunPaused(
      "Could not verify production pause controls; stopping safely",
    );
  }
}
export async function assertQualityRunActive() {
  if (await qualityRunPaused())
    throw new QualityRunPaused(
      "Family enrichment is paused or cooling down in Admin",
    );
}
