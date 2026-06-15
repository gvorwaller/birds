# CLAUDE.md

Guidance for AI coding agents (Claude Code et al.) working in this repo.

**Authoritative project rules live in [`cs.md`](./cs.md) — read it first.** It covers
production infrastructure (the shared DigitalOcean droplet), the eBird integration
"sacred rules", the link-out gallery policy, Google Maps usage, CSS/UI conventions,
the PostgreSQL setup (dedicated cluster on **port 5436**) + local test isolation,
migrations, secrets, and the evidence-based debugging mandate. `AGENTS.md` and this
file both defer to `cs.md` as the single source of truth.

## Session startup (required)
- Run `td usage --new-session` at conversation start (or after `/clear`) to see
  current work; `td usage -q` for subsequent reads. `td` is the task tracker.
  Do **not** `td close` completed work — use the `td review` → `td approve` flow
  (approval must come from a different session than the implementer).
- Skim the latest `docs/devlog/` entry for recent context.

## Where things are
- **Design + roadmap (authoritative):** `docs/birds-app-design-V2-Fable-revision-plan.md`
  (the old V1 `docs/birds-app-design.md` is deprecated and removed).
- **Devlog:** `docs/devlog/YYYY-MM-DD.md`.
- **Deploy:** `scripts/deploy-to-DO.sh` (pull → build → migrate → PM2 reload, health-gated).

## Local development & test database
There is **no separate dev cluster** locally — local work runs against the
**isolated test cluster**, which matches prod's major version:

- **PostgreSQL 17** (prod is 17.x; a PG16 binary cannot start a PG17 data dir —
  install with `brew install postgresql@17`, which is keg-only). The repo scripts
  locate the PG17 binaries via `scripts/lib/test-env.sh` → `find_pg_bin`, which
  prefers `opt/postgresql@17` and falls back to an unlinked Cellar install.
- **Cluster:** `127.0.0.1:15436`, database `birds_test`, data dir
  `.local/postgres-test/` (gitignored). Prod's `birds` on **5436** is never used
  locally. Reserved ports to avoid: 5433 (BTC), 5434 (madonnahist), 5435 (prod tunnel).
- **Bring it up:** `npm run test:db:up` (`scripts/test-db-up.sh`) — idempotent:
  inits the data dir on first run, starts it, ensures the `birds_owner`/`birds_app`
  roles + DB, then migrates. Stop with `npm run test:db:stop`; wipe with
  `npm run test:db:reset` then `test:db:up`.
- **Run the app against it:** `npm run dev:test` (`vite dev … --mode test`, loads
  `.env.test`) on port **5178**. Plain `npm run dev` expects a `.env` that doesn't
  exist locally — use `dev:test`.
- **Config:** `.env.test` (mode 600, gitignored; template `.env.test.example`) holds
  the test ports/passwords, `BIRDS_ENV=test` (required by the safety guards), the
  shared Google keys, and `EBIRD_KEY_SECRET`. Per `cs.md`, don't commit real secrets.

## Before you commit
- `npm run check` must pass (svelte-check, 0 errors).
- Debug from evidence (curl/logs), never assumption — see `cs.md` → Evidence-Based Debugging.
