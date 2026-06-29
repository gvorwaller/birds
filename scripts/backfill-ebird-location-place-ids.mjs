#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import pg from "pg";

const DEFAULT_RADIUS_M = 2500;
const DEFAULT_MIN_CONFIDENCE = 0.7;

function usage() {
  console.log(`Usage:
  node scripts/backfill-ebird-location-place-ids.mjs --env-file /opt/birds/.env [--apply]

Options:
  --env-file PATH          Load PG* and GOOGLE_GEOCODING_KEY from an env file.
  --apply                  Update ebird_locations.google_place_id. Default is dry-run.
  --radius-m N             Candidate max distance from eBird lat/lng. Default ${DEFAULT_RADIUS_M}.
  --min-confidence N       Minimum match confidence 0..1. Default ${DEFAULT_MIN_CONFIDENCE}.
  --out-dir PATH           Audit output directory. Default data/ebird-location-place-id-backfill.
  --limit N                Limit number of rows processed after cache seeding.
  --no-seed-from-cache     Do not populate ebird_locations from ebird_cache first.
`);
}

function parseArgs(argv) {
  const args = {
    apply: false,
    envFile: null,
    radiusM: DEFAULT_RADIUS_M,
    minConfidence: DEFAULT_MIN_CONFIDENCE,
    outDir: "data/ebird-location-place-id-backfill",
    limit: null,
    seedFromCache: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    if (arg === "--apply") {
      args.apply = true;
      continue;
    }
    if (arg === "--no-seed-from-cache") {
      args.seedFromCache = false;
      continue;
    }
    const next = argv[++i];
    if (!next) throw new Error(`Missing value for ${arg}`);
    if (arg === "--env-file") args.envFile = next;
    else if (arg === "--radius-m") args.radiusM = Number(next);
    else if (arg === "--min-confidence") args.minConfidence = Number(next);
    else if (arg === "--out-dir") args.outDir = next;
    else if (arg === "--limit") args.limit = Number(next);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isFinite(args.radiusM) || args.radiusM <= 0)
    throw new Error("--radius-m must be positive");
  if (
    !Number.isFinite(args.minConfidence) ||
    args.minConfidence < 0 ||
    args.minConfidence > 1
  ) {
    throw new Error("--min-confidence must be between 0 and 1");
  }
  if (
    args.limit != null &&
    (!Number.isInteger(args.limit) || args.limit <= 0)
  ) {
    throw new Error("--limit must be a positive integer");
  }
  return args;
}

