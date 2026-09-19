# Birds UX: specification, implementation, independent review

September 18, 2026 · Parent td-8ff597

## Working agreement

The primary agent owns product decisions, phase specifications, independent
review and acceptance. A lower-cost implementer writes the code and focused
tests from each completed specification. The reviewer checks the actual diff,
executes the relevant checks and exercises the running app with realistic data.
An implementer saying “done” is a handoff for review, not phase completion.

Only one implementation phase runs at a time. Findings go back to the same
implementer for correction. If review exposes a missing product decision, the
primary agent amends the specification explicitly; the implementer does not
invent behavior or quietly expand scope. Each phase ends with a concise account
of delivered behavior, review fixes, test/browser evidence and remaining work.
Commit and production deployment remain separate owner instructions.

Write the next detailed specification after the current phase's review, so it
reflects what was learned. The full roadmap remains the plan index; a phase
spec is an executable work order beneath it, not a competing backlog.

**Current checkpoint:** Phase 1 is released as `582f665`; see its [review record](phase-01-review.md). Phase 2A (td-2c866c) is released as `0ddf28a` on September 19, 2026; see its [specification](phase-02a-trip-count-context.md) and [review record](phase-02a-review.md). Production migration, health, planner, saved-trip and export checks passed. Phase 2B (td-f730cf) is implemented and in review from its [detailed specification](phase-02b-comparable-rankings.md); [acceptance evidence](phase-02b-review.md) records 91 passing focused tests and real 246-hotspot comparisons. It awaits owner commit/deploy instruction. Next is phase 3. The split keeps count meaning and persistence reviewable independently of upstream request orchestration.

## Phase queue

| Phase | Boundary | Principal evidence |
| --- | --- | --- |
| 1 | Verified automatic hotspots; explicitly selected other reports; accurate saved-trip identity | F12; td-d22017; [detailed specification](phase-01-trip-location-identity.md) |
| 2A | All/Need labels and authenticated saved count context; separate current nearby counts | F13; td-2c866c; [specification](phase-02a-trip-count-context.md) |
| 2B | Comparable ranking evidence, progress/completeness and Home Best places | F13; td-f730cf; [detailed specification](phase-02b-comparable-rankings.md) |
| 3 | Recent-report source/window/review status, deduplication, personal sightings and Nearest consistency | F14; td-3d9544 / td-d71bad |
| 4 | Missing hotspot metadata recovery and clear paused/scheduled/running load states | F15 |
| 5 | Shared navigation context and place-preserving links, split into core and route-adoption phases if needed | F01–F02; release-1 units A/B |
| 6 | Keyboard drawer, map reveal/focus and touched control sizing | F03/F08/F09 |
| 7 | Compact Field Guide controls and species section navigation | F04/F05; preserve full dataset and search behavior |
| Later | Unified geographic selection, list scope and field-use trips, in independently specified slices | Existing roadmap packages B/C and remaining tickets |

These are implementation boundaries, not promises that all work fits one
commit. Phase 2 in particular must resolve the request/coverage contract before
being handed to an economical implementer; uncertainty belongs in specification
work, not in a vague coding assignment.

## Every specification must contain

- Concrete before/after behavior and explicit scope exclusions.
- Confirmed source paths, data flow and contracts; migration decisions where needed.
- Product decisions for empty, partial, stale and failure states.
- Data preservation, authorization and existing-functionality requirements.
- Acceptance examples, focused tests and realistic browser/database checks.
- Handoff ownership and a definition of what evidence permits acceptance.

## Review gates

1. Check the diff against the complete specification and unrelated dirty work.
2. Trace data and trust boundaries; inspect failure and stale-data behavior.
3. Run focused tests, framework/type checks and production build after code changes.
4. Exercise desktop and phone layouts against the working isolated test setup;
   include real caches/worker jobs when the changed workflow depends on them.
5. Return defects to the implementer and repeat affected checks after correction.
6. Record the result in the phase ticket and the parent plan. Never close the
   broader UX ticket merely because one phase passed.
