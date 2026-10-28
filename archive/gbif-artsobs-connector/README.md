# Archived: GBIF connector for Artsobservasjoner (td-c2913c, first design)

Not built, not tested and not deployed. Kept in case another country's sightings are only reachable through GBIF. Norway now uses `src/connectors/artsobs/`, which reads Artskart directly.

## Why it was replaced (2026-10-25…27)
- A live Trøndelag (NO-16) load through GBIF took 4 h 21 min for 516,440 records, with 46% of 3,405 requests answered 429. Deep search pages also stall. Through Artskart, Rogaland (425,795 records) took 7 min 6 s.
- GBIF's copy of Nordland matched Artskart within 0.1% for every year to 2025, but 2026 lagged by 3.4% (devlog 2026-10-26).
- For Norway, GBIF's one advantage, many countries through one API, doesn't matter.

The measurements and rules are in `docs/2026-10-21-external-sources-plan-CC.md` (Phase 0 findings 14–15 and "Phase 2 rev B"). The build and live runs are in `docs/devlog/2026-10-23.md`, `2026-10-25.md` and `2026-10-26.md`.

## What is here
- `connector/` is `src/connectors/gbif-artsobs/` as it was shelved: the GBIF client (429 pause, month slices halved until they fit GBIF's paging cap), records, aggregation (GADM municipality placement), the ingest client, tests and recorded GBIF fixtures. Observer names in the fixtures were replaced.
- `build-connector.mjs` is the esbuild bundle script as it was then.
- `app-wiring.patch` holds the changes outside the connector against `b50f11b`: the PM2 app, the deploy script's connector reload and gate, the `package.json` scripts, the `connector-token.mjs` docs and the Admin → Sources load summary.

## To reuse it
1. Copy `connector/` back under `src/connectors/<new-id>/`, and the build script's GBIF entry into `scripts/build-connector.mjs`.
2. It was written against ingest contract v1 before `observers` and `SUBSPECIES` were added (migration 0096). Re-check `payload.ts` and the tests against `src/lib/server/external-sources/contract.ts`.
3. Change the dataset key, the country's GADM ids and the region map, then rerun its tests and measure one live region before trusting any timing.
4. The search API it uses needs no account. Never commit GBIF credentials.
