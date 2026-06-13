import { q as query, w as withTransaction } from "./db.js";
import { randomBytes, createCipheriv, createDecipheriv, createHash } from "node:crypto";
import { b as private_env } from "./shared-server.js";
function key() {
  const secret = private_env.EBIRD_KEY_SECRET;
  if (!secret) {
    throw new Error("EBIRD_KEY_SECRET is not set — cannot encrypt/decrypt eBird credentials");
  }
  return createHash("sha256").update(secret).digest();
}
function encryptSecret(plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64url")}.${tag.toString("base64url")}.${ct.toString("base64url")}`;
}
function decryptSecret(stored) {
  const [ivB64, tagB64, ctB64] = stored.split(".");
  if (!ivB64 || !tagB64 || !ctB64) {
    throw new Error("Stored credential has unexpected format");
  }
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(ivB64, "base64url"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ctB64, "base64url")),
    decipher.final()
  ]).toString("utf8");
}
const API = "https://api.ebird.org/v2";
class EbirdError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
    this.name = "EbirdError";
  }
}
async function getEbirdApiKey(userId) {
  const r = await query(
    "SELECT api_key_enc FROM user_ebird WHERE user_id = $1",
    [userId]
  );
  const enc = r.rows[0]?.api_key_enc;
  return enc ? decryptSecret(enc) : null;
}
async function ebirdFetch(path, apiKey) {
  let res;
  try {
    res = await fetch(`${API}${path}`, {
      headers: { "X-eBirdApiToken": apiKey, Accept: "application/json" }
    });
  } catch (err) {
    throw new EbirdError(`eBird API unreachable: ${err instanceof Error ? err.message : err}`);
  }
  if (res.status === 403 || res.status === 401) {
    throw new EbirdError("eBird API key is missing or invalid — check Settings.", res.status);
  }
  if (res.status === 429) {
    throw new EbirdError("eBird API rate limit hit — showing cached data if available.", 429);
  }
  if (!res.ok) {
    throw new EbirdError(`eBird API error ${res.status} for ${path}`, res.status);
  }
  return await res.json();
}
async function cachedFetch(cacheKey, ttlMinutes, fetcher) {
  const cached = await query(
    "SELECT payload, fetched_at FROM ebird_cache WHERE cache_key = $1",
    [cacheKey]
  );
  const row = cached.rows[0];
  const fresh = row && Date.now() - new Date(row.fetched_at).getTime() < ttlMinutes * 6e4;
  if (row && fresh) {
    return { data: row.payload, fetchedAt: new Date(row.fetched_at), stale: false };
  }
  try {
    const data = await fetcher();
    await query(
      `INSERT INTO ebird_cache (cache_key, payload, fetched_at)
			 VALUES ($1, $2, NOW())
			 ON CONFLICT (cache_key) DO UPDATE SET payload = $2, fetched_at = NOW()`,
      [cacheKey, JSON.stringify(data)]
    );
    return { data, fetchedAt: /* @__PURE__ */ new Date(), stale: false };
  } catch (err) {
    if (row) {
      return { data: row.payload, fetchedAt: new Date(row.fetched_at), stale: true };
    }
    throw err;
  }
}
const OBS_TTL_MIN = 30;
async function recentObs(apiKey, regionCode, back) {
  const region = regionCode.trim();
  return cachedFetch(
    `obs:${region}:${back}`,
    OBS_TTL_MIN,
    () => ebirdFetch(`/data/obs/${encodeURIComponent(region)}/recent?back=${back}`, apiKey)
  );
}
async function notableObs(apiKey, regionCode, back) {
  const region = regionCode.trim();
  return cachedFetch(
    `notable:${region}:${back}`,
    OBS_TTL_MIN,
    () => ebirdFetch(
      `/data/obs/${encodeURIComponent(region)}/recent/notable?back=${back}&detail=simple`,
      apiKey
    )
  );
}
async function recentNearbyObs(apiKey, lat, lng, distKm, back) {
  const la = lat.toFixed(2);
  const ln = lng.toFixed(2);
  return cachedFetch(
    `geo:${la}:${ln}:${distKm}:${back}`,
    OBS_TTL_MIN,
    () => ebirdFetch(
      `/data/obs/geo/recent?lat=${la}&lng=${ln}&dist=${distKm}&back=${back}`,
      apiKey
    )
  );
}
async function recentNearbySpeciesObs(apiKey, speciesCode, lat, lng, distKm, back) {
  const la = lat.toFixed(2);
  const ln = lng.toFixed(2);
  return cachedFetch(
    `geosp:${speciesCode}:${la}:${ln}:${distKm}:${back}`,
    OBS_TTL_MIN,
    () => ebirdFetch(
      `/data/obs/geo/recent/${encodeURIComponent(speciesCode)}?lat=${la}&lng=${ln}&dist=${distKm}&back=${back}`,
      apiKey
    )
  );
}
async function syncTaxonomy(apiKey) {
  const taxa = await ebirdFetch("/ref/taxonomy/ebird?fmt=json", apiKey);
  if (!Array.isArray(taxa) || taxa.length === 0) {
    throw new EbirdError("Taxonomy endpoint returned no rows — aborting sync.");
  }
  await withTransaction(async (client) => {
    await client.query("DELETE FROM taxonomy_cache");
    const BATCH = 500;
    for (let i = 0; i < taxa.length; i += BATCH) {
      const slice = taxa.slice(i, i + BATCH);
      const values = [];
      const params = [];
      slice.forEach((t, j) => {
        const o = j * 5;
        values.push(`($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5})`);
        params.push(t.speciesCode, t.comName, t.sciName, t.category, t.familyComName ?? null);
      });
      await client.query(
        `INSERT INTO taxonomy_cache (species_code, com_name, sci_name, category, family)
				 VALUES ${values.join(",")}
				 ON CONFLICT (species_code) DO UPDATE
				   SET com_name = EXCLUDED.com_name, sci_name = EXCLUDED.sci_name,
				       category = EXCLUDED.category, family = EXCLUDED.family`,
        params
      );
    }
    await client.query(`UPDATE taxonomy_cache SET fetched_at = NOW()`);
  });
  return taxa.length;
}
async function taxonomyCount() {
  const r = await query("SELECT COUNT(*) AS n FROM taxonomy_cache");
  return Number(r.rows[0]?.n ?? 0);
}
export {
  EbirdError as E,
  recentNearbyObs as a,
  recentObs as b,
  decryptSecret as d,
  encryptSecret as e,
  getEbirdApiKey as g,
  notableObs as n,
  recentNearbySpeciesObs as r,
  syncTaxonomy as s,
  taxonomyCount as t
};
