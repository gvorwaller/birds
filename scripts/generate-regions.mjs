#!/usr/bin/env node
/**
 * Generate the `regions` reference-data seed from eBird (refactor plan
 * Phase 2, docs/2026-08-30-regions-reference-data-refactor-plan.md).
 *
 * Modeled on generate-county-meta.mjs: standalone Node ESM, no repo imports,
 * run manually, and it VALIDATES BEFORE WRITING — any gate failure exits(1)
 * with nothing written.
 *
 * Sources (names from the list endpoints — what the app has always
 * displayed; coordinates from region info):
 *   GET /v2/ref/region/list/country/world            (1 call)
 *   GET /v2/ref/region/list/subnational1/{country}   (~250 calls)
 *   GET /v2/ref/region/info/{code}                   (~4,250 calls)
 *
 * Pacing: eBird publishes no numeric rate ceiling, and this repo has been
 * burned by documented-vs-real limits before (iNaturalist, devlog
 * 2026-08-29). Requests are serial with BASE_DELAY_MS spacing + jitter;
 * 429/5xx honor Retry-After with exponential backoff; a run of consecutive
 * failures circuit-breaks with the checkpoint intact. Run `--pilot` first
 * (3 countries) and read its report before a full run.
 *
 * Checkpoint: every response lands in .local/regions-cache.json (gitignored)
 * so an aborted run never refetches. `--refetch` ignores it.
 *
 * Output (full mode): backend/db/migrations/00NN_regions_seed_YYYYMMDD.sql
 * (chunked multi-row upserts, sorted by code) + backend/db/regions-manifest.json.
 * When a manifest already exists, only CHANGED rows are emitted (delta
 * migration; CODEX1 P2-8) and rows retired upstream are reported as
 * warnings, never deleted.
 *
 * Usage:
 *   EBIRD_API_KEY=... node scripts/generate-regions.mjs --pilot
 *   EBIRD_API_KEY=... node scripts/generate-regions.mjs
 * Options: --pilot [CC,CC,...]  --refetch  --dry-run
 *
 * The key is read ONLY from the environment and never printed.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const API = "https://api.ebird.org/v2";
// Default measured 2026-08-30: eBird allows a fast initial burst (~500
// requests), then throttles to ~17 req/min sustained — at 400ms every code
// cost a 429 + a 6s retry (two requests each). 3600ms fits under the
// sustained ceiling with ONE request per code. Env-tunable for pilots.
const BASE_DELAY_MS = Number(process.env.REGIONS_DELAY_MS ?? 3600);
const MAX_CONSECUTIVE_FAILURES = 6;
const CACHE_PATH = ".local/regions-cache.json";
const MANIFEST_PATH = "backend/db/regions-manifest.json";
const MIGRATIONS_DIR = "backend/db/migrations";
const REQUIRED_CODES_PATH = "backend/db/regions-required-codes.txt";
const PILOT_DEFAULT = ["US", "DK", "IS"];
const CHUNK_ROWS = 500;

// Must stay identical to the CHECK in 0043_regions.sql and the region_ref
// grammar in 0045 — the validation gate below enforces it on every code.
const CODE_RE = /^[A-Z]{2}(-[A-Z0-9]+)?$/;

// --- validate-before-write expectations (generate-county-meta.mjs style) ---
// Exact counts measured from eBird's own current lists (2026-08-30). If
// eBird redraws a country's subdivisions, this run FAILS and a human updates
// the expectation — that is the discipline working, not an inconvenience.
const EXPECT_COUNTRIES_MIN = 240;
const EXPECT_SUB1 = { US: 51, CA: 13, AU: 8, DK: 13, IS: 8, SE: 21, FI: 19, CR: 7 };
const SPOT = {
  US: { name: "United States", level: "country" },
  "US-FL": { name: "Florida", parent: "US", lat: [24, 31], lon: [-88, -79] },
  "DK-05": { name: "Bornholm", parent: "DK", lat: [54, 56], lon: [14, 16] },
  IS: { name: "Iceland", level: "country", lat: [63, 67], lon: [-25, -13] },
  "SE-AB": { name: "Stockholms län", parent: "SE" }, // pins the [SE-01] artifact fix
  "NO-03": { name: "Oslo", parent: "NO" },
  "IS-1": { name: "Höfuðborgarsvæði", parent: "IS" }, // single-digit sub1 code
};

function parseArgs(argv) {
  const args = { pilot: null, refetch: false, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--pilot") {
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        args.pilot = next.split(",").map((c) => c.trim().toUpperCase());
        i += 1;
      } else args.pilot = PILOT_DEFAULT;
    } else if (a === "--refetch") args.refetch = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--help" || a === "-h") {
      console.log("EBIRD_API_KEY=... node scripts/generate-regions.mjs [--pilot [CC,CC]] [--refetch] [--dry-run]");
      process.exit(0);
    } else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

const apiKey = process.env.EBIRD_API_KEY;
if (!apiKey) {
  console.error("EBIRD_API_KEY is not set. Never hardcode it; pass it via the environment.");
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));

// --- checkpointed, rate-aware fetching -------------------------------------
const cache = (() => {
  if (args.refetch) return { lists: {}, info: {} };
  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
  } catch {
    return { lists: {}, info: {} };
  }
})();
let cacheDirty = 0;
function saveCache(force = false) {
  cacheDirty += 1;
  if (!force && cacheDirty % 20 !== 0) return;
  fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache));
}

const stats = { calls: 0, retries: 0, http429: 0, http5xx: 0, startedAt: Date.now() };
let consecutiveFailures = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ebirdGet(pathname) {
  // Measured 2026-08-30: eBird throttles in WINDOWS — a burst of ~20 calls
  // succeeds, then several minutes of hard 429s (whose Retry-After: 3 lies).
  // So 429s are handled with patient, escalating waits and are NEVER counted
  // against the attempt cap or the circuit breaker — a throttle window says
  // nothing about this code or the run's health. Only real failures (network,
  // 5xx, timeouts) burn attempts.
  let backoffMs = 5000;
  let throttleWaitMs = 30_000;
  let attempt = 0;
  for (;;) {
    await sleep(BASE_DELAY_MS + Math.random() * 150);
    stats.calls += 1;
    let res;
    try {
      res = await fetch(`${API}${pathname}`, {
        headers: {
          "X-eBirdApiToken": apiKey,
          Accept: "application/json",
          "User-Agent": "birds-app region seed generator (one-off; contact gaylon@vorwaller.net)",
        },
        signal: AbortSignal.timeout(20000),
      });
    } catch (err) {
      res = null;
      console.error(`  network error on ${pathname}: ${err.message}`);
    }
    if (res && (res.status === 200 || res.status === 404 || res.status === 410)) {
      consecutiveFailures = 0;
      throttleWaitMs = 30_000;
      if (res.status !== 200) return { status: res.status, body: null };
      const text = await res.text();
      try {
        return { status: 200, body: JSON.parse(text) };
      } catch {
        return { status: 200, body: null }; // malformed 200 → treated as no data
      }
    }
    if (res?.status === 429) {
      stats.http429 += 1;
      const retryAfter = Number(res.headers?.get("retry-after"));
      const waitMs = Math.max(
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 0,
        throttleWaitMs,
      );
      console.error(`  throttled on ${pathname} — waiting ${Math.round(waitMs / 1000)}s for the window to clear`);
      await sleep(waitMs);
      throttleWaitMs = Math.min(throttleWaitMs * 2, 10 * 60_000);
      continue;
    }
    // Real failure (network / 5xx / unexpected status).
    attempt += 1;
    consecutiveFailures += 1;
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      saveCache(true);
      console.error(
        `Circuit break: ${MAX_CONSECUTIVE_FAILURES} consecutive failures. ` +
          `Checkpoint saved (${CACHE_PATH}); re-run to resume.`,
      );
      process.exit(1);
    }
    if (attempt >= 5) {
      saveCache(true);
      console.error(`Giving up on ${pathname} after 5 real failures. Checkpoint saved.`);
      process.exit(1);
    }
    stats.retries += 1;
    if (res && res.status >= 500) stats.http5xx += 1;
    console.error(`  ${res ? `HTTP ${res.status}` : "no response"} on ${pathname} — waiting ${Math.round(backoffMs / 1000)}s`);
    await sleep(backoffMs);
    backoffMs = Math.min(backoffMs * 2, 120_000);
  }
}

/** Strip a legacy CODE annotation ("Stockholms län [SE-01]") — never a
 * bracketed alternate name ("… [Bangkok]"). Applied on fetch AND on cache
 * read, since the checkpoint may hold pre-normalization names. */
