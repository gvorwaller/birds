# Birds UX phase 2A — independent review record

September 18, 2026 · td-2c866c under td-8ff597
Status: implemented and independently reviewed in test; ready for release review. Not committed or deployed.

## Intended result

Planner labels follow All species or My needs. Saved snapshots retain their
original feed, scope, window, geography, freshness and count, independently of
the current 14-day nearby needs count. Legacy counts say that their original
scope is unknown. No misleading planned/current delta remains.

Specification: [count meaning and saved context](phase-02a-trip-count-context.md).
Phase 2B comparative rankings remain open; see the
[ranking investigation](phase-02b-ranking-investigation.md).

## Review boundaries

The primary agent owns the specification, source review and live acceptance;
the lower-cost built-in implementer owns runtime, migration, tests and Help/About.
Only the test database receives migration 0061 during this phase. Phase 1 is
already deployed as `582f665`; no phase 2 code is part of that release.

## Primary live acceptance completed

- Restored the test owner's real 227-species life list from read-only production
  after the implementer's broad test run cleared shared fixture state. No
  credential changes or production writes. Early checks against the empty list
  were discarded and the completed checks below reran with real data.
- Saved All-species trip 22 and Needs trip 23, four stops each including the
  explicitly added unverified yard. Trip names and original location ids,
  coordinates, count, source, window and timestamps matched stored JSONB.
- Reloaded both: mode-correct snapshot labels and independent 14-day nearby
  counts. The reproduced Huguenot example now reads four planned needs and
  29 nearby needs, with their different scope stated and no delta claim.
- Legacy trip 18 states its original scope/window were not recorded.
- Owner export and family-viewer pages retain correct count meaning.
- Temporarily removed the test owner's API key and restored it in finally:
  saved snapshots remained visible without inventing a current zero.
- Desktop/390px: no horizontal overflow or browser script exceptions. Inspected
  the saved Needs stop screenshot directly; timestamp includes its timezone.
- Actual action-boundary checks rejected null entries, old open-tab missing
  context, changed count, changed coordinates, negative/fractional counts,
  duplicate stops, tampered signature, another account's token and viewer save.
  SvelteKit returned failure envelopes with status 400; viewer guard returned
  HTTP403. Database trip count unchanged by all rejection cases.

## Review corrections

- Use exactly the upstream `toFixed(2)` rounding for signed fetch-center values.
- Validate ISO timestamps and retain singular/plural neutral count labels.
- Correct remaining Help All-mode wording and remove internal phase terminology
  from the release note. Timestamp formatting must include a timezone for
  server-rendered exports.
- Carry batched reference verification into export/share external hotspot links;
  missing verification must never be treated as a positive match.
- Add loader/action and transactional persistence tests rather than relying only
  on isolated signing tests. Both test weaknesses were corrected and independently checked: mutated submissions now start with valid tokens; persistence tests call the actual transaction helper with a mocked driver.

## Final focused verification

| Gate | Result |
| --- | --- |
| Primary independent focused suite | 56 tests passed across 11 files: engine/runtime, hotspot identity, count context/token, planner action, actual transaction helper, export/share routes, and planner notes |
| Framework/type checks, primary final run | Zero errors, zero warnings |
| Implementer production build after runtime corrections | Web and worker build passed |
| Primary source review | No remaining blocking finding in phase 2A scope; missing export verification fails closed |
| Real test database | Migration 0061 applied, All/Needs save and JSONB reload verified |
| Chromium | Owner/viewer, legacy, missing-key snapshot, desktop/390px and 10 rejection cases passed |
| WebKit at 390px | All-species planner and saved Needs trip passed; no overflow/script errors |
| Public shared trip | Opened without cookies; correct planning/current context and verified/unverified external links; revoked afterward and 404 verified |
| Test health | Database, worker and gallery source ok |

Evidence: `work/birds-ux/audit/phase02a-*`. No physical iPhone was used.
No production phase 2 code, schema or data change; phase 1 remains live at `582f665`.
Phase 2B comparable rankings and coverage/progress remain outstanding.

## Broader suite limitation

The implementer ran the broad suite: 1,552 passed, five skipped, 12 failed
across family-quality-refresh, forecast-db, regions-db, species-enrichment and
species-study. Failures include mutable global-count/seed expectations and
five-second enrichment timeouts on the large corpus. These are outside the
changed trip paths, but no clean-baseline rerun was performed, so this review
does not classify all 12 as proven pre-existing. Evidence is preserved in
`work/birds-ux/audit/phase02a-full-suite.log`; follow-up recorded on the existing
test-isolation/corpus tickets td-b29d1c and td-c41126. The shared test list was
restored before the final live acceptance. The broad suite is not a passing gate.

## Owner release decision — September 19, 2026

Owner approved deployment and explicitly accepted the 12 broader-suite failures
as non-blocking for this release, recalling earlier one-off loading repairs.
The release still requires the focused gates, migration, live health and
changed-route smoke checks. No claim that the broad suite itself is green.
