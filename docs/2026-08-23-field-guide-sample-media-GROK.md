# Field-guide sample photos and sounds — GROK spec (td-86a2b6)

**Date:** 2026-08-23
**Status:** Binding implementation spec
**td:** `td-86a2b6` — field guide sample photos and sounds
**Reviews:** CODEX baseline `docs/2026-08-23-field-guide-sample-media-CODEX.md`;
AGY UX `docs/2026-08-23-field-guide-sample-media-AGY.md`.

GROK adversarial review of AGY: **ACCEPT WITH PINS**. AGY’s presentation
is the better species-page UX. CODEX already had the right storage and
worker model. Several AGY facts would ship bugs (xeno-canto “no key”,
migration `0021`, 44px targets, folding media into `enrichOneNow`).
This doc is the binding layer. No product code in this turn.

---

## 1. Product shape

One representative **photo** and up to **two sounds** (prefer song +
call) per species. Binaries stay on Wikimedia Commons / xeno-canto —
**metadata-only** in Postgres. The td mentioned storage cost; `cs.md`
forbids binaries on the shared droplet. Remote URLs are the source of
truth; playback is network-dependent.

Macaulay / eBird media: **link-out only**. Cornell third-party media
may need permission; the eBird API used here has no media endpoint.

Visible to every logged-in role. Mutations (refresh, backfill) are
**admin / worker** only. Loaders are **DB-only** — never Commons or
xeno-canto on GET.

---

## 2. What to keep from AGY (UX)

- One **Identification** card (photo + audio together), not a wedge
  titled “Identification samples” with iframes.
- Native `<audio>` for both Commons and xeno-canto streams, one
  page-level playback store (starting A pauses B). Song / Call badges.
- Store Commons `width`/`height` and CSS `aspect-ratio` so the photo
  box does not jump (CLS).
- Missing xeno-canto must not block a Commons photo/audio.
- Non-admin: omit the card when there is no media. Admin: explicit
  `no_media` / error, last-good still shown if present.
- A **single** `↻ Refresh species data` control (see §5 — one button,
  two jobs).

---

## 3. Binding pins (AGY corrections)

### 3.1 xeno-canto requires a key