const cleanName = (name) => String(name).replace(/\s*\[[A-Z]{2}-[A-Z0-9]+\]$/, "").trim();

async function regionList(level, parent) {
  const key = `${level}:${parent}`;
  if (cache.lists[key])
    return cache.lists[key].map((r) => ({ code: r.code, name: cleanName(r.name) }));
  const { body } = await ebirdGet(`/ref/region/list/${level}/${parent}?fmt=json`);
  if (!Array.isArray(body)) {
    console.error(`Region list ${key} did not return an array.`);
    process.exit(1);
  }
  // eBird's own list names sometimes carry a legacy CODE annotation —
  // "Stockholms län [SE-01]" (Sweden ships 21 of these). Strip exactly that
  // shape; bracketed ALTERNATE NAMES ("Krung Thep Maha Nakhon [Bangkok]",
  // Laos's romanization variants) are useful and kept (measured 2026-08-30:
  // 36 bracketed names across 7 countries, only Sweden's are code-shaped).
  const rows = body.map((r) => ({
    code: String(r.code),
    name: cleanName(r.name),
  }));
  cache.lists[key] = rows;
  saveCache();
  return rows;
}

async function regionInfo(code) {
  if (cache.info[code]) return cache.info[code];
  const { status, body } = await ebirdGet(`/ref/region/info/${code}`);
  const lat = body?.latitude;
  const lon = body?.longitude;
  const ok =
    status === 200 &&
    typeof lat === "number" && Number.isFinite(lat) && lat >= -90 && lat <= 90 &&
    typeof lon === "number" && Number.isFinite(lon) && lon >= -180 && lon <= 180 &&
    !(lat === 0 && lon === 0); // null-island sentinel — never a real region centroid
  const out = ok ? { lat, lon } : { missing: true, status };
  cache.info[code] = out;
  saveCache();
  return out;
}

