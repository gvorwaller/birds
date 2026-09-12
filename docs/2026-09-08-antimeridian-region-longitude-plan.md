# td-57d9fc — Repair antimeridian region longitudes

Status: implementation plan only. Baseline: `7bc1643`, verified on production
with read-only queries on 2026-09-08. No application or production data changes
were made while preparing this plan.

## Findings that change the original ticket

1. `scripts/generate-regions.mjs:313` copies `body.longitude`; the arithmetic
   defect is in the provider values, not an averaging expression in our script.
   Its cached-response path returns the previously processed value immediately.
2. Production and the committed manifest both have 12 envelopes wider than
   180 degrees, and **zero** reversed (`min_lon > max_lon`) envelopes:
   `AQ`, `FJ`, `FJ-E`, `FJ-N`, `KI`, `NZ`, `NZ-NTL`, `RU`, `RU-CHU`, `UM`,
   `US`, `US-AK`. These are candidates for audit, not 12 proven corrections.
3. Antarctica is a genuine all-longitude polar extent. Its near-zero longitude
   is not evidence of the same defect; a unique longitudinal midpoint is not
   meaningful for a full-circle extent. Retain and document this exception.
4. Alaska's stored longitude is `0.311425`, but its ribbon row is already
   `band=60, country=US, west=true`. The defensive CASE in
   `src/lib/server/barchart.ts:448` protects its ribbon placement today.
5. Forecast pickers and the Best time of year selection also consume reference
   coordinates, through `regionCoordsFor` and `regionDistanceKm`. This is not
   solely a nearest-search dependency. Wide unsafe boxes return Infinity and
   are excluded from the nearest ladder; Antarctica's polar box remains usable.
6. The local generator checkpoint contains 3,922 processed info records and is
   marked complete. An ordinary delta run correctly refuses to replay it. A
   correction must not bypass that guard or pretend an old snapshot is fresh.

## Proposed scope and coordinate policy

Repair the stored longitude approximation and prevent future generator runs
from restoring the bad provider values. Preserve names, codes, parent links,
latitudes, source bounding boxes, and observation/frequency data. Keep nearest
search coverage and its bounds safeguards unchanged. Latitude redistribution
for tall regions belongs to `td-11aeb7`.

Do **not** apply the ribbon's complementary-arc formula to every wide envelope
and call the result a corrected centroid. A conventional min/max envelope has
lost the longitude distribution. Alaska's envelope spans about 359 degrees;
its complement is a roughly one-degree gap, not an extent containing Alaska.
The existing formula is adequate to put Alaska west of 100 W, but that is a
weaker requirement than repairing reference coordinates.

For an explicitly wrapped, validated box, its circular midpoint can be computed
as `normalize(west + ((east - west + 360) % 360) / 2)`, normalized to [-180, 180).
This is a bounding-box midpoint, not an area-weighted geographic centroid.
For ambiguous conventional envelopes, establish a corrected longitude from
verified region geometry or a documented provider correction. Where geometry
is used, derive its containing longitude arc from the complete geometry with
antimeridian handling, not from the two extrema of the current envelope.
Treat full-circle/polar geometry separately.