function loadEnvFile(file) {
  if (!file) return;
  const text = fs.readFileSync(file, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const m = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    const [, key, raw] = m;
    if (process.env[key] != null) continue;
    process.env[key] = raw.replace(/^['"]|['"]$/g, "");
  }
}

function csvEscape(value) {
  const s = value == null ? "" : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function writeCsv(file, rows) {
  const headers = [
    "action",
    "reason",
    "loc_id",
    "loc_name",
    "lat",
    "lng",
    "candidate_name",
    "candidate_place_id",
    "candidate_lat",
    "candidate_lng",
    "distance_m",
    "name_score",
    "confidence",
    "candidate_types",
    "google_url",
  ];
  const lines = [headers.join(",")];
  for (const row of rows)
    lines.push(headers.map((h) => csvEscape(row[h])).join(","));
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
}

function normalizeName(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\b(usa|us|united states|the|at|of|and)\b/g, " ")
    .replace(/\b[a-z]{2}-[a-z]{2}\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokens(s) {
  return normalizeName(s)
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

function nameScore(query, candidate) {
  const q = tokens(query);
  const c = tokens(candidate);
  if (q.length === 0 || c.length === 0) return 0;
  const cSet = new Set(c);
  const exact = normalizeName(query) === normalizeName(candidate) ? 1 : 0;
  const overlap = q.filter(
    (t) => cSet.has(t) || c.some((ct) => ct.includes(t) || t.includes(ct)),
  ).length;
  const coverage = overlap / q.length;
  const reverse = overlap / c.length;
  return Math.max(exact, coverage * 0.75 + reverse * 0.25);
}

function haversineMeters(aLat, aLng, bLat, bLng) {
  const r = 6371000;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const lat1 = (aLat * Math.PI) / 180;
  const lat2 = (bLat * Math.PI) / 180;
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * r * Math.asin(Math.sqrt(x));
}

function confidence(saved, candidate, radiusM) {
  const distanceM = haversineMeters(
    saved.lat,
    saved.lng,
    candidate.lat,
    candidate.lng,
  );
  const distanceScore = Math.max(0, 1 - distanceM / radiusM);
  const nScore = nameScore(saved.loc_name, candidate.name);
  const score = nScore * 0.78 + distanceScore * 0.22;
  return { distanceM, nameScore: nScore, confidence: Math.min(1, score) };
}

async function googleJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Google HTTP ${res.status}`);
  return res.json();
}

async function textSearch(apiKey, loc, radiusM) {
  const url = new URL(
    "https://maps.googleapis.com/maps/api/place/textsearch/json",
  );
  url.searchParams.set("key", apiKey);
  url.searchParams.set("query", loc.loc_name);
  url.searchParams.set("location", `${loc.lat},${loc.lng}`);
  url.searchParams.set("radius", String(Math.round(radiusM)));
  const data = await googleJson(url);
  if (data.status === "ZERO_RESULTS") return [];
  if (data.status !== "OK")
    throw new Error(`Text Search ${data.status}: ${data.error_message ?? ""}`);
  return (data.results ?? [])
    .filter((r) => r.place_id && r.geometry?.location)
    .map((r) => ({
      name: r.name ?? r.formatted_address ?? "",
      place_id: r.place_id,
      lat: r.geometry.location.lat,
      lng: r.geometry.location.lng,
      types: r.types ?? [],
    }));
}

function uniqCandidates(candidates) {
  const seen = new Set();
  const out = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.place_id)) continue;
    seen.add(candidate.place_id);
    out.push(candidate);
  }
  return out;
}

async function findCandidate(apiKey, loc, radiusM) {
  const candidates = await textSearch(apiKey, loc, radiusM);
  const scored = uniqCandidates(candidates)
    .map((candidate) => ({
      ...candidate,
      ...confidence(loc, candidate, radiusM),
    }))
    .sort((a, b) => b.confidence - a.confidence || a.distanceM - b.distanceM);
  return scored[0] ?? null;
}

function extractLocations(payload) {
  if (!Array.isArray(payload)) return [];
  const out = [];
  for (const row of payload) {
    if (
      row &&
      typeof row.locId === "string" &&
      typeof row.locName === "string" &&
      Number.isFinite(Number(row.lat)) &&
      Number.isFinite(Number(row.lng))
    ) {
      out.push({
        loc_id: row.locId,
        loc_name: row.locName,
        lat: Number(row.lat),
        lng: Number(row.lng),
      });
    }
  }
  return out;
}

async function seedLocationsFromCache(pool) {
  const { rows } = await pool.query("SELECT payload FROM ebird_cache");
  const byId = new Map();
  for (const row of rows) {
    for (const loc of extractLocations(row.payload)) {
      if (!byId.has(loc.loc_id)) byId.set(loc.loc_id, loc);
    }
  }
  const locations = [...byId.values()];
  for (const loc of locations) {
    await pool.query(
      `INSERT INTO ebird_locations (loc_id, loc_name, lat, lng)
			 VALUES ($1, $2, $3, $4)
			 ON CONFLICT (loc_id) DO UPDATE
			   SET loc_name = EXCLUDED.loc_name,
			       lat = EXCLUDED.lat,
			       lng = EXCLUDED.lng,
			       last_seen_at = NOW(),
			       updated_at = NOW()`,
      [loc.loc_id, loc.loc_name, loc.lat, loc.lng],
    );
  }
  return locations.length;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  loadEnvFile(args.envFile);
  const apiKey =
    process.env.GOOGLE_GEOCODING_KEY || process.env.PUBLIC_GOOGLE_MAPS_API_KEY;
  if (!apiKey)
    throw new Error(
      "GOOGLE_GEOCODING_KEY or PUBLIC_GOOGLE_MAPS_API_KEY is required",
    );

  const pool = new pg.Pool({
    host: process.env.PGHOST ?? "127.0.0.1",
    port: Number(process.env.PGPORT ?? "5436"),
    database: process.env.PGDATABASE ?? "birds",
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
  });

  const seeded = args.seedFromCache ? await seedLocationsFromCache(pool) : 0;
  const limitSql = args.limit ? ` LIMIT ${args.limit}` : "";
  const { rows } = await pool.query(
    `SELECT loc_id, loc_name, lat, lng
		   FROM ebird_locations
		  WHERE COALESCE(BTRIM(google_place_id), '') = ''
		  ORDER BY last_seen_at DESC, loc_id
		  ${limitSql}`,
  );
  const audit = [];
  let updated = 0;
  let skipped = 0;
  console.log(
    `${args.apply ? "APPLY" : "DRY-RUN"}: seeded ${seeded} locations from cache; scanning ${rows.length} locations without google_place_id`,
  );

  for (const row of rows) {
    let best = null;
    let action = "skip";
    let reason = "";
    try {
      best = await findCandidate(apiKey, row, args.radiusM);
      if (!best) {
        reason = "no_google_candidate";
      } else if (best.distanceM > args.radiusM) {
        reason = `too_far>${args.radiusM}m`;
      } else if (best.confidence < args.minConfidence) {
        reason = `low_confidence<${args.minConfidence}`;
      } else {
        action = args.apply ? "updated" : "would_update";
        reason = "confident_match";
        if (args.apply) {
          await pool.query(
            `UPDATE ebird_locations
						    SET google_place_id = $2,
						        google_place_name = $3,
						        google_place_lat = $4,
						        google_place_lng = $5,
						        google_place_types = $6,
						        google_place_distance_m = $7,
						        google_place_name_score = $8,
						        google_place_confidence = $9,
						        google_place_status = 'matched',
						        google_place_checked_at = NOW(),
						        updated_at = NOW()
						  WHERE loc_id = $1 AND COALESCE(BTRIM(google_place_id), '') = ''`,
            [
              row.loc_id,
              best.place_id,
              best.name,
              best.lat,
              best.lng,
              best.types,
              best.distanceM,
              best.nameScore,
              best.confidence,
            ],
          );
          updated += 1;
        }
      }
      if (action === "skip" && args.apply) {
        await pool.query(
          `UPDATE ebird_locations
					    SET google_place_status = $2,
					        google_place_checked_at = NOW(),
					        updated_at = NOW()
					  WHERE loc_id = $1`,
          [row.loc_id, reason],
        );
      }
    } catch (err) {
      reason = err instanceof Error ? err.message : "lookup_failed";
      if (args.apply) {
        await pool.query(
          `UPDATE ebird_locations
					    SET google_place_status = 'lookup_failed',
					        google_place_checked_at = NOW(),
					        updated_at = NOW()
					  WHERE loc_id = $1`,
          [row.loc_id],
        );
      }
    }
    if (action === "skip") skipped += 1;
    console.log(
      `${action.padEnd(12)} ${row.loc_id} ${row.loc_name} -> ${best?.name ?? "(none)"} ${best ? `${Math.round(best.distanceM)}m score=${best.confidence.toFixed(2)}` : ""} ${reason}`,
    );
    audit.push({
      action,
      reason,
      loc_id: row.loc_id,
      loc_name: row.loc_name,
      lat: row.lat,
      lng: row.lng,
      candidate_name: best?.name ?? "",
      candidate_place_id: best?.place_id ?? "",
      candidate_lat: best?.lat ?? "",
      candidate_lng: best?.lng ?? "",
      distance_m: best ? Math.round(best.distanceM) : "",
      name_score: best ? best.nameScore.toFixed(3) : "",
      confidence: best ? best.confidence.toFixed(3) : "",
      candidate_types: best?.types?.join("|") ?? "",
      google_url: best
        ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(row.loc_name)}&query_place_id=${encodeURIComponent(best.place_id)}`
        : "",
    });
  }

  fs.mkdirSync(args.outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(
    args.outDir,
    `${stamp}-${args.apply ? "apply" : "dry-run"}-ebird-location-place-id-backfill.csv`,
  );
  writeCsv(file, audit);
  await pool.end();
  console.log(`\nRows scanned: ${rows.length}`);
  console.log(
    `Rows ${args.apply ? "updated" : "would update"}: ${audit.filter((r) => r.action === (args.apply ? "updated" : "would_update")).length}`,
  );
  console.log(`Rows skipped: ${skipped}`);
  console.log(`Audit CSV: ${file}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
