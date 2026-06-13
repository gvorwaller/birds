# birds — Design (V2) + roadmap

> **Status (2026-06-13): SHIPPED & live at https://birds.gaylon.photos.**
> Phases 1–3 and most of Phase 4 are built and deployed: auth (admin owner, argon2id) · **family sharing** (shared read-only `family` viewer login — sees the owner's data, no writes, no credentials) · per-user eBird API key + credentialed life-list sync (Cornell CAS) · Near Me · Targets with place search, "rare this week", and best-places ranking · link-out gallery with species matching + override workflow · species pages · **Trips planner** (stops via place/eBird-hotspot search, per-stop live needs counts, route map, **smart nearest-neighbor route ordering**, Markdown export) · Google maps on Dashboard/Targets · photo GPS map · settings + admin/tools (cache flush, data counts) · **PWA** (installable + offline app shell) · DB backup script. Dedicated Postgres 17 cluster on port 5436; deploy via `scripts/deploy-to-DO.sh`.

## Future items (not yet built)

**Decision needed before building:**
- **Need-alert notifications** — "a high-priority need was just reported near home." Needs a channel decision — **email** (wire an email sender) or **web push** (VAPID keys) — plus a background poller/worker (the app currently has no worker process).

**Deferred (low urgency, on hold per owner):**
- Deeper taxonomy handling — subspecies / hybrids / eBird taxonomy splits over time.

**On hold — out of scope by design or externally gated:**
- **eBird Status & Trends abundance overlays** ("should be here now") — requires a separate, gated Cornell S&T data product, not the eBird API v2 the app uses.
- **Sound upload + BirdNET ID** — requires audio *storage*, which the link-out / no-media-storage design deliberately excludes; would mean reversing that core decision.
- **pgvector semantic search over notes** — overkill for a handful of short trip notes.
- **Public / curated photo subsets** — `gaylon.photos/birds` is already public; nothing to add here.

---

> **Amendments (2026-06-12, after mockup review):**
> 1. **Google Maps, not Leaflet** — reuse gaylon.photos' `PUBLIC_GOOGLE_MAPS_API_KEY` + `PUBLIC_GOOGLE_MAPS_MAP_ID` (in `gaylonphotos/.env`). Copy sources: `gaylonphotos/src/lib/google-maps.js` (loader) and `gaylonphotos/src/lib/components/common/Map.svelte` (AdvancedMarkerElement + InfoWindow patterns). This supersedes every Leaflet mention below.
> 2. **eBird life list via login, not CSV** — user (42-year programmer, accepts the risk on his own account) wants zero-friction sync. Primary mechanism: store eBird username + password encrypted (same symmetric-secret pattern as the API key), authenticate against eBird's web login (Cornell CAS at secure.birdcount.org), then fetch the life-list/targets CSV endpoints (`ebird.org/lifelist?fmt=csv`, region-scoped variants) with the session cookie. Auto-refresh on demand + before trip planning. Manual CSV upload remains only as a fallback. Add a `user_ebird_login` (username, password_enc) table alongside the API-key storage; never log credentials; expect occasional breakage when eBird changes the login flow (unofficial interface) and fail soft to the last synced list.
> 3. **"Rare this week" is an explicit Targets feature** — notable feed (`data/obs/{region}/recent/notable?back=7`) shown above the needs list, each entry badged Seen/Need against the life list. See `docs/mockups/targets.html` (Hancock County, ME scenario).
> 4. The §4 secrets claim "no keys sourced from siblings" is amended: the Google Maps public key/Map ID come from `gaylonphotos/.env`.

## Context

The V1 design doc for the birds app (birds.gaylon.photos) plans to **migrate** the ~49 bird photos from gaylon.photos into the new app with its own upload pipeline (Sharp + DO Spaces). The user has decided instead that the app should **link out** to the existing public gaylon.photos birds collection, must run **equally well on iPhone, iPad, and desktop**, and must be compliant with the sibling-app architecture (gaylonphotos / giftlist / madonnahist, all local repos). User confirmed via questions: **link-out only gallery** (no photo storage at all) and **keep Postgres** (madonnahist patterns).

Exploration verified:
- gaylon.photos exposes a **public** API `GET https://gaylon.photos/api/photos?collection=birds` (~49 photos; fields: `id`, `url`/`thumbnail` CDN URLs, `species` common name, `scientificName`, `date`, `gps{lat,lng}`, exif, `speciesAI`, `phash`). Photo pages: `https://gaylon.photos/birds/photo/{id}`. Spaces bucket is public-read → CDN thumbnail hotlinking is fine.
- Ports confirmed: gaylonphotos=3000, giftlist=3001, madonnahist=3002 → birds=3003 correct. **Correction**: giftlist's domain is `gifts.gaylon.photos`, not `giftlist.gaylon.photos`.
- All 19 madonnahist copy-source paths in the doc's References section exist.
- With Spaces dropped, **no API keys need to be sourced from sibling repos**. The birds app needs only new secrets: `AUTH_SECRET`, Postgres role passwords, and `EBIRD_KEY_SECRET` (symmetric secret to encrypt the per-user eBird key, which the user obtains from ebird.org/api/keygen).
- giftlist has the production mobile-first patterns to cite: `src/app.html` (viewport-fit=cover), `src/app.css` (18px+ base font, safe-area), `src/lib/components/BottomNav.svelte` (fixed bottom nav, 48px tap targets, `env(safe-area-inset-bottom)`).

## File to modify

Only one: `/Users/gaylonvorwaller/birds/docs/birds-app-design.md` (bump to V2, add changelog block under the header).

## Edits by section

**Header**: "Design (V2)"; changelog: V2 (2026-06-12) — gallery is link-out only, Sharp/Spaces removed, responsive design section added, key inventory clarified, factual corrections. Inspiration bullet: "move ~50 photos" → "linked gallery (photos stay on gaylon.photos)". Stack line: drop "Sharp + DO Spaces". Footer: "(V2)".

**§1 Purpose**: bullet 3 → photos hosted on public gaylon.photos birds collection; birds app stores no photos, caches a link index, links out.

**§2 Principles**: replace "Gallery is first-class…" with "Gallery lives on gaylon.photos" — birds consumes the public API, matches species → eBird `species_code`, shows "you have N photos" links; new photos still upload to gaylon.photos (which has OpenAI-vision species auto-ID). Audit bullet: "photo uploads" → "gallery syncs". Quick-win chain ends "…see your gaylon.photos shots on the species page".

**§3 Phases**:
- Phase 1: delete the upload-gallery bullet; add "Gallery link sync (read-only)": fetch gaylon.photos JSON, match species via cached taxonomy (override → common name → scientific name → unmatched), store in `photo_links`; "N photos" badges; `/photos` page of CDN thumbnails grouped by species linking out. Note sync depends on eBird key being saved (taxonomy). This is *less* work than the gallery it replaces — stays in MVP.
- Phase 2: "your photos" = gaylon.photos links/thumbnails.
- Phase 3: replace "Improved gallery (EXIF…)" with sync refinement (auto-refresh tuning, unmatched-species admin report, optional GPS map of photos — data already in payload).
- Phase 4+: "Backup automation for photos + DB" → "for DB"; sound bullet drops local storage; "public subsets" → already covered by public gaylon.photos/birds.

**§4 Infrastructure**:
- Delete Image storage bullet; nginx `client_max_body_size` note → "default fine, CSV imports are small"; co-location note → "no media storage; disk for code/logs only".
- Secrets bullet rewrite: `.env` (600, root) = `AUTH_SECRET` (new, `openssl rand -hex 32`), `PGPASSWORD`/`MIGRATION_PGPASSWORD` (new `birds_app`/`birds_owner` passwords), `EBIRD_KEY_SECRET` (new, encrypts per-user eBird key at rest). State explicitly: no keys sourced from siblings now Spaces is gone; if ever needed, sources are `gaylonphotos/.env` or madonnahist `private_data.api_credentials`.
- Add sibling port table incl. gifts.gaylon.photos correction.
- Health shape → `{ db, gallery_source: "ok"|"stale"|"error", version }`; only `db` gates deploys.
- New bullet: gallery source fetched via public URL (Cloudflare-cached; `http://127.0.0.1:3000` an optional optimization); CDN thumbnail hotlinking OK (public-read), use `loading="lazy"` + broken-image fallback.

**§5 Tech Stack**: delete Sharp/aws-sdk line → "No image processing or object-storage deps — gallery is CDN links only." Routes: `/gallery` → `/photos`. Optionally pin verified versions (SvelteKit ^2.22, Svelte ^5.17, adapter-node ^5.2.12, TS ^5.7).

**§6 eBird**: key encrypted with `EBIRD_KEY_SECRET` (simple symmetric, e.g. AES-GCM); add `taxonomy_cache` sub-bullet (persist `ref/taxonomy/ebird`, re-sync quarterly/on-demand; serves CSV validation + gallery matching).

**§7 Data Model**: delete `bird_photos`; add three tables (DDL in doc):
- `taxonomy_cache(species_code PK, com_name, sci_name, family, fetched_at)` + lower-name indexes.
- `photo_links(photo_id PK, species_code NULLable, source_species, source_sci_name, url, thumbnail, page_url, taken_on, lat, lng, match_method 'common'|'scientific'|'override'|'unmatched', fetched_at)`.
- `species_match_overrides(source_name PK normalized, species_code REFERENCES taxonomy_cache, note, created_at)` — keyed by name so overrides survive re-syncs.
- Sync = full replace of `photo_links` inside `withTransaction` (~49 rows). Normalization: lowercase/trim/strip diacritics.

**§8**: rename to "Gallery Integration (gaylon.photos)" and rewrite: API contract + consumed fields; lazy TTL refresh (24h on page load) + manual admin "Refresh now" (no cron/worker); `/photos` display (species groups → `/species/[code]`, thumbnails → gaylon.photos photo page `target="_blank" rel="noopener"`, unmatched group last with inline taxonomy autocomplete to create overrides); explicit **no uploads / no migration / no private serving**; failure mode = serve stale cache, `gallery_source:"error"`.

**§9 UI Surfaces**: "My Gallery" → "**My Photos**" (own surface kept for browse-all + unmatched-fixing; species pages get badge + thumbnail strip). Navigation → bottom nav (Home/Targets/Trips/Photos) fixed on phones, top nav ≥640px; see §12.

**§10 Commands**: unchanged; optionally add `npm run sync:photos`.

**§11 Test Safety**: delete `BIRDS_OBJECT_STORE=local` + `.local/birds-object-store-test/`; "Never seed prod eBird keys; gallery sync in tests uses fixture JSON (saved sample API response), never live fetches." Everything else verbatim.

**§12**: expand to "CSS, Responsive & UI Rules"; keep existing rules and add a Responsive subsection — this is the largest net-new content:
- iPhone/iPad/desktop equal first-class; mobile-first CSS (base = phone, `min-width` queries upward).
- Two breakpoints only: 640px (tablet) and 1024px (desktop).
- Copy from giftlist: `src/app.html` viewport meta w/ `viewport-fit=cover`; `src/app.css` 18px+ base font + safe-area; `BottomNav.svelte` fixed bottom nav, `env(safe-area-inset-bottom)`, ≥48×48px tap targets.
- Nav: <640px bottom nav; ≥640px top nav; content bottom-padding = nav height + safe-area.
- Touch: ≥48px targets; inputs ≥16px font (no iOS zoom); `touch-action: manipulation`.
- Layouts: list+map stacked on phone (map ~50vh fixed height, never hijacks scroll); side-by-side ≥1024px; tables collapse to cards <640px; madonnahist iPad correction UI = two-pane reference.
- Leaflet: contained fixed-height map; zoom controls bottom-right ≥44px above bottom nav; native pinch-zoom; large marker/popup hit areas; gesture-handling hint noted as optional.
- WCAG AAA stays (7:1 incl. muted + nav states); `prefers-reduced-motion`.

**§13 Notes**: mark the "gallery can stay on gaylon.photos" user note "**Adopted in V2** — this is now the design."

**§14 Risks**: drop upload-memory risk → "map tiles only"; add gaylon.photos API-drift risk (same-owner repo; sync fails soft to stale cache); add species-name-mismatch risk (AI-assigned names vs eBird taxonomy → override table + admin surfacing).

**References**: delete the Images/Spaces line (`spaces-upload.ts`, `src/lib/image/`, `credentials.ts` unless cited generically for encryption). Keep all other madonnahist paths (verified). Add: giftlist `src/app.html` / `src/app.css` / `src/lib/components/BottomNav.svelte`; gaylonphotos `src/routes/api/photos/+server.js` + public endpoint URLs + `/birds/photo/{id}` scheme.

**Quick Start**: step 4 → "run gallery sync, see your gaylon.photos thumbnails on a species page"; health expectation = new JSON shape.

## Sequencing

1. Deletions (Spaces/Sharp/bird_photos/uploads — §§4,5,7,8,11, References).
2. Replacements (gallery integration — §§2,3,7,8,9).
3. Net-new (§12 responsive, §4 secrets inventory, header changelog).
4. Factual fixes pass + final grep for `Spaces|Sharp|aws-sdk|upload|gallery|giftlist\.gaylon` to catch stragglers.

## Verification

- Grep the revised doc: zero remaining references to Sharp, aws-sdk, Spaces, photo uploads, `bird_photos`, `BIRDS_OBJECT_STORE`, `giftlist.gaylon.photos`.
- Confirm every file path cited in References exists (`ls` the madonnahist/giftlist/gaylonphotos paths).
- Sanity-check the API contract: `curl -s 'https://gaylon.photos/api/photos?collection=birds' | head` returns photos with `species`/`thumbnail` fields as documented.
- Read-through: doc is internally consistent (V2 header/footer, phases reference `/photos` not `/gallery`, health shape consistent across §4/Quick Start).
