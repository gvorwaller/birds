# Birds architecture in Fractal

This model describes selected behavior in the **local source checkout**, inspected on
2026-09-11 at `e4cfe74` with existing uncommitted family-enrichment and UI changes.
It does not assert that those edits are deployed, nor report live provider or worker health.

Open the `birds` project in the local Fractal studio. Start with **The big picture**,
then **Inside the web app** and **Inside background work**. Expand PostgreSQL or
External services to inspect their logical groups. The source files listed on every
element are relative to the Birds repository root.

## Scope and interpretation

- Web and worker are separate configured PM2 processes. Components inside each are
  responsibilities in that execution path, not independently deployed services.
- Shared server modules may run in both processes. Their placement here describes
  the caller path; it does not imply exclusive ownership of a module.
- PostgreSQL children are table groups in one database. Jobs are stored there;
  there is no separate queue broker in this model.
- External services is a presentation grouping, not a gateway or a shared trust boundary.
- Historical reporting coverage is distinct from frequency values. Missing coverage
  must not be interpreted as a species being absent.
- The current service worker does not cache offline pages. It does receive Web Push.
- Photos are linked from the external gallery; this app does not store uploaded media.
- This is selective coverage of active paths. Proxy configuration, deployment automation,
  every endpoint, cache and table, and provider internals are intentionally not expanded.
- No proposed components are included. Family enrichment includes local uncommitted work.

## Validate and export

From the Fractal installation:

```sh
bin/fractal validate --directory /Users/gaylonvorwaller/birds/docs/diagrams/fractal --json
bin/fractal export --directory /Users/gaylonvorwaller/birds/docs/diagrams/fractal --scene overview --output /path/to/birds-overview.svg
```

## Verification record

Validated all four scenes: 23 elements and 42 relationships. Independent reviewer
`review_birds_model` approved the source claims after direct article loading and
Admin model comparison were added to the dependency model. All referenced evidence
paths exist and all explicit element/relationship identities are unique.

All four SVG exports were visually inspected. Chromium loaded every registered scene
with HTTP 200 and no page errors; worker expansion and view restoration after reload
passed. These checks exercised Fractal with the authored model, not the Birds runtime.

## Relationship evidence

Relationships describe calls or data access, not measured network traffic. Edges may
roll up when containers are collapsed. Common Database access and Provider calls captions
keep the overview readable; the Action column below preserves the specific operation.
The inspector supplies component source evidence;
this table identifies the source of each authored relationship.

| Source | Target | Action | Evidence |
| --- | --- | --- | --- |
| `browser` | `web.access` | Pages & actions | `src/hooks.server.ts` |
| `web.access` | `web.discovery` | Scoped requests | `src/routes/+page.server.ts` |
| `web.access` | `web.planning` | Scoped requests | `src/routes/trips/[id]/+page.server.ts` |
| `web.access` | `web.operations` | Role-gated actions | `src/routes/admin/+page.server.ts` |
| `web.access` | `db.personal` | Sessions & owner scope | `src/lib/server/session.ts` |
| `web.discovery` | `db.personal` | Life list & study history | `src/routes/species/+page.server.ts` |
| `web.discovery` | `db.reference` | Reference & coverage | `src/routes/species/[code]/+page.server.ts` |
| `web.discovery` | `providers.ebird` | Recent reports | `src/lib/server/needs.ts` |
| `web.discovery` | `providers.geo` | Places & tides | `src/routes/species/[code]/+page.server.ts` |
| `web.discovery` | `db.jobs` | Queue enrichment | `src/routes/species/[code]/+page.server.ts` |
| `web.discovery` | `providers.sources` | Load first article now | `src/routes/species/[code]/+page.server.ts` |
| `web.planning` | `db.personal` | Trips, stops & shares | `src/lib/server/trips.ts` |
| `web.planning` | `db.reference` | Cached context | `src/lib/server/weather.ts` |
| `web.planning` | `providers.ebird` | Needs near stops | `src/lib/server/trips.ts` |
| `web.planning` | `providers.geo` | Places & conditions | `src/routes/trips/[id]/+page.server.ts` |
| `web.planning` | `providers.ai` | Field tips | `src/lib/server/ai-guidance.ts` |
| `web.planning` | `db.usage` | Meter guidance | `src/lib/server/ai-guidance.ts` |
| `web.operations` | `db.personal` | Account settings | `src/routes/settings/+page.server.ts` |
| `web.operations` | `db.jobs` | Queue, monitor & pause | `src/routes/admin/+page.server.ts` |
| `web.operations` | `db.usage` | Models & usage | `src/routes/admin/+page.server.ts` |
| `web.operations` | `providers.gallery` | Sync photo links | `src/routes/settings/+page.server.ts` |
| `web.operations` | `providers.ai` | Compare models | `src/routes/admin/+page.server.ts` |
| `web.operations` | `db.reference` | Store photo links | `src/lib/server/gallery.ts` |
| `browser` | `providers.geo` | Map rendering | `src/lib/google-maps.ts` |
| `worker.control` | `db.jobs` | Claim & heartbeat | `src/worker/index.ts` |
| `worker.control` | `worker.sync` | Dispatch jobs | `src/lib/server/job-handlers.ts` |
| `worker.control` | `worker.knowledge` | Dispatch jobs | `src/lib/server/job-handlers.ts` |
| `worker.control` | `worker.alerts` | Dispatch jobs | `src/lib/server/job-handlers.ts` |
| `worker.sync` | `providers.ebird` | Sync & load history | `src/lib/server/job-handlers.ts` |
| `worker.sync` | `db.personal` | Credentials & life list | `src/lib/server/ebird-account.ts` |
| `worker.sync` | `db.reference` | Taxonomy & frequencies | `src/lib/server/barchart.ts` |
| `worker.knowledge` | `providers.sources` | Fetch source material | `src/lib/server/job-handlers.ts` |
| `worker.knowledge` | `providers.ai` | Generate & verify | `src/lib/server/family-enrichment-ai.ts` |
| `worker.knowledge` | `db.reference` | Persist enrichment | `src/lib/server/species-enrichment.ts` |
| `worker.knowledge` | `db.usage` | Meter enrichment | `src/lib/server/ai-call.ts` |
| `worker.alerts` | `providers.ebird` | Nearby notable reports | `src/lib/server/job-handlers.ts` |
| `worker.alerts` | `db.personal` | Preferences & delivery | `src/lib/server/job-handlers.ts` |
| `worker.alerts` | `providers.push` | Send notifications | `src/lib/server/push.ts` |
| `providers.push` | `browser` | Deliver push | `src/service-worker.ts` |
| `worker.sync` | `db.jobs` | Progress & transitions | `src/lib/server/job-handlers.ts` |
| `worker.knowledge` | `db.jobs` | Progress & transitions | `src/lib/server/job-handlers.ts` |
| `worker.alerts` | `db.jobs` | Progress & transitions | `src/lib/server/job-handlers.ts` |
