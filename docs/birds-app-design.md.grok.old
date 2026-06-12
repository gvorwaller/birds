# Birds App — Design (V1)

> Authoritative design for the personal birding web app at `birds.gaylon.photos`.
> This is the V1 spec. Future work (implementation by self or agent) should treat this as the source of truth. Update this doc (with version bumps) as decisions are made.
>
> **Inspiration sources**:
> - birdplan.app (https://birdplan.app/, GitHub rawcomposition/birdplan.app): interactive trip planning with saved hotspots + custom markers + notes, "My Trips" with timeframe, eBird target/life-list import (now auto), filter results by personal targets, target-species pages with ranked hotspots/filters/recent activity/frequency/monthly charts, recent species reports, map-centric UI.
> - lifeR / eBird-targets patterns (identify locations for your personal needs using recent eBird observations vs. your seen lists).
> - Original requirements: personal "needs" lists for any area, birds shown relative to your location (distance/travel decisions), recent counts + times (for "best time"), rich info links, + integrated personal gallery (move the ~50 bird photos from gaylon.photos).
>
> **Stack constraint**: SvelteKit (TS + runes), Postgres, cookie sessions + argon2id, Sharp + DO Spaces, hand-written scoped CSS (no Tailwind), same shared droplet as gaylonphotos/giftlist/madonnahist.
>
> madonnahist source patterns to copy/adapt are referenced with exact paths below (from the madonnahist checkout at time of writing).

## 1. Purpose
A lightweight, personal (initially single-user) web app for occasional birding. Primary uses:
- See my current personal eBird "needs" (targets) for any region/hotspot and decide where to travel based on real recent activity + distance from home.
- Plan trips (save hotspots + custom markers, notes, timeframes, multi-stop organization).
- Maintain a personal bird photo gallery with species tagging so photos appear alongside live eBird context.
- Quick access to species info + external resources while planning or reviewing.

Birding is not a primary activity — keep scope fun-sized and delightful rather than enterprise-grade. Deployed at `birds.gaylon.photos` on the existing shared DigitalOcean droplet.

## 2. Design Principles
- **Personal data + eBird ToS first**. User's life list, keys, trips, and photos are private. Respect eBird API ToS (personal key, attribution "Data from eBird.org", caching, no abuse of bulk data). Never store or redistribute full eBird datasets.
- **Reuse madonnahist patterns ruthlessly**. Auth, DB access, deploy, image handling, test isolation, nginx/PM2, health checks, route guards, etc. (see explicit paths below). This is a side project — do not reinvent.
- **History + decisions are visible**. Trips, target imports, photo uploads, and observations are logged where useful (light audit).
- **Gallery is first-class but not sacred archive**. Photos are personal memories + evidence; easy tagging by eBird species_code for linking to targets/recent data. Migration from gaylon.photos is a one-time operation.
- **Fun > perfect polish**. Quick wins (import seen list → see needs near home → add to a trip → upload a photo) in Phase 1. Modal confirmations for destructive actions (no toasts). Large touch targets for field use.
- **WCAG AAA + accessibility**. 7:1 contrast for all text (including muted). Color + text label for every status. Component-scoped CSS only.
- **Phased and bounded**. Clear "stop here if it's not fun anymore" boundaries. No heavy workers or AI pipelines in MVP.

## 3. Phases
### Phase 1 — Foundation (MVP, get it running and useful in days/weeks)
- New repo skeleton + deploy pipeline (adapted from madonnahist).
- Auth (copy madonnahist `src/lib/server/auth.ts` + `session.ts` + login routes; single admin user is fine).
- Per-user eBird API key storage (encrypted column) + basic client wrapper for v2 endpoints.
- Personal seen list import (CSV upload from eBird "Download my data" or life list export) → stored seen_species.
- Basic needs/targets explorer: pick region or hotspot (or geo), compute my needs, show recent observations of those needs (counts + times).
- Simple gallery: upload photos (S3 + Sharp), tag with species_code (taxonomy lookup for validation), list + lightbox per species or all. Link photos to eBird species page.
- Health endpoint + basic deploy (port 3003, /opt/birds, PM2 `birds`, nginx for birds.gaylon.photos).
- Local test isolation (modeled exactly on madonnahist `docs/local-test-environment.md` + test scripts).
- Map stub (lat/lon display + distance from saved home location).

### Phase 2 — Planner & Map Polish (the "birdplan.app" experience)
- Trip creation/management: name + timeframe, add saved hotspots or custom markers (with notes), reorder, map view.
- Hotspot + custom marker saving (global or per-trip).
- Needs-aware ranking: for a region or my saved places, show "best places for my current needs" (score = #needs with recent reports + recency + distance from home).
- Target species pages (inspired by birdplan): for a need, ranked hotspots with recent activity/frequency signals + monthly context (link to eBird bar charts where possible).
- Recent reports feed/filtered by my targets.
- Distance + "near me" (saved home lat/lon + optional browser geolocation). Haversine or simple PostGIS if desired later.
- Species intel page: your photos for that species + current/recent eBird needs context + external links (ebird.org/species/..., allaboutbirds, macaulaylibrary, xeno-canto).

### Phase 3 — Refinement & Daily Use
- Better caching of hotspots + recent obs (TTL per region/hotspot, background refresh option).
- Time-of-day / seasonality signals (aggregate observation times from cached recent + link to eBird bar charts).
- Improved gallery (EXIF capture for date/lat/lon, trip association, search/filter by species/month/location, "first photo of X").
- Trip export (simple printable or GPX notes).
- Basic admin/tools page for key management, seen list re-import, cache flush.

### Phase 4+ — Future Enhancements (only if still fun)
- eBird Status & Trends abundance overlays or "should be here now" predictions (requires separate data access).
- Sound upload + basic BirdNET / local ID integration (store recordings alongside photos).
- Multi-user (light sharing with family, read-only viewer role).
- Public or semi-public subsets (e.g., "best photos of this species" share links).
- Trip reports / narrative export (Markdown or simple book view of a trip).
- Offline support / PWA for field use (cached recent targets + photos).
- Notifications (email or simple polling) when a high-priority need is recently reported near home.
- Deeper taxonomy handling (subspecies, hybrids, eBird splits over time).
- Cross-linking to iNaturalist or other sources.
- Advanced trip optimization (multi-day, drive-time estimates, "maximize new needs" solver).
- Use of eBird bar chart downloads or product endpoints for frequency-based "best time of year" scoring.
- pgvector semantic search over notes/captions if notes grow.
- Backup automation for photos + DB (leverage existing droplet practices).

**Notes on future work**: Keep the "fun project" mindset. Revisit this doc before starting any Phase 4 item. Prefer small delightful features over big infrastructure.

## 4. Infrastructure (Shared Droplet)
- **SSH**: `root@134.199.211.199` (IP only — domain resolves to Cloudflare).
- **App dir**: `/opt/birds`
- **App port**: `3003` (next after 3002; update all references when co-locating).
- **PM2 process name**: `birds` (plus optional light `birds-cache` later).
- **Domain**: `birds.gaylon.photos` (Cloudflare Flexible / HTTP-only origin to nginx; coordinate Full/Strict TLS upgrade across all apps).
- **Nginx**: Separate server block (see `deploy/nginx.conf` template). `client_max_body_size` generous for photo uploads.
- **Logs**: `/var/log/nginx/birds.*.log`, PM2 logs under `/var/log/pm2/birds*.log`.
- **Secrets**: `.env` (mode 600, root-owned) on droplet. Use `--env-file=.env` for Node/PM2. Never commit real keys. eBird personal key and Spaces creds handled per-user or in private_data pattern if preferred.
- **Image storage**: DigitalOcean Spaces (reuse existing bucket with `birds/` object key prefix for isolation, or dedicated bucket later). Same `@aws-sdk/client-s3` + Sharp flow as madonnahist.
- **Postgres**: Same 5434 instance. Create dedicated database `birds`. Roles: `birds_owner` (migrations), `birds_app` (app runtime). Follow madonnahist migration grant patterns. Never target prod madonnahist DB from birds code/tests.
- **Deploy**: ALWAYS use adapted `scripts/deploy-to-DO.sh` (see madonnahist `scripts/deploy-to-DO.sh` for the exact flow: local preflight on main + clean tree, SSH to IP, git pull, npm ci, build, migrate, conditional nginx reload on checksum change, pm2 startOrReload, health gate). Update all hardcoded names/paths/ports/IPs/URLs.
- **PM2 ecosystem**: `ecosystem.config.cjs` (copy/adapt madonnahist version; one app entry for the SvelteKit build/index.js, optional future worker; node_args with --env-file; memory limits, log paths).
- **Health**: `/api/health` returns JSON `{ db: "ok"|"error", spaces: "...", version: "..." }`. Gate deploys on db==ok.

**Co-location awareness** (from madonnahist cs.md): shared RAM/disk/CPU with three other apps. Keep memory_restart reasonable. Disk for code/logs only (photos live in Spaces).

## 5. Tech Stack & Starter Files
- **Frontend/server**: SvelteKit (adapter-node), Svelte 5 runes, TypeScript.
- **DB**: `pg` (copy `src/lib/db.ts` pattern exactly: Pool, `query<T>`, `withTransaction`, `dbHealthCheck()`).
- **Auth**: cookie sessions (30-day sliding), argon2id (copy `src/lib/server/auth.ts` + `session.ts` + users/sessions tables + login route).
- **Images**: Sharp + @aws-sdk/client-s3 (reuse madonnahist `src/lib/ingest/spaces-upload.ts` + image/ helpers + credentials pattern).
- **Map**: Leaflet (recommended for quick start; or MapLibre). Simple haversine distance helper (server or client).
- **Other**: dotenv for local, tsx for scripts.
- **No Tailwind**, no utility frameworks. Component `<style>` blocks only.
- **Aliases** (svelte.config.js): `$components`, `$server` (exact match to madonnahist).

**Starter package.json** (model on madonnahist `package.json`; add `leaflet` + types if chosen):
(See madonnahist package.json for the exact devDeps + runtime deps list — keep versions similar.)

**svelte.config.js**: exact copy of madonnahist with adapter-node + the two aliases.

**Recommended initial src/routes/**: `+layout.server.ts` (load session user), `login/`, `api/health/`, protected areas (e.g. `/`, `/targets`, `/trips`, `/gallery`, `/species/[code]`, `/trips/[id]`).

## 6. eBird Integration
- **Key requirement**: Every user (initially one) must provide a personal eBird API key (https://ebird.org/api/keygen). Store encrypted (similar to password_hash) in a `user_ebird_keys` or extended users table. Never log the key.
- **Endpoints to use** (v2, see https://documenter.getpostman.com/view/664302/S1ENwy59):
  - `ref/taxonomy/ebird` (or /locale) — canonical species codes, names, family.
  - `ref/hotspot/geo?lat=...&lng=...&dist=...` and `ref/hotspot/REGIONCODE` — hotspot lists + coords.
  - `data/obs/REGIONCODE/recent`, `/recent/notable`, geo variants (`ebirdgeo`, nearestobs of species), hotspot recent.
  - `product/spplist/REGIONCODE` or hotspot species lists.
  - Region info as needed.
- **Personal needs/targets**:
  - Primary: user uploads CSV (from eBird My eBird → Download my data, or life list export). Parse species codes → populate `seen_species` (user_id, species_code, first_seen_date or source).
  - Secondary: for a chosen region/hotspot, fetch recent obs or spplist → diff against seen → my needs.
  - Store the "needs for this context" temporarily or cache per user/region.
- **Caching**: Aggressive (15–60 min for recent obs, longer for hotspots/taxonomy). Use DB tables `cached_hotspots`, `cached_observations` with fetched_at + region/locId key. Invalidate on user request.
- **Attribution & ToS**: Every page using eBird data shows "Data from eBird.org" + link. Respect rate limits (cache first). Personal key means per-user quotas.
- **"Best time" signals**: Observation timestamps from recent obs (aggregate hour-of-day), plus links to eBird bar charts. Simple seasonal from recent + historical context later.
- **Error handling**: Clear messages when key is missing/invalid or rate limited. Fallback to cached data.

Wrapper: `src/lib/ebird.ts` (typed fetch with key injection, error normalization, cache helper).

## 7. Data Model (Proposed DDL)
Create `backend/db/migrations/` (or top-level `migrations/`) + `migrate_pg.sh` (copy/adapt madonnahist `backend/db/migrate_pg.sh` — change app name, guard ports/db names).

Core tables (start minimal, evolve with migrations + audit_log pattern):

```sql
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'admin',  -- simple for v1
    home_lat DOUBLE PRECISION,
    home_lon DOUBLE PRECISION,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE sessions ( ... );  -- exact copy of madonnahist pattern

CREATE TABLE user_ebird_keys (
    user_id INTEGER PRIMARY KEY REFERENCES users(id),
    api_key_enc TEXT NOT NULL,  -- encrypt at rest (simple symmetric or per-user)
    updated_at TIMESTAMPTZ
);

CREATE TABLE seen_species (
    user_id INTEGER REFERENCES users,
    species_code TEXT NOT NULL,  -- eBird taxonomy code
    source TEXT,                 -- 'csv_import', 'manual', etc.
    first_seen DATE,
    PRIMARY KEY (user_id, species_code)
);

CREATE TABLE trips (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users,
    name TEXT NOT NULL,
    start_date DATE,
    end_date DATE,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE trip_stops (
    id SERIAL PRIMARY KEY,
    trip_id INTEGER REFERENCES trips ON DELETE CASCADE,
    sort_order INTEGER,
    hotspot_id TEXT,             -- eBird locId if official
    custom_name TEXT,
    lat DOUBLE PRECISION,
    lon DOUBLE PRECISION,
    notes TEXT,
    target_count_at_save INTEGER  -- snapshot of needs at time of add
);

-- Caching
CREATE TABLE cached_hotspots (... region/latlon key, data JSONB, fetched_at ...);
CREATE TABLE cached_observations (... similar, species_code or region filter ...);

CREATE TABLE bird_photos (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users,
    species_code TEXT NOT NULL,  -- canonical eBird code
    storage_key TEXT NOT NULL,   -- Spaces object key (birds/...)
    taken_at TIMESTAMPTZ,
    lat DOUBLE PRECISION,
    lon DOUBLE PRECISION,
    caption TEXT,
    trip_id INTEGER REFERENCES trips,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Optional lightweight: species_cache (name, family, etc. from taxonomy endpoint)
-- audit_log (user_id, action, entity, details) for imports/uploads/trip changes
```

Use `withTransaction` for import + photo upload flows. Add indexes on (user_id, species_code), trip dates, etc.

Denormalize lightly where it helps reads (e.g. cached needs count on a stop).

## 8. Gallery & Migration
- Upload flow: multipart → Sharp (generate derivatives if desired) → Spaces putObject with key `birds/{user}/{species}/{uuid}.jpg` → insert row with species_code (validated against taxonomy).
- Display: per-species grid (your photos sorted by date) + lightbox. On needs/target views, show "You have N photos of this species" with quick link.
- Tagging: on upload or bulk edit, search eBird taxonomy (autocomplete by common/scientific).
- Migration from gaylon.photos: one-time script (or manual). User provides source images + captions. Script or UI assists species assignment (fuzzy match on caption/filename against taxonomy). Record original source in metadata if desired. After migration the collection on gaylon.photos can be archived or linked.

Photos are private to the user (auth guard on all serving routes or use signed URLs if preferred).

## 9. UI Surfaces (High-Level Flows)
- **Dashboard / "Near Me"**: Saved home location + recent needs within radius. Map + list. Distance, last seen, count. "Plan trip to chase these".
- **Targets / Needs Explorer**: Region/hotspot selector or map click. List of my needs for that context + recent obs of them (with counts/times/observer). Filter by family, rarity (notable flag), has my photo, etc.
- **Trips**: List + "Create Trip" (name, dates). Detail: map, add stops (search hotspots or drop custom pin), notes per stop, "how many of my current needs reported here recently". Rank hotspots for this trip.
- **Hotspots / Places**: Global saved list (official + custom). Per place: recent activity, my needs here, add to trip.
- **My Gallery**: All photos or by species. Upload (drag or file). Bulk tag. Timeline or map of photo locations.
- **Species Page** (`/species/[code]`): Your photos (grid), current/recent needs context for this bird near home or selected region, external links, "Add recent sighting to a trip" shortcut.
- **Trip detail & export**: Printable summary, simple Markdown export.

Navigation: top nav (Dashboard, Targets, Trips, Gallery). Breadcrumbs. Mobile-friendly.

## 10. Commands (Adapt from madonnahist)
(See madonnahist CLAUDE.md + package.json + scripts/ for exact templates.)

```bash
npm run dev          # (use port 5178 or similar to avoid conflicts)
npm run build
npm run check
./scripts/migrate.sh # or backend/db/migrate_pg.sh adapted
npm run test:env
# ... test:db:* adapted for birds_test on 15434
./scripts/deploy-to-DO.sh
```

Dev server: `npx vite dev --host 127.0.0.1 --port 5178 --strictPort --mode test` (when using test env).

## 11. Local Test Environment Safety (Critical — Copy Rules)
Adapt **everything** from `docs/local-test-environment.md` and madonnahist CLAUDE.md/AGENTS.md:

- Dedicated `birds_test` DB on `127.0.0.1:15434`.
- `BIRDS_ENV=test`, `BIRDS_OBJECT_STORE=local`, `.local/birds-object-store-test/`.
- Guard scripts refuse prod ports (5433/5435), prod DB name, missing env var.
- Never seed real Spaces creds or prod eBird keys into test.
- Quick start commands exactly parallel to madonnahist (test:env, test:db:start, reset, migrate, invariants, then vite with mode test).

Create the same helper scripts in `scripts/`.

## 12. CSS & UI Rules (Non-Negotiable)
Exact copy from madonnahist cs.md + CLAUDE.md:
- No Tailwind. Component-scoped `<style>`.
- Destructive actions → modal confirmation (never toast).
- WCAG AAA (7:1) for all text.
- Status = color + text label.
- Large targets for touch/field use where relevant.

## 13. Future Enhancements & User's Notes
(See Phase 4+ list above.)

User notes (captured for the record):
- This is explicitly a "fun next project," not a primary need. Prioritize joy and learning over completeness.
- Gallery can remain lightweight or even stay primarily on gaylon.photos if integration proves overkill — the doc should note the option to keep them loosely coupled via links.
- eBird key handling must be obvious and safe (per-user, easy to rotate).
- Distance/travel decisions and "what's active near my needs right now" are the highest-value planning features.
- Keep the app personal and private by default.

## 14. Risks & Notes
- eBird rate limits & key validity: cache everything, surface clear errors, document how to get/rotate a key.
- Taxonomy changes: re-sync taxonomy periodically; store codes (stable) + display names.
- Shared droplet: watch memory during photo uploads + any map tile or image processing.
- Scope creep: the design doc itself is the guardrail. Any new feature must be added to a phase and justified against "still fun?"
- Legal/ToS: all eBird usage must carry attribution and follow the published terms.

## References & Copy Sources (madonnahist at time of writing)
- Full deploy + infra: `scripts/deploy-to-DO.sh`, `deploy/nginx.conf`, `ecosystem.config.cjs`, cs.md "Production Infrastructure".
- Auth/session: `src/lib/server/auth.ts`, `src/lib/server/session.ts`, login routes, users/sessions DDL patterns.
- DB: `src/lib/db.ts` (query, withTransaction, health).
- Images/Spaces: `src/lib/ingest/spaces-upload.ts`, `src/lib/image/`, `src/lib/credentials.ts`, Sharp + aws-sdk usage.
- Test isolation: `docs/local-test-environment.md`, `scripts/test-*.sh`, CLAUDE.md + AGENTS.md "Immediate Local Test Setup".
- SvelteKit base + health: `svelte.config.js`, `package.json`, `src/routes/api/health/+server.ts`, route layout patterns.
- Migration runner: `backend/db/migrate_pg.sh`.
- Route + layout patterns: `src/routes/+layout.server.ts` (load session user), protected pages like `src/routes/admin/...` and `src/routes/correct/...`.
- CSS/UI rules: `cs.md` (entire "CSS Rules", "Destructive actions", contrast sections) + CLAUDE.md.

eBird API reference: https://documenter.getpostman.com/view/664302/S1ENwy59

birdplan.app: https://birdplan.app/ + GitHub rawcomposition/birdplan.app (for UI inspiration only — we are not porting their stack).

## Quick Start After Doc Adoption
1. Follow "Local Test Environment Safety".
2. Copy/adapt the listed madonnahist files + patterns.
3. Run adapted test db setup + `npm run dev`.
4. Create user, save eBird key, import a small seen list, view needs + distance from home, upload photo tagged to species, health check returns ok, deploy script runs cleanly on droplet (new PM2 + nginx).

---

*End of authoritative design (V1). Update this file and bump version for any material changes.*