// --- main ------------------------------------------------------------------
const countries = await regionList("country", "world");
console.log(`countries: ${countries.length}`);

const pilotSet = args.pilot ? new Set(args.pilot) : null;
const wanted = pilotSet ? countries.filter((c) => pilotSet.has(c.code)) : countries;
if (pilotSet && wanted.length !== pilotSet.size) {
  console.error(`Pilot countries not all found in the world list: ${args.pilot.join(",")}`);
  process.exit(1);
}

/** code -> {name, level, parent} */
const regionsByCode = new Map();
for (const c of countries) regionsByCode.set(c.code, { name: c.name, level: "country", parent: null });

for (const [i, c] of wanted.entries()) {
  const subs = await regionList("subnational1", c.code);
  for (const s of subs) regionsByCode.set(s.code, { name: s.name, level: "subnational1", parent: c.code });
  if ((i + 1) % 25 === 0) console.log(`  sub1 lists: ${i + 1}/${wanted.length}`);
}

const infoTargets = pilotSet
  ? [...regionsByCode.keys()].filter((code) => pilotSet.has(code.slice(0, 2)))
  : [...regionsByCode.keys()];
console.log(`coordinate lookups: ${infoTargets.length}`);
const missingCoords = [];
for (const [i, code] of infoTargets.entries()) {
  const info = await regionInfo(code);
  if (info.missing) missingCoords.push(`${code} (HTTP ${info.status ?? "?"} / unusable coordinates)`);
  if ((i + 1) % 100 === 0) console.log(`  info: ${i + 1}/${infoTargets.length}`);
}
saveCache(true);

const elapsedMin = (Date.now() - stats.startedAt) / 60_000;
console.log(
  `\nfetch report: ${stats.calls} calls in ${elapsedMin.toFixed(1)} min ` +
    `(${stats.retries} retries, ${stats.http429}×429, ${stats.http5xx}×5xx)`,
);

if (args.pilot) {
  console.log(`\nPILOT COMPLETE (${args.pilot.join(",")}). ${missingCoords.length} codes lacked coordinates.`);
  if (missingCoords.length) console.log(missingCoords.map((m) => `  ${m}`).join("\n"));
  console.log("Read the fetch report above (429s especially), then run the full generator.");
  process.exit(0);
}

// --- validation gates (nothing written unless ALL pass) --------------------
const failures = [];

