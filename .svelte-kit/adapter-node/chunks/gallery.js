import { b as private_env } from "./shared-server.js";
import { q as query, w as withTransaction } from "./db.js";
function normalizeName(s) {
  return s.normalize("NFD").replace(new RegExp("\\p{M}", "gu"), "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
async function buildMatcher() {
  const taxa = await query(
    `SELECT species_code, com_name, sci_name FROM taxonomy_cache WHERE category = 'species'`
  );
  const overrides = await query(
    "SELECT source_name, species_code FROM species_match_overrides"
  );
  const byCom = /* @__PURE__ */ new Map();
  const bySci = /* @__PURE__ */ new Map();
  for (const t of taxa.rows) {
    byCom.set(normalizeName(t.com_name), t.species_code);
    bySci.set(normalizeName(t.sci_name), t.species_code);
  }
  const byOverride = /* @__PURE__ */ new Map();
  for (const o of overrides.rows) {
    byOverride.set(normalizeName(o.source_name), o.species_code);
  }
  return {
    taxonomySize: taxa.rows.length,
    match(comName, sciName) {
      const com = comName ? normalizeName(comName) : "";
      const sci = sciName ? normalizeName(sciName) : "";
      if (com && byOverride.has(com)) return { code: byOverride.get(com), method: "override" };
      if (com && byCom.has(com)) return { code: byCom.get(com), method: "common" };
      if (sci && bySci.has(sci)) return { code: bySci.get(sci), method: "scientific" };
      return null;
    }
  };
}
const DEFAULT_API = "https://gaylon.photos/api/photos?collection=birds";
const PHOTO_PAGE_BASE = "https://gaylon.photos/birds/photo/";
const GALLERY_STALE_HOURS = 48;
async function syncGallery() {
  const apiUrl = private_env.GALLERY_API_URL ?? DEFAULT_API;
  const res = await fetch(apiUrl, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`gaylon.photos API returned ${res.status}`);
  }
  const body = await res.json();
  const photos = Array.isArray(body) ? body : body.photos ?? [];
  if (photos.length === 0) {
    throw new Error("gaylon.photos returned no photos — refusing to wipe the local cache.");
  }
  const matcher = await buildMatcher();
  let matched = 0;
  await withTransaction(async (client) => {
    await client.query("DELETE FROM photo_links");
    for (const p of photos) {
      if (!p.id || !p.thumbnail || !p.url) continue;
      const m = matcher.taxonomySize > 0 ? matcher.match(p.species, p.scientificName) : null;
      if (m) matched++;
      const taken = p.date ? new Date(p.date) : null;
      await client.query(
        `INSERT INTO photo_links
				   (photo_id, species_code, source_species, source_sci_name, url, thumbnail,
				    page_url, taken_on, lat, lng, match_method, fetched_at)
				 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())`,
        [
          p.id,
          m?.code ?? null,
          p.species ?? "",
          p.scientificName ?? null,
          p.url,
          p.thumbnail,
          `${PHOTO_PAGE_BASE}${encodeURIComponent(p.id)}`,
          taken && !Number.isNaN(taken.getTime()) ? taken.toISOString().slice(0, 10) : null,
          p.gps?.lat ?? null,
          p.gps?.lng ?? null,
          m?.method ?? "unmatched"
        ]
      );
    }
  });
  return { total: photos.length, matched, unmatched: photos.length - matched };
}
async function galleryHealth() {
  try {
    const r = await query(
      "SELECT MAX(fetched_at)::text AS newest FROM photo_links"
    );
    const newest = r.rows[0]?.newest;
    if (!newest) return "not_configured";
    const ageHours = (Date.now() - new Date(newest).getTime()) / 36e5;
    return ageHours <= GALLERY_STALE_HOURS ? "ok" : "stale";
  } catch {
    return "error";
  }
}
async function refreshGalleryIfStale() {
  const state = await galleryHealth();
  if (state === "ok") return;
  try {
    await syncGallery();
  } catch {
  }
}
async function allPhotoLinks() {
  const r = await query(
    `SELECT pl.*, t.com_name
		   FROM photo_links pl
		   LEFT JOIN taxonomy_cache t ON t.species_code = pl.species_code
		  ORDER BY pl.species_code NULLS LAST, pl.taken_on DESC NULLS LAST`
  );
  return r.rows;
}
async function photoCountsBySpecies() {
  const r = await query(
    `SELECT species_code, COUNT(*) AS n FROM photo_links
		  WHERE species_code IS NOT NULL GROUP BY species_code`
  );
  return new Map(r.rows.map((row) => [row.species_code, Number(row.n)]));
}
const gallery = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  GALLERY_STALE_HOURS,
  allPhotoLinks,
  galleryHealth,
  photoCountsBySpecies,
  refreshGalleryIfStale,
  syncGallery
}, Symbol.toStringTag, { value: "Module" }));
export {
  allPhotoLinks as a,
  buildMatcher as b,
  gallery as c,
  galleryHealth as g,
  normalizeName as n,
  refreshGalleryIfStale as r,
  syncGallery as s
};
