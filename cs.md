# AI Assistant Session Guide

## Session Startup (Required)
1. Read `cs.md` (this file) — hard rules that override defaults
2. Read `docs/birds-app-design-V2-Fable-revision-plan.md` — authoritative design direction (the V1 doc `docs/birds-app-design.md.grok.old` is **deprecated**)
3. Review `docs/mockups/` — the approved UI reference (open `index.html`)
4. Check recent devlog entries in `docs/devlog/`
5. Run `td usage --new-session` to see current tasks

---

## Core Principles

### No Assumptions
- **Never guess** when you can verify — read source code, check config files, test directly
- **Never assume the user's environment** — don't guess what device, browser, or OS they're using
- **Never assume infrastructure details** — read deploy scripts, config files, and connection strings instead of guessing
- **State uncertainty explicitly** — if you must hypothesize, say so and ask for confirmation
- **Ask when uncertain** — one question is cheaper than one wrong assumption

### No Quick Fixes
- Find root causes, not band-aids
- Implement maintainable solutions
- If a fix requires multiple rounds, slow down and trace the data flow

### Evidence-Based Debugging (MANDATORY)
When diagnosing errors, follow this methodology instead of guessing:

1. **Read the relevant source code** before forming any hypothesis
2. **Trace the data flow** — client -> API route -> server module -> database -> response
3. **Test each layer independently** — use curl, direct DB queries, or browser devtools
4. **Compare expected vs actual** at each boundary
5. **Never assume a cause** — verify with evidence first, then propose a fix

> "No guesses, only solid evidence, tracing the code carefully."

---

## Production Infrastructure

### DigitalOcean Droplet (Shared with gaylonphotos, giftlist, madonnahist)
- **SSH**: `ssh root@134.199.211.199` — **always by IP**; the domain resolves to Cloudflare
- **App directory**: `/opt/birds`
- **App port**: `3003` (gaylonphotos=3000, giftlist=3001, madonnahist=3002, **birds=3003**)
- **Process manager**: PM2 (NOT systemd)
  - Restart: `pm2 restart ecosystem.config.cjs --update-env`
  - Logs: `pm2 logs birds --lines 30`
- **Domain**: `birds.gaylon.photos` — proxied through Cloudflare (HTTP-only origin)
- **No image storage** — the gallery is **link-out only**: photos live on gaylon.photos; this app stores only a `photo_links` cache of CDN URLs. No Sharp, no DO Spaces, no uploads.
- **Deploy script**: `./scripts/deploy-to-DO.sh` (adapt from madonnahist) — push, pull on droplet, install, build, run migrations, restart PM2, health-check, conditional nginx reload. **Never deploy manually.**
- **Health**: `/api/health` returns `{ db, gallery_source, version }`; only `db == "ok"` gates deploys

### Shared Droplet Awareness
Four apps share RAM/disk/CPU. This app has no image processing, so its footprint should stay small — keep PM2 `memory_restart` modest, keep `/opt/birds` to code + logs.

---

## Project-Specific Rules

### eBird Integration (SACRED RULES)
- **Never log eBird credentials** — neither the API key nor the account username/password. Both are stored encrypted in the DB (symmetric secret in `.env`).
- **Attribution is mandatory**: every page using eBird data shows "Data from eBird.org" with a link.
- **Cache first**: aggressive caching (15–60 min recent obs; taxonomy ~quarterly). Respect rate limits; surface clear errors when the key is missing/invalid or rate-limited; fall back to cached data.
- **Life-list sync uses the eBird web login** (unofficial interface). It WILL break occasionally when Cornell changes the flow — fail soft to the last synced list with a visible "sync stale" indicator; never hard-fail the app. Manual CSV import is the fallback.
- **Store species codes, not names** — eBird `species_code` is stable across taxonomy revisions; display names come from `taxonomy_cache`.

### Gallery (link-out only)
- Source of truth is `https://gaylon.photos/api/photos?collection=birds` (public). Sync replaces `photo_links` transactionally; species-name → species_code matching order: override table → common name → scientific name → unmatched (surfaced in UI).
- If gaylon.photos is unreachable, serve the stale cache; report `gallery_source: "error"` in health.
- Field renames in gaylonphotos' API require a matching update here — same owner, coordinate via that repo.

### Google Maps
- Reuse gaylonphotos' `PUBLIC_GOOGLE_MAPS_API_KEY` + `PUBLIC_GOOGLE_MAPS_MAP_ID` (in `gaylonphotos/.env`). The key's website restrictions already include `birds.gaylon.photos/*` and `http://127.0.0.1:8431/*` (mockups).
- Copy loader/marker patterns from `gaylonphotos/src/lib/google-maps.js` and `src/lib/components/common/Map.svelte` (AdvancedMarkerElement + InfoWindow).

### CSS & UI
- **No Tailwind. No utility frameworks.** Component-scoped `<style>` blocks only.
- **No toast notifications.** Use modal confirmation dialogs for destructive actions and feedback.
- WCAG AAA contrast ratios (7:1) for all text — including muted text
- Status badges always use color + text label — never color alone
- **Responsive is first-class**: mobile-first; two breakpoints only (640px, 1024px); fixed bottom nav <640px with safe-area inset; ≥48px tap targets; ≥16px input font; see `docs/mockups/mockup.css`