if (countries.length < EXPECT_COUNTRIES_MIN) {
  failures.push(`only ${countries.length} countries (< ${EXPECT_COUNTRIES_MIN})`);
}
for (const [cc, expected] of Object.entries(EXPECT_SUB1)) {
  const got = [...regionsByCode.values()].filter((r) => r.parent === cc).length;
  if (got !== expected) failures.push(`sub1 count for ${cc}: ${got}, expected ${expected}`);
}
// Codes eBird itself has never geocoded (latitude/longitude 0,0 — verified
// live 2026-08-30: XX "High Seas" plus ~300 micro-subdivisions, half of them
// Latvian municipalities and Maltese councils). They cannot be seeded under
// lat/lon NOT NULL without fabricating a value (cs.md), so they are EXCLUDED
// and recorded in a committed, reviewable file; a future re-run picks any
// that eBird geocodes back up as delta additions. Fatal only if a
// prod-required code is affected — that would break the 0045 FK.
const EXCLUDED_PATH = "backend/db/regions-excluded-codes.txt";
const excludedCodes = infoTargets.filter((code) => cache.info[code]?.missing);
for (const code of excludedCodes) regionsByCode.delete(code);
if (excludedCodes.length > 0) {
  console.warn(
    `WARNING: excluding ${excludedCodes.length} code(s) with no usable eBird coordinates ` +
      `(written to ${EXCLUDED_PATH}).`,
  );
}
for (const [code, r] of regionsByCode) {
  if (!CODE_RE.test(code)) failures.push(`code fails the 0043/0045 grammar: ${code}`);
  if (!r.name || !r.name.trim()) failures.push(`empty name for ${code}`);
  if (/\[[A-Z]{2}-[A-Z0-9]+\]/.test(r.name)) failures.push(`code-shaped bracket suffix survived normalization: ${code} "${r.name}"`);
  if (r.parent && !regionsByCode.has(r.parent)) failures.push(`orphan: ${code} parent ${r.parent} not in set`);
  if (r.parent && regionsByCode.get(r.parent)?.level !== "country") failures.push(`${code} parent ${r.parent} is not a country`);
}
for (const [code, expect] of Object.entries(SPOT)) {
  const r = regionsByCode.get(code);
  const info = cache.info[code];
  if (!r) { failures.push(`spot check: ${code} missing`); continue; }
  if (expect.name && r.name !== expect.name) failures.push(`spot check ${code}: name "${r.name}" != "${expect.name}"`);
  if (expect.level && r.level !== expect.level) failures.push(`spot check ${code}: level ${r.level}`);
  if (expect.parent && r.parent !== expect.parent) failures.push(`spot check ${code}: parent ${r.parent}`);
  if (expect.lat && !(info && info.lat >= expect.lat[0] && info.lat <= expect.lat[1]))
    failures.push(`spot check ${code}: lat ${info?.lat} outside [${expect.lat}]`);
  if (expect.lon && !(info && info.lon >= expect.lon[0] && info.lon <= expect.lon[1]))
    failures.push(`spot check ${code}: lon ${info?.lon} outside [${expect.lon}]`);
}
// Every code prod data references must be present — the mechanical guarantee
// that the 0045 FK cannot fail (plan Phase 2/4).
try {
  const required = fs.readFileSync(REQUIRED_CODES_PATH, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
  const absent = required.filter((code) => !regionsByCode.has(code));
  if (absent.length) failures.push(`required prod codes missing or coordinate-less: ${absent.join(", ")}`);
} catch {
  failures.push(`${REQUIRED_CODES_PATH} unreadable — regenerate it from prod first`);
}

if (failures.length) {
  console.error(`\nVALIDATION FAILED — nothing written:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}

// --- emit ------------------------------------------------------------------
const today = new Date().toISOString().slice(0, 10);
const rows = [...regionsByCode.entries()]
  .map(([code, r]) => ({
    code,
    name: r.name.trim(),
    level: r.level,
    parent: r.parent,
    lat: cache.info[code].lat,
    lon: cache.info[code].lon,
  }))
  .sort((a, b) => (a.code < b.code ? -1 : 1));

// Delta vs the committed manifest (CODEX1 P2-8): unchanged rows keep their
// source_at and are not re-emitted; retired rows are warned, never deleted.
let previous = null;
try {
  previous = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
} catch {
  /* first run */
}
const changed = rows.filter((r) => {
  const p = previous?.regions?.[r.code];
  return !p || p.name !== r.name || p.level !== r.level || p.parent !== r.parent || p.lat !== r.lat || p.lon !== r.lon;
});
const retired = previous ? Object.keys(previous.regions).filter((code) => !regionsByCode.has(code)) : [];
if (retired.length) {
  console.warn(
    `WARNING: ${retired.length} previously seeded code(s) no longer listed by eBird ` +
      `(NOT deleted; removing one requires an explicit migration after proving no FK references):\n  ${retired.join(", ")}`,
  );
}
if (previous && changed.length === 0) {
  console.log("No changes vs the committed manifest — nothing to emit.");
  process.exit(0);
}

// Seed/delta migrations must sort BEFORE 0045 (the FK that references the
// seeded rows) on a fresh cluster and before any future schema change that
// depends on them — max+1 is correct for DELTAS; the first full seed was
// hand-renamed to 0044 for exactly this ordering. Deltas after 0045 are fine:
// they only ever ADD/UPDATE rows, never remove ones the FK references.
const nn = (() => {
  const nums = fs.readdirSync(MIGRATIONS_DIR).map((f) => Number(f.slice(0, 4))).filter(Number.isFinite);
  return String(Math.max(...nums) + 1).padStart(4, "0");
})();
const kind = previous ? "delta" : "seed";
const outSql = path.join(MIGRATIONS_DIR, `${nn}_regions_${kind}_${today.replaceAll("-", "")}.sql`);

const q = (s) => `'${s.replaceAll("'", "''")}'`;
const sourceAtOf = (r) => previous?.regions?.[r.code] && changed.every((c) => c.code !== r.code)
  ? previous.regions[r.code].source_at
  : today;
const valueRow = (r) =>
  `(${q(r.code)}, ${q(r.name)}, ${q(r.level)}, ${r.parent ? q(r.parent) : "NULL"}, ${r.lat}, ${r.lon}, ${q(sourceAtOf(r))})`;

// Countries must land before their children satisfy the parent FK; the sort
// already guarantees it ('US' < 'US-FL'), stated here so nobody re-sorts.
const emitRows = changed;
const chunks = [];
for (let i = 0; i < emitRows.length; i += CHUNK_ROWS) {
  chunks.push(
    `INSERT INTO regions (code, name, level, parent_code, lat, lon, source_at) VALUES\n` +
      emitRows.slice(i, i + CHUNK_ROWS).map(valueRow).join(",\n") +
      `\nON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, level = EXCLUDED.level,\n` +
      `  parent_code = EXCLUDED.parent_code, lat = EXCLUDED.lat, lon = EXCLUDED.lon,\n` +
      `  source_at = EXCLUDED.source_at;`,
  );
}
const header =
  `-- Generated by scripts/generate-regions.mjs on ${today} (${kind}: ${emitRows.length} rows` +
  (previous ? ` changed of ${rows.length} total` : "") +
  `).\n-- Source: eBird /ref/region/list + /ref/region/info. Do not hand-edit; re-run the generator.\n` +
  `-- No BEGIN/COMMIT: migrate_pg.sh wraps each file (see 0043 header).\n\n`;

if (args.dryRun) {
  console.log(`DRY RUN: would write ${outSql} (${emitRows.length} rows) and update ${MANIFEST_PATH}`);
  process.exit(0);
}
fs.writeFileSync(
  EXCLUDED_PATH,
  `# Regions eBird lists but has never geocoded (lat/lon 0,0) — excluded from\n` +
    `# the seed because coordinates are NOT NULL and fabricating one is\n` +
    `# forbidden (cs.md). Regenerated by scripts/generate-regions.mjs.\n` +
    excludedCodes.sort().join("\n") +
    "\n",
);
fs.writeFileSync(outSql, header + chunks.join("\n\n") + "\n");
fs.writeFileSync(
  MANIFEST_PATH,
  JSON.stringify(
    {
      generated_at: today,
      regions: Object.fromEntries(rows.map((r) => [r.code, { name: r.name, level: r.level, parent: r.parent, lat: r.lat, lon: r.lon, source_at: sourceAtOf(r) }])),
    },
    null,
    0,
  ) + "\n",
);
console.log(`Wrote ${outSql} (${emitRows.length} rows) and ${MANIFEST_PATH} (${rows.length} regions).`);
