# birds

Personal birding app — life-list **needs/targets**, a **trip planner** with
road-aware route optimization, and a link-out **photo gallery** — live at
**https://birds.gaylon.photos**.

Built with SvelteKit 2 (Svelte 5 runes) + adapter-node + TypeScript, PostgreSQL 17,
and hand-written scoped CSS (no Tailwind). A sibling to gaylon.photos /
gifts.gaylon.photos / madonnahist.gaylon.photos on a shared DigitalOcean droplet;
follows madonnahist's patterns for auth, deploy, test isolation, and co-location.

## Status

Phases 1–3 and most of Phase 4 are shipped and deployed:

- **Auth** — admin owner (argon2id) + a shared read-only `family` viewer login.
- **eBird** — per-user API key + credentialed life-list sync (Cornell CAS).
- **Near Me** / **Targets** — needs near home, place search, "rare this week", best-places ranking.
- **Gallery** — link-out to the public gaylon.photos birds collection with species matching + overrides.
- **Trips planner** — place/hotspot search, per-stop live needs counts, the real road route on the map, driving-distance route optimization (Google Directions), and Markdown export.
- **Maps** — Google Maps throughout; tap any spotting location for Map + Directions; photo GPS map.
- **Ops** — admin/tools (cache flush, counts), PWA (installable/offline shell), DB backup script.

Remaining/future work is tracked in `td` (P3) and the plan's "Future items."

## Docs & rules

- **Design + roadmap (authoritative):** [`docs/birds-app-design-V2-Fable-revision-plan.md`](docs/birds-app-design-V2-Fable-revision-plan.md) — the old V1 `docs/birds-app-design.md` is deprecated/removed.
- **Agent & contributor rules:** [`cs.md`](cs.md) (authoritative) — `CLAUDE.md` and `AGENTS.md` point to it.
- **Devlog:** [`docs/devlog/`](docs/devlog/).

## Develop

```sh
npm install
npm run dev        # vite dev on :5178
npm run check      # svelte-check — must be 0 errors before commit
npm run migrate    # apply DB migrations (backend/db/migrate_pg.sh)
npm run format     # prettier
```

Local Postgres: a **dedicated cluster on port 5436**, db `birds`. Use the
`npm run test:db:*` scripts for isolated test databases. See `cs.md` →
*Database & Schema* / *Local Test Isolation*.

## Deploy

```sh
bash scripts/deploy-to-DO.sh
```

Pulls origin/main, installs, builds, runs migrations, and reloads PM2 (app `birds`
on `:3003`, behind nginx + Cloudflare). Health-gated: the deploy requires
`db == ok`. Re-run is idempotent; `--skip-push` redeploys current origin/main.
