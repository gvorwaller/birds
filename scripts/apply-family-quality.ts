/** Bundled operator entry; dry-run unless --apply is explicitly supplied. */
import { readFileSync } from "node:fs";
import { applyFamilyQualityRefresh } from "../src/lib/server/family-quality-refresh";
const input = JSON.parse(readFileSync(process.argv[2], "utf8"));
const candidates = input.results.filter(
  (r: { outcome: string }) => r.outcome === "approved",
);
const result = await applyFamilyQualityRefresh(
  candidates,
  process.argv.includes("--apply"),
);
console.log(JSON.stringify(result, null, 2));
process.exit(0);
