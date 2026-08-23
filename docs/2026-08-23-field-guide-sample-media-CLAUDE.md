# Field-guide sample photos and sounds — CLAUDE spec (td-86a2b6)

**Date:** 2026-08-23
**Status:** Binding implementation spec
**td:** `td-86a2b6` — field guide sample photos and sounds
**Reviews:** CODEX1 baseline (relay); AGY UX (relay);
GROK adversarial `docs/2026-08-23-field-guide-sample-media-GROK.md`.

CC1 critical review of GROK: **ACCEPT WITH CORRECTIONS**. GROK's
architectural decisions are sound. Ten implementation gaps make the spec
un-codeable as written — this document fills them and supersedes GROK
as the binding plan. No product code in this turn.

---

## GROK critical review

**What GROK gets right (keep as-is):**
- Metadata-only storage; binaries on Commons/xeno-canto (cs.md binary policy)
- Separate `species_media` table, not JSONB on `species_enrichment`
- Media-status columns on `species_enrichment` (parallel to wiki/ai stages)
- Migration number 0028
- Separate P18/P51 SPARQL query (do not touch the existing GROUP BY)
- One refresh button, two jobs (wiki inline + media enqueued separately)
- 48px touch targets, `preload="none"`, no autoplay
- Components in `src/lib/components/` (not `src/components/`)
- Page-level playback store (starting A pauses B)
- Last-good preservation on failed refresh
- Card after Your photos, before Finding this bird
- 180-day TTL, content-hashed chunks, extend `scan_enrichment`
- Schema shape (species_media columns, uniqueness constraint)

**What GROK gets wrong or leaves underspecified:**

1. **No actual SPARQL for P18/P51.** "Separate query by QID" is not implementable. Need the exact query, noting that P18/P51 return Commons **filenames**, not URLs.

2. **Commons imageinfo API is unspecified.** GROK never mentions the API that turns filenames into URLs, dimensions, licenses, and artists. This is the critical middle step between Wikidata and usable media.

3. **Xeno-canto v3 API details missing.** GROK says "requires a key (article 304)" but gives no endpoint, auth mechanism, query format, response shape, or filter parameters.

4. **P51 vocalization_type hardcoded wrong.** GROK §3.7 implies P51 audio is "song". P51 is just "audio" — the Commons file could be a call, alarm, or song. Set `vocalization_type = null` for Commons audio; let xeno-canto's typed metadata fill in the label.

5. **Worker handler structure not specified.** "Bounded enrich_species_media job" is insufficient. Need: chunk size, wall budget, politeness gap, rate-limit handling, spillover pattern, terminal transitions — matching the existing `runEnrichSpecies` patterns.

6. **`mediaDueCodes()` not specified.** GROK says "extend scan_enrichment" but doesn't give the scope query. Need the SQL using `SCOPE_SQL` with media-specific staleness conditions.

7. **`enqueueEnrichmentChunks` third partition not detailed.** Need the exact loop and chunk type.

8. **Dedup key additions not specified.** Need `enrichMediaChunk` and `enrichMediaOne` in `job-policy.ts`.

9. **Loader query shape not detailed.** "sampleMedia from DB only" needs the exact function signature, SQL, and return type.

10. **Component props not specified.** An implementer needs exact prop interfaces.

---

## 1. Product shape (unchanged from GROK)

One representative **photo** and up to **two sounds** (prefer song + call)
per species. Binaries stay on Wikimedia Commons / xeno-canto —
**metadata-only** in Postgres. Remote URLs are the source of truth;
playback is network-dependent.

Macaulay / eBird media: **link-out only** (no media endpoint in the
eBird API used here).

Visible to every logged-in role. Mutations (refresh, backfill) are
admin/worker only. Loaders are DB-only — never Commons or xeno-canto
on GET.

---

## 2. Migration `0028_species_media.sql`

**File:** `backend/db/migrations/0028_species_media.sql`

