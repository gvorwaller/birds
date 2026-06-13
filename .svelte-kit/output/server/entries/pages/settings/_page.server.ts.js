import { fail } from "@sveltejs/kit";
import { w as withTransaction, q as query } from "../../../chunks/db.js";
import { d as decryptSecret, g as getEbirdApiKey, s as syncTaxonomy, E as EbirdError, e as encryptSecret, t as taxonomyCount } from "../../../chunks/ebird.js";
import { b as buildMatcher, s as syncGallery } from "../../../chunks/gallery.js";
const CAS_LOGIN_URL = "https://secure.birdcount.org/cassso/login?service=" + encodeURIComponent("https://ebird.org/login/cas?portal=ebird");
const LIFELIST_CSV_URL = "https://ebird.org/lifelist?r=world&time=life&fmt=csv";
const UA = "birds.gaylon.photos personal life-list sync (single user)";
class EbirdLoginError extends Error {
  constructor(message) {
    super(message);
    this.name = "EbirdLoginError";
  }
}
class CookieJar {
  cookies = /* @__PURE__ */ new Map();
  absorb(res) {
    for (const sc of res.headers.getSetCookie()) {
      const [pair] = sc.split(";");
      const eq = pair.indexOf("=");
      if (eq > 0) {
        const name = pair.slice(0, eq).trim();
        const value = pair.slice(eq + 1).trim();
        if (value === "" || value.toLowerCase() === "deleted") this.cookies.delete(name);
        else this.cookies.set(name, value);
      }
    }
  }
  header() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}
