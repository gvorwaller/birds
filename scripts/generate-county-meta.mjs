#!/usr/bin/env node
/**
 * Regenerates src/lib/server/data/county-meta.json (td-01ddb6).
 *
 * Source: Wikidata SPARQL — every item carrying P882 (FIPS 6-4 county code)
 * with its English rdfs:label and, when present, the English label of its
 * P36 (county seat). Direct rdfs:label is used instead of the label service,
 * which intermittently returns bare Q-ids.
 *
 * Filtering (see also src/lib/server/county-meta.ts header):
 * - Some Wikidata METRO/statistical-area items wrongly carry CBSA codes in
 *   P882; excluded by name pattern. Residual bad rows land at FIPS values no
 *   real county uses (e.g. 12060) and are unreachable — runtime lookups are
 *   always keyed by an eBird-provided subnational2 code.
 * - When several items share a code (historical dupes), the name carrying an
 *   official suffix (County/Parish/Borough/…) wins.
 * - OVERRIDES patches gaps where upstream data is broken; each entry must be
 *   an independently verifiable public fact.
 *
 * The script VALIDATES exact county-equivalent counts for several states and
 * refuses to write on mismatch.
 *
 * Usage: node scripts/generate-county-meta.mjs
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const OUT = fileURLToPath(
  new URL("../src/lib/server/data/county-meta.json", import.meta.url),
);

const STATE_FIPS = {
  "01": "AL", "02": "AK", "04": "AZ", "05": "AR", "06": "CA", "08": "CO",
  "09": "CT", "10": "DE", "11": "DC", "12": "FL", "13": "GA", "15": "HI",
  "16": "ID", "17": "IL", "18": "IN", "19": "IA", "20": "KS", "21": "KY",
  "22": "LA", "23": "ME", "24": "MD", "25": "MA", "26": "MI", "27": "MN",
  "28": "MS", "29": "MO", "30": "MT", "31": "NE", "32": "NV", "33": "NH",
  "34": "NJ", "35": "NM", "36": "NY", "37": "NC", "38": "ND", "39": "OH",
  "40": "OK", "41": "OR", "42": "PA", "44": "RI", "45": "SC", "46": "SD",
  "47": "TN", "48": "TX", "49": "UT", "50": "VT", "51": "VA", "53": "WA",
  "54": "WV", "55": "WI", "56": "WY", "60": "AS", "66": "GU", "69": "MP",
  "72": "PR", "78": "VI",
};
const SUFFIX =
  /(County|Parish|Borough|Census Area|Municipality|Municipio|City and Borough|city|City|District of Columbia|Island)s?$/;
const METRO = /metropolitan|micropolitan|statistical area|greater |, [A-Z]{2} |combined/i;
// Verifiable public facts patching broken upstream data:
// - Hillsborough County, FL: Wikidata P36 resolves to an unlabeled node.
const OVERRIDES = {
  "US-FL-057": { seat: "Tampa" }, // Wikidata P36 resolves to an unlabeled node
  // Vieques' seat is Isabel II; a sibling item self-references the municipio
  // as its own "seat", which no normalization can recognize as a duplicate.
  "US-PR-147": { seat: "Isabel II" },
};
// Exact county-equivalent counts; generation aborts on mismatch.
const EXPECT = { FL: 67, ME: 16, GA: 159, CA: 58 };

// Statement-level P36 (not bare wdt:P36): a county's FORMER seats often
// remain as normal-rank statements distinguished only by an end-time
// qualifier (pq:P582) — bare wdt: returned them and the UI showed
// "Mound City / Paris" for Linn County KS (CODEX1). Deprecated-rank
// statements are excluded; ranks ride along so preferred wins in JS.
const QUERY = `SELECT ?fips ?countyLabel ?seatLabel ?rank WHERE {
  ?county wdt:P882 ?fips .
  ?county rdfs:label ?countyLabel . FILTER(LANG(?countyLabel)="en")
  OPTIONAL {
    ?county p:P36 ?st .
    ?st ps:P36 ?seat ; wikibase:rank ?rank .
    FILTER(?rank != wikibase:DeprecatedRank)
    FILTER NOT EXISTS { ?st pq:P582 ?ended }
    ?seat rdfs:label ?seatLabel . FILTER(LANG(?seatLabel)="en")
  }
}`;

const res = await fetch(
  `https://query.wikidata.org/sparql?query=${encodeURIComponent(QUERY)}&format=json`,
  { headers: { "User-Agent": "birds.gaylon.photos county-map-links (gaylon@vorwaller.net)" } },
);
if (!res.ok) throw new Error(`Wikidata SPARQL HTTP ${res.status}`);
const rows = (await res.json()).results.bindings;
console.log(`SPARQL rows: ${rows.length}`);

const PREFERRED = "http://wikiba.se/ontology#PreferredRank";
const byCode = new Map();
for (const r of rows) {
  const fips = r.fips.value.trim();
  const name = r.countyLabel.value.trim();
  const seat = (r.seatLabel?.value ?? "").trim();
  const preferred = r.rank?.value === PREFERRED;
  if (!/^\d{5}$/.test(fips) || METRO.test(name)) continue;
  const postal = STATE_FIPS[fips.slice(0, 2)];
  if (!postal) continue;
  const code = `US-${postal}-${fips.slice(2)}`;
  const entry = byCode.get(code) ?? { names: [], seats: new Map() };
  if (!entry.names.includes(name)) entry.names.push(name);
  if (seat && !/^Q\d+$/.test(seat)) {
    // PR municipalities list their seat twice — as the town and as the
    // "X barrio-pueblo" entity. Normalize away the suffix, then dedupe.
    const cleaned = seat.replace(/\s+barrio-pueblo$/i, "");
    entry.seats.set(cleaned, entry.seats.get(cleaned) || preferred);
  }
  byCode.set(code, entry);
}

const final = {};
let multiSeat = 0;
for (const code of [...byCode.keys()].sort()) {
  const v = byCode.get(code);
  const named = v.names.filter((n) => SUFFIX.test(n));
  const name = (named.length ? named : v.names)[0];
  // Preferred-rank seats win outright; otherwise all current (un-ended)
  // normal-rank seats remain — genuine dual-seat counties (Hinds MS,
  // Sebastian AR, …). Alphabetical order = endpoint-order independent.
  const preferredSeats = [...v.seats.entries()].filter(([, p]) => p).map(([s]) => s);
  const seats = (preferredSeats.length ? preferredSeats : [...v.seats.keys()]).sort();
  if (seats.length > 1) multiSeat++;
  let seat = seats.length ? seats.slice(0, 2).join(" / ") : null;
  if (OVERRIDES[code]?.seat) seat = OVERRIDES[code].seat;
  final[code] = { name, seat };
}
console.log(`multi-seat counties after current-seat filtering: ${multiSeat}`);

let bad = false;
for (const [st, want] of Object.entries(EXPECT)) {
  const have = Object.keys(final).filter((c) => c.startsWith(`US-${st}-`)).length;
  const ok = have === want;
  console.log(`${st}: ${have} (want ${want}) ${ok ? "OK" : "MISMATCH"}`);
  if (!ok) bad = true;
}
// Seat spot-checks: counties whose FORMER seats leaked through bare wdt:P36
// (CODEX1) plus a genuine dual-seat county that must survive the filter.
const SEAT_EXPECT = {
  "US-KS-107": "Mound City", // Linn County — Paris is a 19th-century seat
  "US-NC-081": "Greensboro", // Guilford County — Martinsville long defunct
  "US-FL-057": "Tampa",
  "US-MS-049": "Jackson / Raymond", // Hinds County — genuinely two seats
  "US-PR-147": "Isabel II", // Vieques — the municipio is not its own seat
};
for (const [code, want] of Object.entries(SEAT_EXPECT)) {
  const have = final[code]?.seat ?? null;
  const ok = have === want;
  console.log(`${code}: "${have}" (want "${want}") ${ok ? "OK" : "MISMATCH"}`);
  if (!ok) bad = true;
}
if (bad) {
  console.error("Validation failed — NOT writing.");
  process.exit(1);
}
const noSeat = Object.values(final).filter((v) => v.seat == null).length;
console.log(`total ${Object.keys(final).length} · no seat ${noSeat}`);
writeFileSync(OUT, JSON.stringify(final, null, 0) + "\n");
console.log(`wrote ${OUT}`);