The distinction between wrapped and complementary boxes, and the separate
polar case, is described by [RFC 7946 sections 5.2–5.3](https://www.rfc-editor.org/rfc/rfc7946#section-5.2).
This is geometric guidance; it does not establish that eBird's bounds follow
GeoJSON semantics.

## Implementation sequence

### 1. Establish the exact correction set and provenance

- Capture the 12 current rows and Alaska's `band_locs` classification as the
  baseline. Check for drift again immediately before generating the migration.
- Inspect fresh eBird region-info responses only for the flagged codes, with
  existing pacing and credential protections. Retain the raw relevant source
  fields and fetch dates in the ignored audit workspace. Do not run a world
  refetch merely to fix these longitudes.
- For values still defective upstream, obtain geometry matching the exact
  eBird region, including outlying islands. Prefer matching eBird geometry;
  otherwise verify an authoritative boundary source and its explicit code
  crosswalk. A similar name or a mainland-only polygon is insufficient.
- Produce a review table with code, old longitude, proposed longitude, method,
  source URL/version/hash, and inclusion of outlying territory. Review Alaska,
  the US, Russia, Fiji, Kiribati, and the NZ subdivisions individually.
- Record Antarctica as an intentional global-polar exception. Do not force the
  migration to contain eight or twelve changes. Any unresolved non-polar region
  remains an explicit unfinished item; no guessed longitude is emitted.

**Remaining investigation:** the exact replacement source and values for the
11 non-polar candidates have not been verified. This step must settle them
before implementation can produce an approvable data migration.

### 2. Make correction a reproducible generator step

- Extract the coordinate policy into a pure script helper so its arithmetic and
  validation can be tested without requiring an API key or executing a fetch.
- Maintain a small reviewed correction manifest (proposed
  `backend/db/region-longitude-corrections.json`) for ambiguous provider values.
  Record code, expected source coordinate/bounds fingerprint, corrected
  longitude, derivation, source provenance, and reviewed exception status.
- Apply the policy at row normalization, after either cache or fresh response
  retrieval. Preserve raw provider values separately; do not repeatedly alter
  cached normalized values or compound the correction on subsequent runs.
- An exact reviewed fingerprint can reuse its correction. A provider change
  invalidates that correction and produces a specific validation failure for
  review; it must not silently overwrite a now-correct provider value.
- Reject newly encountered ambiguous non-polar envelopes at the generator's
  validation gate until classified. Ordinary valid regions retain their values.
- Add an explicit offline correction mode, e.g. `--apply-reviewed-corrections`,
  that reads the committed manifest plus reviewed corrections, needs no API
  key, and performs no fetches. Keep `--refetch`/resume snapshot rules intact
  for normal upstream deltas. The offline mode must not relabel cached data
  as newly fetched.
- `--dry-run` reports the complete changed-code set and before/after values,
  writes no migration or manifest, and fails if an unrelated field changes.

### 3. Emit a narrow, forward-only migration

- Generate the next available `00NN_regions_delta_YYYYMMDD.sql` and update the
  manifest from the same reviewed correction set. `0052` is currently next;
  determine the number again at implementation time.
- Use explicit expected old-value/bounds checks, accepting an already-correct
  value for safe repetition and rejecting unexpected drift. Require the
  reference rows to exist; no synthetic replacement rows.
- Apply the reviewed longitude delta only. A scoped UPDATE is preferable here
  to the normal generator's all-field upsert because this is a correction of
  existing reference values, not an upstream refresh. Do not update source_at
  to the correction date: retain the source snapshot date and record the
  correction date/provenance separately in the correction manifest/header.
- Leave applied migrations 0044, 0048, and 0050 unchanged. No embedded
  BEGIN/COMMIT: `backend/db/migrate_pg.sh` supplies the transaction.
- Verify manifest/database agreement after migration and zero changes to
  latitudes, bounds, taxonomy identifiers, and frequency tables.

### 4. Retain the ribbon guard for the first release

- Keep `rebuildBandRollup`'s CASE and the proximity safeguards for this release.
  Corrected longitudes do not make ambiguous source boxes safe distance bounds.
- Prove that Alaska stays in NA-West and all existing region contributions,
  sample totals, and species rollups stay unchanged. With latitudes and the
  guard unchanged, this release should not require a rollup rebuild.
- In a follow-up, compare guarded classification with direct corrected
  longitude classification for every eligible US/CA/MX subdivision. Remove
  the runtime CASE only after the correction migration is applied and equality
  is demonstrated. Keep historical migration 0050 intact; ensure a fresh full
  migration chain and subsequent rebuilds agree. Rebuild affected countries
  transactionally only if the comparison reveals an intentional change.

## Verification

- Pure helper: valid ordinary box, explicit wrap across +/-180, endpoint
  normalization, conventional near-global envelope, true polar/global extent,
  non-finite/invalid input, and legitimate near-zero longitude (e.g. Togo).
- Use recorded real provider/geometry fixtures for corrections. Pin the Alaska
  complementary-gap counterexample so a blanket '+180' repair cannot return.
- Generator: cached and fresh paths produce the same corrected value;
  corrections are idempotent; mismatched provenance rejects; offline mode has
  no network/API-key dependency; dry-run writes nothing; second application
  produces no new delta; unrelated manifest rows remain byte-equivalent in
  their data fields.
- On isolated `birds_test` at port 15436, test the delta from the existing seed
  state, all reviewed row values, unexpected-drift rejection, transaction
  rollback on failure, and safe repetition. Use the migration runner. Also
  verify a disposable fresh migration chain; do not reset a shared test
  database containing another task's work.
- Run focused `geo`, `regions`, ribbon/rollup and nearest-ladder tests. Preserve
  the existing Alaska-not-near-London check, unsafe ladder exclusions, and
  Antarctica polar-distance behavior. Check the before/after candidate set.
- Run `npm run check`, `npm run build`, and `git diff --check`. Review Help/About:
  add release copy only if the implementation creates a meaningful visible
  change; do not claim expanded nearest-search coverage from this repair.

## Release and completion

After implementation and authorized deployment through `scripts/deploy-to-DO.sh`,
verify the exact revision and DB/worker health, read back the corrected production
rows, compare Alaska and rollup invariants, and smoke the species seasonal chart
and forecast region pickers. Deployment reloads the app and worker, which clears
the process-lifetime reference-data cache.

If rollback is needed, use a reviewed compensating migration restoring recorded
prior values; reverting application code alone does not undo the data migration.

The ticket is ready for review when every flagged row is either corrected from
verified source evidence or documented as a justified exception, the generator
cannot silently restore the bad values, the delta has passed database checks,
and nearest/ribbon safeguards still hold. Removal of the guard remains a separate
follow-up unless explicitly included after those checks.