xeno-canto **v2 went offline 2025-10-10**. Current API requires a key
([article 304](https://xeno-canto.org/article/304)). Document
`XENO_CANTO_API_KEY`. Missing key → `media_status=partial` (Wikimedia
still used), admin-visible config error. Do **not** call v2.

### 3.2 Migration is `0028`, not `0021`

`0021_alert_report_links.sql` already exists. Next file:
`backend/db/migrations/0028_species_media.sql`.

### 3.3 One Refresh button, two jobs — not one mega-pipeline

`enrichOneNow` is **wiki-only**, 20s `AbortSignal`, transactional wiki
writers. There is no `enrichSpecies()`. Folding Commons `imageinfo` +
xeno-canto into that function blows the wall budget and can fail a
successful wiki refresh.

**UX:** keep one `↻ Refresh species data`.
**Ops:** that action runs wiki as today **and** enqueues
`enrich_species_media` for the same code. Media failure must not hide
last-good wiki (or last-good media).

### 3.4 Do not reshuffle the species page

Insert Identification **after Your photos, before Finding this bird**.
Do **not** move About below reports. Unrelated to this td.

Identification still renders when the user has personal photos
(reference vs “your shots”). AGY’s mermaid already does Your photos →
Identification; “severe fragmentation” is overstated.

### 3.5 Native audio rules

- `preload="none"`, no autoplay, no service-worker caching of media.
- Direct HTTPS `media_url` only. If it is not a playable audio URL,
  omit the player and keep the source link — do not iframe by default.
- Play/pause **≥48px** (`cs.md`), not 44px.
- Components: `src/lib/components/SpeciesAudioPlayer.svelte` and
  `SpeciesMediaCard.svelte` (`$components`), **not** `src/components/`.

### 3.6 Schema

```sql
-- 0028_species_media.sql (sketch; grants via migrate_pg.sh)
CREATE TABLE species_media (
    media_id          SERIAL PRIMARY KEY,
    species_code      TEXT NOT NULL,
    kind              TEXT NOT NULL,  -- 'photo' | 'sound'
    vocalization_type TEXT,           -- 'song' | 'call' | 'alarm' | 'flight call' | NULL
    rank              SMALLINT NOT NULL DEFAULT 1,  -- 1 primary, 2 secondary
    provider          TEXT NOT NULL,  -- 'wikimedia_commons' | 'xeno_canto'
    provider_id       TEXT NOT NULL,
    media_url         TEXT NOT NULL,
    thumbnail_url     TEXT,
    source_url        TEXT NOT NULL,
    title             TEXT,
    creator           TEXT,           -- NULLABLE (anonymous Commons)
    license_code      TEXT NOT NULL,
    license_url       TEXT,
    location          TEXT,
    duration_seconds  REAL,
    width             INTEGER,
    height            INTEGER,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT species_media_kind_chk CHECK (kind IN ('photo', 'sound')),
    CONSTRAINT species_media_uq UNIQUE (species_code, kind, rank)
);
CREATE INDEX species_media_code_idx ON species_media (species_code);
```

No taxonomy FK (enrichment already survives taxonomy replace).

On `species_enrichment`:

- `media_status TEXT` — `ok` | `partial` | `no_media` | `error`
  (unset/null = never attempted)
- `media_fetched_at TIMESTAMPTZ` — last attempt
- `media_ok_at TIMESTAMPTZ` — last success (wiki `wiki_ok_at` precedent)
- `media_error TEXT` — sanitized, last error

Failed refresh: **keep last-good `species_media` rows**, set
`media_status=error`, stamp `media_fetched_at`, leave `media_ok_at`.
Transactional **replace** only after a successful candidate set.

Reject rows missing `source_url` or `license_code`. Missing creator is
not a reject — UI shows “Unknown”.

### 3.7 SPARQL: separate P18/P51 query

`buildSpeciesSparql` does **not** fetch P18/P51 today (P3444, IUCN,
mass, wingspan, iNat, xeno-canto **species id**, sitelink). Add a
**separate** query by QID for image/audio file titles. Do **not**
change the GROUP BY of the live facts query.

Then Commons `imageinfo` (URL, size, license, artist) in batches.
xeno-canto fills remaining sound slots using stored `cross_ids.xeno_canto_id`
when present, else sci-name + key; prefer one song and one call,
quality A/B, 3–60s, confirmed foreground; exclude uncertain IDs and
soundscapes. Dedup xeno rows already covered by a Commons P51 file.

### 3.8 Worker

Bounded `enrich_species_media` job, content-hashed chunks, 180-day
TTL, timeout / 429 `Retry-After`, last-good preservation. Extend
`scan_enrichment` to enqueue stale/missing media **in addition to**
wiki/AI partitions — small chunks, same 15-min drain, not a new
recurring singleton.

Measure in-scope coverage on refreshed `birds_test` before locking
chunk size. Fixture tests only — no live Commons/xeno in CI.

### 3.9 CLS

CSS `aspect-ratio` from stored width/height. If sizes missing: reserved
**4:3** box; still show the photo.

---

## 4. Page card (Identification)

After **Your photos** (gallery owner only; that card already exists),
before **Finding this bird**:

**Mobile (<640px):** photo (max-height ~280px, `object-fit: contain`)
then audio players.

**≥640px:** photo left, song/call players right.

Per item: creator (or Unknown), license + URL, source page ↗.
No autoplay. `preload="none"`.

Loader adds
`sampleMedia: { photo, sounds[], status, mediaError }` from DB only.

---

## 5. Tests

- Commons/xeno parsers: license required, creator optional, ranking,
  song/call pick, P51/xeno dedup, malformed rejection.
- DB: transactional replace; last-good on error; `no_media`; uniqueness;
  taxonomy delete/reinsert does not FK-fail.
- Worker: chunk/cancel/missing key/`Retry-After`/scrubbed errors
  (fixtures).
- Routes: DB-only load; empty/partial/full; card order; 48px play;
  `preload="none"`; admin-only refresh enqueue of **media job**.
- `enrichOneNow` still does **not** call the media gateway (20s wiki
  budget unchanged).
- Canary: `margod`, `comloo`, `annhum`. Browser 320 / 390 / 640 / 1024.

---

## 6. Sequencing

**A.** `0028` + media gateway + worker job + scan enqueue (no UI).
**B.** Identification card + unified Refresh enqueue + Help one-liner
(samples are Commons/xeno-canto, not stored here).

Dual review (CODEX1 + GROK). Hold for Gaylon’s deploy word. No
push/deploy from this spec.

---

## 7. Out of scope

Macaulay ingest. Binary cache on disk. Iframe-first players. New
primary nav. Moving About. Live provider calls in CI. Global 11k
pre-crawl (same defer as td-b7d021: scope = seen ∪ frequency ∪ photos).
