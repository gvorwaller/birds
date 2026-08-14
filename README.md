# birds

Personal birding app — life-list **needs/targets**, a multi-year **forecast**
("which birds, where, and in what month"), a **trip planner** with road-aware
route optimization, and a link-out **photo gallery** — live at
**https://birds.gaylon.photos**.

Built with SvelteKit 2 (Svelte 5 runes) + adapter-node + TypeScript, PostgreSQL 17,
and hand-written scoped CSS (no Tailwind). A sibling to gaylon.photos /
gifts.gaylon.photos / madonnahist.gaylon.photos on a shared DigitalOcean droplet;
follows madonnahist's patterns for auth, deploy, test isolation, and co-location.

## Status

Phases 1–3 and most of Phase 4 are shipped and deployed:

- **Auth** — admin owner (argon2id) + a shared read-only `family` viewer login.
- **eBird** — per-user API key + credentialed life-list sync (Cornell CAS).
- **Home** — one screen (`/`) for needs around your saved home or any searched place: place search, saved search radius, notable reports, map, best-places ranking, and a life-list/photo summary. The former `/targets` route redirects here, query intact.
- **Forecast** (`/forecast`, td-854207) — trip planning from ~10 complete years of eBird checklist frequencies, stored locally after owner-triggered loads of eBird's bar-chart export (fetched via the same credentialed CAS session as life-list sync; politely throttled, cached ~a year). Two modes in one tabbed workspace: **"What can I see?"** (place + month → needed species banded Likely / Possible / long shots, with each species' best hotspots) and **"Where can I find this bird?"** (species + state → month curve, county ranking, hotspot drill-down on a map). `/forecast/data` inventories what's loaded (state → county → hotspot, collapsible) with refresh/retry. Frequency data is a global cache; the needs overlay is per user, and every non-viewer user needs their own eBird credentials to load new areas.
- **Gallery** — link-out to the public gaylon.photos birds collection with species matching + overrides.
- **Trips planner** — place/hotspot search, per-stop live needs counts, the real road route on the map, driving-distance route optimization (Google Directions), and Markdown export.
- **Maps** — Google Maps throughout; tap any spotting location for Map + Directions; photo GPS map.
- **Trips export API** — authenticated read-only JSON endpoint for importing Birds trip stops into the Trips app.
- **Ops** — admin/tools (cache flush, counts), installable PWA (the offline shell was deliberately neutralized — see commit 3de8665; the service worker is inert), `Cache-Control: private, no-store` on all dynamic responses, DB backup script.

Remaining/future work is tracked in `td` (P3) and the plan's "Future items."

## Docs & rules

- **Design + roadmap (authoritative):** [`docs/birds-app-design-V2-Fable-revision-plan.md`](docs/birds-app-design-V2-Fable-revision-plan.md) — the old V1 `docs/birds-app-design.md` is deprecated/removed.
- **Agent & contributor rules:** [`cs.md`](cs.md) (authoritative) — `CLAUDE.md` and `AGENTS.md` point to it.
- **Devlog:** [`docs/devlog/`](docs/devlog/).

## Develop

```sh
npm install
npm run dev        # vite dev on :5178
npm run dev:test   # test-mode app on 127.0.0.1:5178
npm run check      # svelte-check — must be 0 errors before commit
npm run migrate    # apply DB migrations (backend/db/migrate_pg.sh)
npm run format     # prettier
```

Local Postgres: a **dedicated cluster on port 5436**, db `birds`. Use the
`npm run test:db:*` scripts for isolated test databases. See `cs.md` →
_Database & Schema_ / _Local Test Isolation_.

## Trips integration

Birds exposes a private server-to-server export endpoint for Trips:

```
GET /api/internal/trip-places
Authorization: Bearer <BIRDS_TRIPS_API_TOKEN>
```

Required env:

```
BIRDS_TRIPS_API_TOKEN=<shared-token-matching-Trips>
BIRDS_TRIPS_EXPORT_USERNAME=<default-data-owning-username>
```

`BIRDS_TRIPS_EXPORT_USERNAME` must resolve to an admin/user account, not a viewer. Trips may also pass `?username=` and `?tripId=` to narrow the export. The endpoint returns normalized trip-stop places with source ids, trip context, coordinates, Google place ids when present, notes, target counts, and optional field tips.

Production Trips calls this endpoint by loopback (`http://127.0.0.1:3003`) because both apps run on the same droplet. The public hostname is not needed for the current deployment.

## Deploy

```sh
bash scripts/deploy-to-DO.sh
```

Pulls origin/main, installs, builds, runs migrations, and reloads PM2 (app `birds`
on `:3003`, behind nginx + Cloudflare). Health-gated: the deploy requires
`db == ok`. Re-run is idempotent; `--skip-push` redeploys current origin/main.

## Operational logs

PM2 captures app stdout/stderr:

```sh
ssh root@134.199.211.199 'pm2 logs birds --lines 200 --nostream'
ssh root@134.199.211.199 'grep "\[trip-places-export\]" /var/log/pm2/birds.*.log | tail -100'
```

Trips export requests emit token-free structured JSON lines with prefix `[trip-places-export]`. Trips sends `x-trips-import-request-id`, and Birds logs it as `request_id`, so a single import can be correlated across both apps:

```sh
ssh root@134.199.211.199 'grep "REQUEST_ID_HERE" /var/log/pm2/trips.*.log /var/log/pm2/birds.*.log'
```
