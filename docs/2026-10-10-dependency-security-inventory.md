# Dependency and runtime security inventory

*td-626d50 · CC1 · 2026-10-10. Inventory only — nothing was upgraded. Evidence:
`npm audit`, `npm outdated`, `npm view`, and read-only commands on the droplet.*

## Summary

| # | What | Risk to prod | Fix | Effort | Recommendation |
|---|---|---|---|---|---|
| 1 | **SvelteKit 2.65.0** — unauthenticated ReDoS via the `Accept` header ([GHSA-29g2-3rmr-qm68](https://github.com/advisories/GHSA-29g2-3rmr-qm68)) | **Real but bounded**: the site is public and the advisory is unauthenticated; its impact is limited by the platform's request-header size limit (nginx `large_client_header_buffers`, Cloudflare), which this inventory did not measure — patch regardless (fixed in 2.70.2) | `@sveltejs/kit` → 2.70.3 (in the `^2` range) | Small: `npm update`, check, tests, deploy | **Do now** |
| 2 | **devalue 5.8.1** (bundled by Kit/Svelte) — 7 advisories, 3 high: quadratic/unbounded CPU in `uneval`/`stringify`, an unhandled rejection in `stringifyAsync` | Moderate: it serializes server data into pages; most input is ours, but user-entered text (trip names, notes) flows through it | devalue ≥ 5.9.3 (5.9.4 latest 5.x); comes with #1 + svelte 5.57.2 | Same change as #1 | **Do now, with #1** |
| 3 | **Droplet PostgreSQL 17.9** (17.11 available) | Two minor releases of PostgreSQL fixes not applied. Unattended-upgrades covers Ubuntu's own security pocket only, not the `pgdg` or `nodesource` repos | `apt upgrade postgresql-17` → restarts **all three clusters** (birds 5436, madonnahist 5434, trips 5437) | Small, but brief downtime for three apps | **Owner-scheduled window** |
| 4 | **Droplet kernel** 6.8.0-138 running; 6.8.0-146 installed; `/var/run/reboot-required` set; uptime ~6 weeks | Kernel security fixes are not active until a reboot | Reboot | ~1-2 min downtime, all four apps | **Same window as #3** |
| 5 | **Droplet Node.js 22.22.0** (22.23.3 available, nodesource) | Node patch releases are usually security releases | `apt upgrade nodejs` + PM2 restart of every app | Small, same window | **Same window as #3** |
| 6 | `cookie` 0.6.0 (via Kit 2) — out-of-range characters accepted in cookie name/path/domain ([GHSA-pxg6-pf52-xh8x](https://github.com/advisories/GHSA-pxg6-pf52-xh8x)) | Low: the app never builds cookie names/paths from user input | Kit 2.x pins `^0.6.0`; only Kit 3 or an npm override fixes it | — | **Accept** (record here) |
| 7 | Dev/build-only: vitest 4.1.9 (+ `@vitest/mocker`), vite 6.4.3 → postcss / nanoid / source-map-js | None in prod (not in the server bundle; the build reads only our own sources) | vitest 4.1.11, vite 6.4.4 (in range) | Tiny | **Do with #1** |
| 8 | Node 22 LTS ends **2027-04-30**; local dev runs Node 24, prod runs 22 | Planning: the dev/prod mismatch can hide runtime differences | Move prod to Node 24 LTS before April 2027 (worker build targets `node22`) | Medium | **Later ticket, early 2027** |
| 9 | Majors available: Kit 3, Vite 8, Vitest 5, TypeScript 7, adapter-node 6, vite-plugin-svelte 7, dotenv 18 | None today | Planned migration, not a security fix | Large | **Not now** |

`npm audit --omit=dev` reports **0** — misleading for a SvelteKit app: Kit is
a devDependency but is compiled into the server bundle that runs in prod, so
#1/#2 do apply to production.

Not affected: two of Kit's advisories are for remote functions; the repo has
no `*.remote.ts`.

## Runtime versions (2026-10-10)

| Component | Prod (droplet) | Local (M4) |
|---|---|---|
| OS | Ubuntu 24.04.4 LTS | macOS (Darwin 25.5) |
| Node | 22.22.0 (nodesource) | 24.3.0 |
| npm | 10.9.4 | 11.5.2 |
| PostgreSQL | 17.9 (pgdg; 3 clusters on one install) | 17 (Homebrew) |
| PM2 | 6.0.14 | — |
| nginx | 1.24.0 (Ubuntu) | — |
| Kernel | 6.8.0-138 running, 6.8.0-146 installed | — |

## Prod-relevant packages (`npm ls --depth=0` on the droplet)

`@sveltejs/kit` 2.65.0, `svelte` 5.56.3, `@sveltejs/adapter-node` 5.5.4,
`pg` 8.21.0, `argon2` 0.44.0, `web-push` 3.6.7, `dotenv` 17.4.2. The worker
bundle (esbuild, target `node22`) keeps `pg`, `argon2`, `web-push` external.

## Proposed remediation tickets

- **A (do now):** in-range bumps — Kit 2.70.3, Svelte 5.57.2 (→ devalue
  5.9.x), vitest 4.1.11, vite 6.4.4; then `npm run check`, build, full suite,
  CODEX1 review, deploy. Re-run `npm audit` and record what remains (expected:
  `cookie` only).
- **B (owner window):** droplet maintenance covering PostgreSQL 17.11, Node
  22.23.3 and the pending kernel reboot. All four apps restart. Owner picks
  the time. Decide separately whether to add `pgdg`/`nodesource` to
  unattended-upgrades (automatic PG restarts) or keep these manual with a
  monthly check.
- **C (early 2027):** Node 24 LTS on prod + worker build target.

## Monthly check (automated)

`scripts/monthly-update-check.sh` runs on the 1st of each month at 09:23 from
the LaunchAgent `com.gaylon.birds-update-check` (plist in `scripts/launchd/`;
launchd runs a missed slot at the next wake). Read-only. It checks the
droplet's pending pgdg/nodesource/kernel/nginx/openssl packages, a pending
reboot and Node 22's end of life, plus birds' `npm audit` and in-range
updates. Findings listed in `scripts/update-check-accepted.txt` (or inherited
only through accepted packages) are reported as information. Every run writes
`~/Library/Logs/birds-update-check/<YYYY-MM>.md`; if anything needs action
it files one td task "Monthly update check <YYYY-MM>" (never duplicated) and
posts a macOS notification. Applying droplet updates stays manual (owner,
2026-10-10).