async function fetchWithJar(url, jar, init) {
  const res = await fetch(url, {
    ...init,
    redirect: "manual",
    headers: { ...init?.headers ?? {}, Cookie: jar.header(), "User-Agent": UA }
  });
  jar.absorb(res);
  return res;
}
async function followRedirects(start, jar, maxHops = 8) {
  let res = start;
  let hops = 0;
  while (res.status >= 300 && res.status < 400 && hops < maxHops) {
    const loc = res.headers.get("location");
    if (!loc) break;
    const next = new URL(loc, res.url).toString();
    res = await fetchWithJar(next, jar);
    hops++;
  }
  return res;
}
function extractInput(html, name) {
  const re = new RegExp(
    `<input[^>]*name=["']${name}["'][^>]*value=["']([^"']*)["']|<input[^>]*value=["']([^"']*)["'][^>]*name=["']${name}["']`,
    "i"
  );
  const m = html.match(re);
  return m ? m[1] ?? m[2] ?? null : null;
}
async function casLogin(username, password) {
  const jar = new CookieJar();
  const formRes = await followRedirects(await fetchWithJar(CAS_LOGIN_URL, jar), jar);
  const formHtml = await formRes.text();
  const lt = extractInput(formHtml, "lt");
  const execution = extractInput(formHtml, "execution");
  if (!execution && !lt) {
    throw new EbirdLoginError(
      "eBird login page did not look like the expected CAS form — Cornell may have changed the flow."
    );
  }
  const body = new URLSearchParams({
    username,
    password,
    _eventId: "submit",
    ...lt ? { lt } : {},
    ...execution ? { execution } : {}
  });
  const loginRes = await fetchWithJar(formRes.url || CAS_LOGIN_URL, jar, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString()
  });
  if (loginRes.status === 200) {
    const html = await loginRes.text();
    if (/password|credentials|sign in/i.test(html)) {
      throw new EbirdLoginError("eBird rejected the username or password.");
    }
    throw new EbirdLoginError("Unexpected response from eBird login (no redirect).");
  }
  await followRedirects(loginRes, jar);
  return jar;
}
function splitCsvLine(line) {
  const out = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') inQ = false;
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}
function parseLifeListCsv(csv) {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length < 2) return { rows: [] };
  const header = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const col = (...names) => {
    for (const n of names) {
      const i = header.indexOf(n);
      if (i >= 0) return i;
    }
    return -1;
  };
  const iSpecies = col("species", "common name", "comname");
  const iSci = col("scientific name", "sciname");
  const iDate = col("date", "first seen", "firstseen");
  if (iSpecies < 0) {
    throw new Error(`Life-list CSV missing a Species column (saw: ${header.join(", ")})`);
  }
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const f = splitCsvLine(lines[i]);
    const raw = (f[iSpecies] ?? "").trim();
    if (!raw) continue;
    let comName = raw;
    let sciName = iSci >= 0 ? (f[iSci] ?? "").trim() || null : null;
    const dash = raw.indexOf(" - ");
    if (!sciName && dash > 0) {
      comName = raw.slice(0, dash).trim();
      sciName = raw.slice(dash + 3).trim() || null;
    }
    const dateRaw = iDate >= 0 ? (f[iDate] ?? "").trim() : "";
    const parsed = dateRaw ? new Date(dateRaw) : null;
    const firstSeen = parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : null;
    rows.push({ comName, sciName, firstSeen });
  }
  return { rows };
}
async function importLifeList(userId, parsed, source) {
  const matcher = await buildMatcher();
  if (matcher.taxonomySize === 0) {
    throw new Error("Taxonomy cache is empty — run the taxonomy sync first (Settings).");
  }
  const seen = /* @__PURE__ */ new Map();
  const unmatched = [];
  for (const row of parsed.rows) {
    const m = matcher.match(row.comName, row.sciName);
    if (m) {
      if (!seen.has(m.code) || row.firstSeen && !seen.get(m.code)) {
        seen.set(m.code, row.firstSeen);
      }
    } else {
      unmatched.push(row.comName);
    }
  }
  await withTransaction(async (client) => {
    await client.query(
      `DELETE FROM seen_species WHERE user_id = $1 AND source IN ('ebird_sync', 'csv_import')`,
      [userId]
    );
    const entries = [...seen.entries()];
    const BATCH = 500;
    for (let i = 0; i < entries.length; i += BATCH) {
      const slice = entries.slice(i, i + BATCH);
      const values = [];
      const params = [];
      slice.forEach(([code, firstSeen], j) => {
        const o = j * 4;
        values.push(`($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4})`);
        params.push(userId, code, source, firstSeen);
      });
      await client.query(
        `INSERT INTO seen_species (user_id, species_code, source, first_seen)
				 VALUES ${values.join(",")}
				 ON CONFLICT (user_id, species_code) DO UPDATE SET source = EXCLUDED.source`,
        params
      );
    }
  });
  return { total: parsed.rows.length, matched: seen.size, unmatched };
}
async function syncLifeListFromEbird(userId) {
  const creds = await query(
    "SELECT login_username_enc, login_password_enc FROM user_ebird WHERE user_id = $1",
    [userId]
  );
  const row = creds.rows[0];
  if (!row?.login_username_enc || !row.login_password_enc) {
    throw new EbirdLoginError("No eBird account credentials saved — add them in Settings.");
  }
  try {
    const jar = await casLogin(
      decryptSecret(row.login_username_enc),
      decryptSecret(row.login_password_enc)
    );
    const csvRes = await followRedirects(await fetchWithJar(LIFELIST_CSV_URL, jar), jar);
    const contentType = csvRes.headers.get("content-type") ?? "";
    const text = await csvRes.text();
    if (!csvRes.ok || contentType.includes("text/html")) {
      throw new EbirdLoginError(
        "eBird login succeeded but the life-list export did not return CSV — the flow may have changed."
      );
    }
    const result = await importLifeList(userId, parseLifeListCsv(text), "ebird_sync");
    await query(
      `UPDATE user_ebird SET life_list_synced_at = NOW(), life_list_status = 'ok', life_list_error = NULL
			 WHERE user_id = $1`,
      [userId]
    );
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await query(
      `UPDATE user_ebird SET life_list_status = 'error', life_list_error = $2 WHERE user_id = $1`,
      [userId, message]
    );
    throw err;
  }
}
const load = async ({ locals }) => {
  const userId = locals.user.id;
  const [ebird, user, taxCount, seenBySource, photoStats] = await Promise.all([
    query(
      `SELECT api_key_enc IS NOT NULL AS api_key_set,
			        (login_username_enc IS NOT NULL AND login_password_enc IS NOT NULL) AS login_set,
			        life_list_synced_at, life_list_status, life_list_error
			   FROM user_ebird WHERE user_id = $1`,
      [userId]
    ),
    query(
      "SELECT home_lat, home_lon FROM users WHERE id = $1",
      [userId]
    ),
    taxonomyCount(),
    query(
      "SELECT source, COUNT(*) AS n FROM seen_species WHERE user_id = $1 GROUP BY source",
      [userId]
    ),
    query(
      `SELECT COUNT(*) AS total, COUNT(species_code) AS matched FROM photo_links`
    )
  ]);
  return {
    ebird: ebird.rows[0] ?? {
      api_key_set: false,
      login_set: false,
      life_list_synced_at: null,
      life_list_status: null,
      life_list_error: null
    },
    home: user.rows[0] ?? { home_lat: null, home_lon: null },
    taxonomyCount: taxCount,
    seenBySource: seenBySource.rows.map((r) => ({ source: r.source, n: Number(r.n) })),
    photoTotal: Number(photoStats.rows[0]?.total ?? 0),
    photoMatched: Number(photoStats.rows[0]?.matched ?? 0)
  };
};
async function ensureEbirdRow(userId) {
  await query(`INSERT INTO user_ebird (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [
    userId
  ]);
}
const actions = {
  save_api_key: async ({ locals, request }) => {
    const userId = locals.user.id;
    const form = await request.formData();
    const key = (form.get("api_key") ?? "").toString().trim();
    if (!key) return fail(400, { error: "Enter an eBird API key (ebird.org/api/keygen)." });
    await ensureEbirdRow(userId);
    await query(`UPDATE user_ebird SET api_key_enc = $2, updated_at = NOW() WHERE user_id = $1`, [
      userId,
      encryptSecret(key)
    ]);
    return { ok: true, message: "eBird API key saved (encrypted)." };
  },
  save_login: async ({ locals, request }) => {
    const userId = locals.user.id;
    const form = await request.formData();
    const username = (form.get("ebird_username") ?? "").toString().trim();
    const password = (form.get("ebird_password") ?? "").toString();
    if (!username || !password) {
      return fail(400, { error: "Enter both the eBird username and password." });
    }
    await ensureEbirdRow(userId);
    await query(
      `UPDATE user_ebird SET login_username_enc = $2, login_password_enc = $3, updated_at = NOW()
			  WHERE user_id = $1`,
      [userId, encryptSecret(username), encryptSecret(password)]
    );
    return { ok: true, message: "eBird account credentials saved (encrypted)." };
  },
  save_home: async ({ locals, request }) => {
    const userId = locals.user.id;
    const form = await request.formData();
    const lat = Number(form.get("home_lat"));
    const lon = Number(form.get("home_lon"));
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      return fail(400, { error: "Enter a valid latitude and longitude." });
    }
    await query("UPDATE users SET home_lat = $2, home_lon = $3 WHERE id = $1", [userId, lat, lon]);
    return { ok: true, message: `Home location saved: ${lat.toFixed(4)}, ${lon.toFixed(4)}.` };
  },
  sync_taxonomy: async ({ locals }) => {
    const userId = locals.user.id;
    const apiKey = await getEbirdApiKey(userId);
    if (!apiKey) return fail(400, { error: "Save your eBird API key first." });
    try {
      const n = await syncTaxonomy(apiKey);
      return { ok: true, message: `Taxonomy synced: ${n} taxa.` };
    } catch (err) {
      return fail(502, {
        error: err instanceof EbirdError ? err.message : `Taxonomy sync failed: ${err}`
      });
    }
  },
  sync_lifelist: async ({ locals }) => {
    const userId = locals.user.id;
    try {
      const result = await syncLifeListFromEbird(userId);
      const unmatchedNote = result.unmatched.length > 0 ? ` ${result.unmatched.length} names didn't match the taxonomy (first few: ${result.unmatched.slice(0, 3).join(", ")}).` : "";
      return {
        ok: true,
        message: `Life list synced from eBird: ${result.matched} species.${unmatchedNote}`
      };
    } catch (err) {
      const msg = err instanceof EbirdLoginError || err instanceof Error ? err.message : String(err);
      return fail(502, {
        error: `Life-list sync failed (your last synced list is unchanged): ${msg}`
      });
    }
  },
  import_csv: async ({ locals, request }) => {
    const userId = locals.user.id;
    const form = await request.formData();
    const file = form.get("csv");
    if (!(file instanceof File) || file.size === 0) {
      return fail(400, { error: "Choose a CSV file exported from eBird." });
    }
    try {
      const parsed = parseLifeListCsv(await file.text());
      const result = await importLifeList(userId, parsed, "csv_import");
      return {
        ok: true,
        message: `CSV imported: ${result.matched} species (${result.unmatched.length} unmatched names).`
      };
    } catch (err) {
      return fail(400, { error: `CSV import failed: ${err instanceof Error ? err.message : err}` });
    }
  },
  sync_gallery: async () => {
    try {
      const result = await syncGallery();
      return {
        ok: true,
        message: `Gallery synced: ${result.total} photos, ${result.matched} matched, ${result.unmatched} unmatched.`
      };
    } catch (err) {
      return fail(502, { error: `Gallery sync failed: ${err instanceof Error ? err.message : err}` });
    }
  }
};
export {
  actions,
  load
};