```sql
BEGIN;

-- 2a. Job type constraint: add enrich_species_media
ALTER TABLE jobs DROP CONSTRAINT jobs_type_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_type_check CHECK (type IN
    ('load_hotspots','load_region','analyze_counties',
     'refresh_loc','retry_loc','sync_lifelist','sync_taxonomy',
     'scan_need_alerts','enrich_species','scan_enrichment',
     'enrich_species_media'));

-- 2b. species_media: metadata-only, max ~3 rows per enriched species.
-- No FK to taxonomy_cache (same rationale as species_enrichment:
-- sync_taxonomy delete+reinserts must not FK-fail).
CREATE TABLE species_media (
    media_id          SERIAL PRIMARY KEY,
    species_code      TEXT NOT NULL,
    kind              TEXT NOT NULL,
    vocalization_type TEXT,
    rank              SMALLINT NOT NULL DEFAULT 1,
    provider          TEXT NOT NULL,
    provider_id       TEXT NOT NULL,
    media_url         TEXT NOT NULL,
    thumbnail_url     TEXT,
    source_url        TEXT NOT NULL,
    title             TEXT,
    creator           TEXT,
    license_code      TEXT NOT NULL,
    license_url       TEXT,
    location          TEXT,
    duration_seconds  REAL,
    width             INTEGER,
    height            INTEGER,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT species_media_kind_chk CHECK (kind IN ('photo', 'sound')),
    CONSTRAINT species_media_provider_chk CHECK (provider IN ('wikimedia_commons', 'xeno_canto')),
    CONSTRAINT species_media_uq UNIQUE (species_code, kind, rank)
);

CREATE INDEX species_media_code_idx ON species_media (species_code);

-- Grant access to birds_app (migration 0002's ALTER DEFAULT PRIVILEGES
-- covers new tables automatically; this is belt-and-braces).
GRANT SELECT ON species_media TO birds_app;
GRANT USAGE ON SEQUENCE species_media_media_id_seq TO birds_app;

-- 2c. Media-stage status columns on species_enrichment
ALTER TABLE species_enrichment
    ADD COLUMN media_status     TEXT CHECK (media_status IN ('ok','partial','no_media','error')),
    ADD COLUMN media_fetched_at TIMESTAMPTZ,
    ADD COLUMN media_ok_at      TIMESTAMPTZ,
    ADD COLUMN media_error      TEXT;

COMMIT;
```

**Design notes:**
- `UNIQUE (species_code, kind, rank)` enforces: at most 1 photo
  (kind='photo', rank=1), up to 2 sounds (kind='sound', rank=1 and
  rank=2).
- `provider_id`: Commons filename (e.g. `"Turdus migratorius.jpg"`) or
  xeno-canto recording ID (`"XC12345"`).
- `vocalization_type`: null for photos and for Commons audio (type
  unknown from Wikidata); `'song'`/`'call'` for xeno-canto.
- `media_status` semantics: `ok` = all sources answered with data;
  `partial` = at least one source returned data but another failed
  (e.g. no xeno-canto API key); `no_media` = both sources answered,
  neither had media; `error` = transient failure; null = never attempted.
- `media_ok_at` is stamped only on success (not error).
  `media_fetched_at` is stamped on every attempt. A failed refresh
  keeps existing `species_media` rows (last-good preservation).

---

## 3. Wikidata P18/P51 SPARQL

**File:** `src/lib/server/wikidata.ts`

P18 (image) and P51 (audio) are Wikidata property claims whose values
are **Commons filenames** (e.g. `"Marbled Godwit RWD.jpg"`), not URLs.
These filenames must then be resolved via the Commons imageinfo API (§4).

### 3a. New SPARQL builder

```typescript
/**
 * SPARQL for image (P18) and audio (P51) filenames by QID.
 * Returns Commons filenames, NOT URLs — caller uses Commons imageinfo
 * API to get actual media URLs, dimensions, license, artist.
 * Multi-valued claims are collapsed via MIN for determinism.
 */
export function buildMediaSparql(qids: readonly string[]): string {
    const bad = qids.filter(q => !/^Q\d+$/.test(q));
    if (bad.length > 0) throw new Error(`invalid QIDs: ${bad.slice(0, 3).join(', ')}`);
    const values = qids.map(q => `wd:${q}`).join(' ');
    return `SELECT ?item
      (MIN(?imgFile) AS ?image)
      (MIN(?audioFile) AS ?audio)
    WHERE {
      VALUES ?item { ${values} }
      OPTIONAL { ?item wdt:P18 ?imgFile . }
      OPTIONAL { ?item wdt:P51 ?audioFile . }
    }
    GROUP BY ?item`;
}
```