### Data Integrity
**NEVER:**
- Create synthetic or placeholder data (IDs, timestamps, dummy observations)
- Use fallback data to mask broken code
- Add schema columns/fields that don't exist
- Use hidden default values for DB/env parameters
- Modify production data without explicit user confirmation
- Target the prod madonnahist (or any sibling) DB from birds code or tests

**ALWAYS:**
- Use actual unique constraints from the schema
- Fix root causes when data is missing — never paper over with defaults
- Handle missing parameters as explicit errors with user notification
- Use `withTransaction` for multi-statement mutations (imports, photo-link sync)
- Validate at system boundaries (API routes), trust internal code

---

## Database & Schema (PostgreSQL)

### Connection
- **Engine**: Native PostgreSQL (Homebrew on dev, package install on prod) — no Docker
- **Port**: `5434` (shared instance; BTC Dashboard=5433, prod tunnel=5435 — never touch those)
- **Database**: `birds` · **Roles**: `birds_owner` (migrations), `birds_app` (runtime)
- **Query command**:
  ```bash
  psql -p 5434 -U birds_app -d birds -c "YOUR SQL HERE;"
  ```
- **Critical**: store timestamps as `TIMESTAMPTZ` in UTC; format for display only at the edge.

### Local Test Isolation (CRITICAL)
- Dedicated `birds_test` DB on `127.0.0.1:15434` — modeled exactly on madonnahist `docs/local-test-environment.md`
- `BIRDS_ENV=test` required by guard scripts; scripts refuse prod ports (5433/5435) and the prod DB name
- Never seed real eBird credentials into the test DB; gallery sync in tests uses fixture JSON, never live fetches
- Test dev server: `npx vite dev --host 127.0.0.1 --port 5178 --strictPort --mode test`

### Migrations
- DDL changes go in `backend/db/migrations/`, never inline in app code
- Always use `./backend/db/migrate_pg.sh` (adapted from madonnahist; tracks applied filenames) — **never raw `psql -f`**
- If you change DB state, CREATE A MIGRATION FILE — the deploy script runs migrations on prod automatically

### Secrets
- `.env` (mode 600, root-owned on prod; gitignored): `AUTH_SECRET`, `PGPASSWORD`/`MIGRATION_PGPASSWORD`, `EBIRD_KEY_SECRET` (encrypts stored eBird credentials)
- eBird API key + login credentials: encrypted columns in the DB, per-user
- Never commit real keys; never log secrets

### Type Safety Across the SQL Boundary
- **NUMERIC returns as strings** — use `Number()` or cast `::float8`, or you'll get string concatenation
- **JSONB returns as objects** — never `JSON.parse()` without a typeof guard
- **Timestamps** — `TIMESTAMPTZ`, UTC everywhere, format at the edge

---

## Development Workflow
- **Dev server port**: `5178` (5173 BTC, 5174 gaylonphotos, 5175 giftlist, 5176 madonnahist, **5178 birds**)
- **Always `cd` back** to project root after operations
- **Use absolute paths** when possible to avoid directory confusion
- **Commits**: Only commit when explicitly asked
- **Server restarts**: Ask the user to restart the dev server after config changes

### Verification Commands
- `npm run build` — production build (always run after code changes)
- `npm run check` — type checking + framework diagnostics, 0 warnings baseline
- Run both before committing. If `npm run check` reports new warnings, fix them before commit.

---

## State Tracking Tools
- `td` — task management CLI (run `td usage --new-session` at session start)
- `/nn` — append timestamped entry to today's devlog (`docs/devlog/YYYY-MM-DD.md`)
- `/review` — adversarial review loop before commits

---

## Historical Failures (Learn From These)
*(Inherited from sibling projects — same infrastructure pattern, same mistakes to avoid)*

- **SSH by domain**: Used `ssh root@<domain>` — timed out because domain resolves to Cloudflare, not the droplet. Always SSH by IP.
- **Wrong process manager**: Used `systemctl restart <app>` — failed because apps use PM2, not systemd. Always use `pm2 restart`.
- **Manual deploy**: Tried manual `ssh` + `npm run build` to deploy — timed out, host key failures. Deploy scripts handle everything correctly. Never deploy manually.
- **Synthetic data**: Synthetic IDs/timestamps added to mask broken inserts — broke uniqueness invariants. Never fabricate data to make code "work."
- **Missing `await`**: Async function returned a Promise that got spread/consumed as a value, yielding empty/undefined results. Always `await` async calls.
- **NUMERIC string concatenation**: PostgreSQL NUMERIC returned as string caused `"1" + "2" === "12"` instead of `3`. Cast or coerce at the boundary.
- **JSONB type drift**: SQLite returned JSON as strings; PostgreSQL JSONB returns objects. Code ported between them must handle both.
- **Missing import causing CPU spike**: A missing import threw `ReferenceError` in a hot loop, pegging CPU at 100%. Always run a smoke test after refactors.
- **Google Maps RefererNotAllowedMapError**: The shared Maps key is referrer-restricted. New origins (local mockup server, new subdomains) must be added to the key's Website restrictions in the gaylonphotos GCP project.

### Key Principle
> Assumptions are the enemy. Read the code. Read the config. Test the layer. Only then diagnose.
