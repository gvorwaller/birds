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

## Before you commit
- `npm run check` must pass (svelte-check, 0 errors).
- Debug from evidence (curl/logs), never assumption — see `cs.md` → Evidence-Based Debugging.