### 3b. New interface and fetch function

```typescript
export interface WikidataMediaRow {
    qid: string;
    imageFilename: string | null;   // Commons filename from P18
    audioFilename: string | null;   // Commons filename from P51
}

export async function fetchWikidataMedia(
    qids: readonly string[],
    opts: { signal?: AbortSignal; fetcher?: typeof fetch } = {}
): Promise<Map<string, WikidataMediaRow>>
```

Uses the existing `runSparql()` private helper (line 133 of wikidata.ts).
Parse `?item` URI → QID, `?image` / `?audio` → string filenames. Batch
limit: `WIKIDATA_BATCH_SIZE` (50).

---

## 4. Wikimedia Commons imageinfo gateway

**New file:** `src/lib/server/wikimedia-commons.ts`

The Commons API turns P18/P51 filenames into usable metadata.

### 4a. Endpoint and parameters

```
GET https://commons.wikimedia.org/w/api.php
  ?action=query
  &format=json
  &formatversion=2
  &prop=imageinfo
  &titles=File:{filename1}|File:{filename2}|...
  &iiprop=url|size|mime|extmetadata
  &iiextmetadatafilter=Artist|LicenseShortName|LicenseUrl
  &iiurlwidth=640
```

- Batch up to 50 titles per request (MediaWiki API limit).
- `User-Agent`: reuse the `userAgent()` pattern from wikidata.ts
  (`birds.gaylon.photos species enrichment (gaylon@vorwaller.net)`).
- Timeout: 30s.

### 4b. Response parsing

```typescript
export interface CommonsFileInfo {
    filename: string;
    url: string;                    // full-resolution URL
    thumbUrl: string | null;        // 640px thumbnail
    width: number | null;
    height: number | null;
    mimeType: string | null;
    artist: string | null;          // plain text, stripped from HTML
    licenseCode: string | null;     // e.g. "CC BY-SA 4.0"
    licenseUrl: string | null;
    duration: number | null;        // seconds, for audio/video
}
```

Key parsing details:
- `Artist` extmetadata is **HTML** (e.g.
  `<a href="...">John Doe</a>`). Strip tags, decode entities, trim.
  Null is valid (anonymous Commons uploads).
- `LicenseShortName` → `licenseCode`. Required for acceptance —
  reject rows without it.
- `thumburl` comes from the `iiurlwidth` parameter.
- `duration` is present in imageinfo for audio/video files.

### 4c. Helper functions

```typescript
export function commonsSourceUrl(filename: string): string
export function isPlayableAudio(mime: string | null): boolean
    // audio/ogg, audio/mpeg, audio/wav, audio/flac, audio/webm
export function isDisplayableImage(mime: string | null): boolean
    // image/jpeg, image/png, image/gif, image/webp, image/svg+xml
export function parseArtistHtml(html: string | null): string | null
```

### 4d. Error class

```typescript
export class CommonsError extends Error {
    constructor(message: string, public status: number,
                public rateLimited: boolean,
                public retryAfterMs: number | null)
}
```

Reuse `parseRetryAfterMs` from wikidata.ts for Retry-After handling.

---

## 5. Xeno-canto gateway

**New file:** `src/lib/server/xeno-canto.ts`

Xeno-canto v2 went offline 2025-10-10. Current API requires a key per
[article 304](https://xeno-canto.org/article/304).

### 5a. Endpoint and auth

```
GET https://xeno-canto.org/api/3/recordings?query={sciName}+q:A+q:B
Headers:
  User-Agent: birds.gaylon.photos species enrichment (gaylon@vorwaller.net)
  X-API-Key: {XENO_CANTO_API_KEY}
```

**Note:** The exact v3 endpoint and auth header name must be verified
against the live API at implementation time. Article 304 describes the
key requirement but the exact mechanism may differ (header vs query
param). If the endpoint has changed, check xeno-canto.org/explore/api
for the current docs.

### 5b. Query and filtering

Query by scientific name (e.g. `"Limosa fedoa"`). Server-side filters
via query string: `q:A q:B` (quality A or B only).

Post-fetch filters (applied in code):
- Duration 3–60 seconds (`parseDuration(r.length)`)
- Quality A or B (belt-and-braces after query filter)

Ranking: sort by quality (A before B), then shorter duration preferred.

### 5c. Recording selection

Pick **one song** (first recording whose `type` includes "song") and
**one call** (first whose `type` does NOT include "song" — covers
"call", "alarm call", "flight call", etc.).

```typescript
export function categorizeType(type: string): 'song' | 'call' {
    return type.toLowerCase().includes('song') ? 'song' : 'call';
}
```

### 5d. Return type

```typescript
export interface XenoCantoRecording {
    xcId: string;
    mediaUrl: string;          // direct stream URL
    sourceUrl: string;         // page URL on xeno-canto.org
    type: string;              // raw type string from API
    quality: string;           // "A" or "B"
    duration: number;          // seconds
    recordist: string;
    license: string;           // normalized, e.g. "CC BY-NC-SA 4.0"
    licenseUrl: string;
    location: string | null;
}

export async function fetchXenoCantoRecordings(
    sciName: string,
    opts: { signal?: AbortSignal; fetcher?: typeof fetch }
): Promise<{ song: XenoCantoRecording | null; call: XenoCantoRecording | null }>
```

### 5e. Missing key handling

```typescript
export function getXenoCantoApiKey(): string | null
```

If key is null, throw `XenoCantoError` with `rateLimited: false`. The
caller catches this and sets `media_status = 'partial'` (Commons photo
may still succeed). Admin sees "Partial media — some sources were
unavailable."

### 5f. License normalization

xeno-canto returns license URLs like
`"//creativecommons.org/licenses/by-nc-sa/4.0/"`. Normalize to
`"CC BY-NC-SA 4.0"`.

```typescript
function normalizeLicense(lic: string): string
function licenseUrl(license: string): string
export function parseDuration(dur: string): number  // "mm:ss" → seconds
```

---

## 6. Media enrichment orchestrator

**File:** `src/lib/server/species-enrichment.ts`

### 6a. New interfaces

```typescript
export interface MediaRow {
    media_id: number;
    species_code: string;
    kind: 'photo' | 'sound';
    vocalization_type: string | null;
    rank: number;
    provider: 'wikimedia_commons' | 'xeno_canto';
    provider_id: string;
    media_url: string;
    thumbnail_url: string | null;
    source_url: string;
    title: string | null;
    creator: string | null;
    license_code: string;
    license_url: string | null;
    location: string | null;
    duration_seconds: number | null;
    width: number | null;
    height: number | null;
}

export interface SampleMedia {
    photo: MediaRow | null;
    sounds: MediaRow[];
    status: string | null;
    mediaError: string | null;
}
```

### 6b. Update `EnrichmentRow`

Add four fields to the `EnrichmentRow` interface (line 588):

```typescript
media_status: string | null;
media_fetched_at: string | null;
media_ok_at: string | null;
media_error: string | null;
```

Update `getEnrichment()` SELECT (line 610) to include these four columns.

### 6c. DB gateway functions

**`upsertMediaOk(code, rows, status, exec?)`** — Transactional replace:
DELETE existing species_media rows for this code, INSERT new rows,
UPDATE species_enrichment with media_status/media_ok_at/media_fetched_at.
Uses the injectable `Exec` type for transaction support (same pattern as
`upsertResolution`/`upsertWikiOk`).

**`markMediaError(code, message)`** — Stamps media_status='error',
media_error, media_fetched_at. Uses INSERT ON CONFLICT so it works even
if the enrichment row doesn't exist yet (belt-and-braces). Existing
species_media rows are **preserved** (last-good).

**`getSpeciesMedia(code)`** — Two parallel queries:
`species_media WHERE species_code = $1 ORDER BY kind, rank` +
`species_enrichment.media_status/media_error WHERE species_code = $1`.
Returns `SampleMedia`.

**`mediaDueCodes()`** — In-scope codes whose media is due. Uses the
existing `SCOPE_SQL` constant (line 252):

```sql
${SCOPE_SQL}
 AND EXISTS (
   SELECT 1 FROM species_enrichment se
    WHERE se.species_code = tc.species_code
      AND se.wikidata_qid IS NOT NULL
      AND (
            se.media_status IS NULL
         OR (se.media_status IN ('ok','partial','no_media')
             AND se.media_fetched_at < NOW() - INTERVAL '${WIKI_REFRESH_DAYS} days')
         OR (se.media_status = 'error'
             AND se.media_fetched_at < NOW() - INTERVAL '${ERROR_RETRY_DAYS} days')
      )
 )
 ORDER BY 1
```

Requires `wikidata_qid IS NOT NULL` — media needs a QID for the P18/P51
SPARQL lookup.

**`mediaFresh(code)`** — Per-species freshness check for idempotent
overlap in chunks. Returns true if media_status is ok/partial/no_media
and media_fetched_at is within the refresh window.

### 6d. Orchestrator function

```typescript
export async function enrichSpeciesMedia(
    code: string,
    qid: string,
    sciName: string,
    opts: { signal?: AbortSignal; fetcher?: typeof fetch }
): Promise<'ok' | 'partial' | 'no_media'>
```

**Steps:**
1. `fetchWikidataMedia([qid])` → image/audio Commons filenames
2. `fetchCommonsFileInfo(filenames)` → URLs, dimensions, license, artist
3. Build photo candidate from P18 (if displayable image with license)
4. Build sound candidate from P51 (if playable audio with license) —
   **`vocalization_type = null`** (unknown type from Commons)
5. `fetchXenoCantoRecordings(sciName)` → song and call recordings
6. Fill remaining sound slots: if no Commons audio, xeno-canto song →
   rank=1, call → rank=2. If Commons audio occupies rank=1, xeno-canto
   call → rank=2.
7. Reject candidates missing `source_url` or `license_code`
8. Determine status: `ok` if all sources answered; `partial` if
   xeno-canto failed/missing key but Commons worked; `no_media` if both
   answered with nothing
9. `withTransaction` → `upsertMediaOk(code, candidates, status)`
10. Return status

**xeno-canto catch:** A xeno-canto failure (missing key, API error, rate
limit) sets `xcPartial = true` but does NOT fail the whole operation.
Commons photo is still written. Status becomes `'partial'`.

**Throws on fatal failure** (Commons + Wikidata both down). Caller
(`runEnrichSpeciesMedia`) catches and calls `markMediaError`.

---

## 7. Worker job handler

**File:** `src/lib/server/job-handlers.ts`

### 7a. Constants

```typescript
export const MEDIA_CHUNK_SIZE = 20;
export const MEDIA_WALL_BUDGET_MS = 8 * 60_000;  // 8 min
const MEDIA_POLITENESS_MS = 500;                   // between species
```

Smaller chunk than wiki enrichment (30) because each species hits two
external APIs.

### 7b. Payload type

```typescript
interface MediaEnrichPayload {
    codes: string[];
    force?: boolean;
}
```

### 7c. Handler: `runEnrichSpeciesMedia(job, ctx)`

Follows the `runEnrichSpecies` pattern (line 977):

1. Validate payload (codes non-empty, ≤ MEDIA_CHUNK_SIZE, valid species
   codes → `failJob` on invalid)
2. Pre-load QIDs from `species_enrichment` and sci names from
   `taxonomy_cache` for the whole chunk (two batch SELECTs)
3. Loop over codes:
   - Check `ctx.isDraining()` → `requeueInterrupted`
   - Check wall budget → spillover chunk
   - Skip if no QID for this code (unit_skipped, reason: 'no-qid')
   - Check `mediaFresh(code)` — skip if fresh, unless `force`
   - Politeness gap (500ms between species, after first)
   - Call `enrichSpeciesMedia(code, qid, sciName)`
   - On success: `unitsDone++`, record event with status
   - On rate limit (CommonsError/WikidataError/XenoCantoError with
     `rateLimited`): stop batch, schedule retry with `retryAfterMs`
   - On other error: `markMediaError(code, message)`,
     `unitsFailed++`, record event, continue
   - Check `cancelRequested` via `updateProgress`
4. Terminal transitions:
   - Cancel → `cancelRunningJob`
   - Rate limit → `scheduleRetry` or `failJob` if attempts exhausted
   - Budget remainder → spillover `enrich_species_media` chunk with
     `dedupKeys.enrichMediaChunk(budgetRemainder)`
   - Failed units → `scheduleRetry` (errors are not fresh, so re-run
     naturally targets only them)
   - All OK → `completeJob`

### 7d. Dispatch

Add to the `switch` in `runJob()` (line 1520), before the `default`:

```typescript
case 'enrich_species_media': {
    await runEnrichSpeciesMedia(job, ctx);
    return;
}
```

### 7e. Scan extension

In `enqueueEnrichmentChunks()` (line 849), add a third partition loop
**after** the wiki and AI loops:

```typescript
const mediaWork = (await mediaDueCodes())
    .filter(c => !wikiSet.has(c))  // skip codes about to get wiki-refreshed
    .sort();

for (let i = 0; i < mediaWork.length && enqueued < maxChunks; i += MEDIA_CHUNK_SIZE) {
    const codes = mediaWork.slice(i, i + MEDIA_CHUNK_SIZE);
    const r = await enqueueJob({
        type: 'enrich_species_media',
        payload: { codes } satisfies MediaEnrichPayload as unknown as Record<string, unknown>,
        dedupKey: dedupKeys.enrichMediaChunk(codes),
        requestedBy: adminId,
        label: `${codes.length} species media`,
    });
    if (r.deduped) deduped++;
    else enqueued++;
    covered += codes.length;
}
```

Add `mediaCandidates: number` to `EnrichmentWorkSummary`.

---

## 8. Job policy updates

**File:** `src/lib/server/job-policy.ts`

### 8a. Dedup keys (add to `dedupKeys` object, line 159)

```typescript
enrichMediaChunk: (codes: readonly string[]) => dedupKeyForLocs('enrich_media', codes),
enrichMediaOne: (code: string) => `enrich_media:one:${code}`,
```

### 8b. Type display name

Add to `TYPE_NAMES` (or equivalent display-name map):

```typescript
enrich_species_media: 'Species media',
```

---

## 9. Species page loader

**File:** `src/routes/species/[code]/+page.server.ts`

### 9a. Import

```typescript
import { getSpeciesMedia } from '$server/species-enrichment';
```

### 9b. Loader addition (after `getEnrichment(code)` at line 232)

```typescript
const sampleMedia = await getSpeciesMedia(code);
```

Add `sampleMedia` to the return object (line 234).

### 9c. Refresh action update

In `refresh_enrichment` (line 354), after the existing wiki + AI logic,
enqueue a media job. This runs regardless of the wiki outcome — media
uses the stored QID from a prior resolution, so it's independent:

```typescript
// Media refresh (never inline — hits two external APIs with
// different rate limits). Failure must not mask wiki/AI success.
try {
    await enqueueJob({
        type: 'enrich_species_media',
        payload: { codes: [code], force: true },
        dedupKey: dedupKeys.enrichMediaOne(code),
        requestedBy: locals.user!.id,
        label: comName,
    });
} catch {
    // Enqueue failure is non-fatal: media is a bonus, not gating.
}
```

---

## 10. UI components

### 10a. Playback store

**New file:** `src/lib/stores/playback.svelte.ts`

Module-scoped Svelte 5 rune state. Starting player A pauses player B.

```typescript
let activeElement = $state<HTMLAudioElement | null>(null);

export function registerPlay(el: HTMLAudioElement): void {
    if (activeElement && activeElement !== el) activeElement.pause();
    activeElement = el;
}

export function registerPause(el: HTMLAudioElement): void {
    if (activeElement === el) activeElement = null;
}
```

### 10b. `SpeciesAudioPlayer.svelte`

**New file:** `src/lib/components/SpeciesAudioPlayer.svelte`

Props:
```typescript
{
    mediaUrl: string;
    label: string;              // "Song", "Call", or "Sound"
    creator: string | null;
    licenseCode: string;
    licenseUrl: string | null;
    sourceUrl: string;
    durationSeconds: number | null;
}
```

Layout: row — 48px circular play/pause button (`flex: 0 0 48px`,
`border-radius: 50%`, `border: 2px solid var(--accent)`,
`background: var(--card)`, `color: var(--accent)`) + info column (label
badge, duration, "creator · source ↗ · license").

Native `<audio>` element with `preload="none"`. `onplay` calls
`registerPlay`, `onpause`/`onended` call `registerPause`.

Label badge: pill with `background: var(--accent-soft);
color: var(--accent)`, uppercase, 0.72rem, `border-radius: 6px`.

Credit line: 0.72rem, `color: var(--muted)`. Creator shows "Unknown"
when null.

Multiple players separated by `border-top: 1px solid var(--border)`.

### 10c. `SpeciesMediaCard.svelte`

**New file:** `src/lib/components/SpeciesMediaCard.svelte`

Props:
```typescript
{
    media: SampleMedia;
    comName: string;
    isAdmin?: boolean;
}
```

Renders a card titled **"Identification"** with:

**Mobile (<640px):** Column layout — photo (max-height ~280px,
`object-fit: contain`, `aspect-ratio` from stored width/height, fallback
4/3) then audio players below.

**≥640px:** Row layout — photo left (max-width 50%), audio players right.

Photo links to `source_url`. Below photo: credit line (creator ·
source ↗ · license).

Admin-only: shows `media_status = 'error'` message and `'partial'`
notice.

Card styles match the species page pattern: `background: var(--card);
border: 1px solid var(--border); border-radius: 8px; padding: 16px;
margin-bottom: 12px`.

---

## 11. Species page integration

**File:** `src/routes/species/[code]/+page.svelte`

### 11a. Import

```typescript
import SpeciesMediaCard from '$components/SpeciesMediaCard.svelte';
```

### 11b. Derived state

```typescript
const hasMedia = $derived(
    data.sampleMedia.photo != null || data.sampleMedia.sounds.length > 0
);
```

### 11c. Card placement (after line 213 — end of Your photos, before line 215 — Finding this bird)

```svelte
{#if hasMedia || (data.isAdmin && data.sampleMedia.status != null)}
    <SpeciesMediaCard
        media={data.sampleMedia}
        comName={data.taxon.com_name}
        isAdmin={data.isAdmin}
    />
{/if}
```

Non-admin: card visible only when there is actual media. Admin: also
visible when `media_status` is set (sees error/partial/no_media states).
Hidden for everyone when media has never been attempted (status is null).

### 11d. Attribution footer (update at line 609)

Add after the Wikipedia attribution:

```svelte
{#if hasMedia}
    · sample media from
    <a href="https://commons.wikimedia.org" target="_blank" rel="noopener">Wikimedia Commons</a>
    and <a href="https://xeno-canto.org" target="_blank" rel="noopener">xeno-canto</a>
{/if}
```

---

## 12. Environment configuration

**Files:** `.env.test.example`, prod `.env`

Add:
```
# Xeno-canto API (v3, required for bird sounds; see xeno-canto.org/article/304)
XENO_CANTO_API_KEY=
```

Missing key → `media_status='partial'` (Commons still used),
admin-visible config note. Not a hard error.

---

## 13. Sequencing

### Phase A — backend (no UI)
1. Migration `0028_species_media.sql`
2. `src/lib/server/wikimedia-commons.ts` (new)
3. `src/lib/server/xeno-canto.ts` (new)
4. `buildMediaSparql` / `fetchWikidataMedia` in `src/lib/server/wikidata.ts`
5. Media DB functions + `enrichSpeciesMedia` + `mediaDueCodes` in
   `src/lib/server/species-enrichment.ts`
6. `src/lib/server/job-policy.ts` — dedup keys, type name
7. `src/lib/server/job-handlers.ts` — `runEnrichSpeciesMedia` handler,
   media partition in `enqueueEnrichmentChunks`, `runJob` dispatch case
8. `.env.test.example` — `XENO_CANTO_API_KEY=`
9. Tests (fixture-based, no live API calls in CI)

### Phase B — UI
1. `src/lib/stores/playback.svelte.ts` (new)
2. `src/lib/components/SpeciesAudioPlayer.svelte` (new)
3. `src/lib/components/SpeciesMediaCard.svelte` (new)
4. `src/routes/species/[code]/+page.server.ts` — loader + refresh action
5. `src/routes/species/[code]/+page.svelte` — import, derived, card,
   attribution

Dual review (CODEX1 + GROK). Hold for deploy word.

---

## 14. Key invariants

1. **Loaders are DB-only.** `getSpeciesMedia()` never calls
   Commons/xeno-canto on GET.
2. **`enrichOneNow` is unchanged.** 20s wiki-only budget untouched.
   Media is always background.
3. **Last-good preservation.** Failed media refresh keeps existing
   `species_media` rows.
4. **Transactional replace.** `upsertMediaOk` DELETE + INSERT in one
   transaction.
5. **One button, two+ jobs.** `refresh_enrichment` runs wiki inline +
   enqueues AI + enqueues media. Media failure never masks wiki/AI
   success.
6. **No binaries on droplet.** Metadata URLs only.
7. **48px touch targets.** Play/pause buttons, all interactive elements.
8. **`preload="none"`, no autoplay, no service-worker caching.**
9. **Page-level playback coordination.** Starting one player pauses any
   other.
10. **WCAG AAA contrast.** All text uses `var(--muted)` (7.5:1 on white)
    or higher.
11. **CLS prevention.** CSS `aspect-ratio` from stored width/height;
    4:3 fallback.

---

## 15. Tests

**Pure helpers:** Commons `parseArtistHtml` (HTML → plain text),
xeno-canto `parseDuration` ("mm:ss" → seconds), `categorizeType` (type
string → song/call), `normalizeLicense`, `buildMediaSparql` (valid QIDs,
rejects invalid), `isPlayableAudio` / `isDisplayableImage`.

**DB:** Transactional replace (species_media rows swapped atomically);
last-good on error (markMediaError preserves existing rows); `no_media`
status with empty candidates; uniqueness constraint (kind+rank);
media_status transitions; taxonomy delete does not FK-fail.

**Worker:** Chunk validation (empty/oversized payload → fail); cancel +
drain; missing xeno-canto key → partial not error; rate limit (any
provider) → scheduleRetry with Retry-After; wall budget → spillover
chunk; scrubbed error text; freshness skip on non-force; `enrichOneNow`
still does NOT call media gateway (unchanged 20s budget).

**Routes:** DB-only load returns correct SampleMedia shape;
empty/partial/full rendering; card order (after Your photos, before
Finding this bird); 48px minimum on play button; `preload="none"` on all
audio elements; admin-only refresh enqueues `enrich_species_media` job;
non-admin does not see error/partial card when no media.

**Canary species:** `margod` (Marbled Godwit), `comloo` (Common Loon),
`annhum` (Anna's Hummingbird). Viewports: 320 / 390 / 640 / 1024.

---

## 16. Out of scope

Macaulay ingest. Binary cache on disk. Iframe-first players. New primary
nav. Moving About card. Live provider calls in CI. Global 11k pre-crawl
(same defer as td-b7d021: scope = seen ∪ frequency ∪ photos).
P51/xeno-canto dedup (if a P51 Commons file IS a xeno-canto recording
re-hosted on Commons, both may appear; acceptable for v1).

---

## Verification

1. Run migration: `npm run test:db:reset && npm run test:db:up` —
   confirm 0028 applies cleanly
2. Manually trigger media enrichment for a canary species via admin
   refresh button
3. Verify `species_media` rows appear with correct metadata
4. Verify Identification card renders on the species page at all
   breakpoints
5. Verify audio plays with `preload="none"` and only one plays at a time
6. Verify `npm run check` passes (svelte-check, 0 errors)
7. Verify refresh button enqueues both AI and media jobs (check `jobs`
   table)
8. Verify missing xeno-canto key → `media_status='partial'`, card still
   shows Commons photo
