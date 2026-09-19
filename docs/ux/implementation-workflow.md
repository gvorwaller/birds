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

**Current checkpoint:** Phases 1, 2A and 2B are released as `582f665`,
`0ddf28a` and `e730c56`. Phase 3 is released as `334ffff`, with production
streaming repair `505382b`; [production acceptance](phase-03-review.md) records
healthy services and authenticated Home, species and Nearest checks.

Phase 4 **td-c9e804** is released as `05ba3af`; its
[review record](phase-04-review.md) includes real worker and production evidence.
Phase **5A td-ea384e** is released as `c731094`; its
[acceptance record](phase-05a-review.md) covers real browser journeys and production verification. It implements the
[detailed specification](phase-05a-navigation-context.md): shared journey core,
trip/hotspot/bird returns and safe place links. Phase **5B td-750277** is
released as `9abbe8a`; its [review record](phase-05b-review.md) includes
authenticated production journey proof. Phase **6 td-f3ccda** is independently
accepted in its [review record](phase-06-review.md), and the owner has authorized
its production release. Its
[keyboard shell and map reveal specification](phase-06-shell-map-controls.md)
remains the contract.

## Phase queue

| Phase | Boundary | Principal evidence |
| --- | --- | --- |
| 1 | Verified automatic hotspots; explicitly selected other reports; accurate saved-trip identity | F12; td-d22017; [detailed specification](phase-01-trip-location-identity.md) |
| 2A | All/Need labels and authenticated saved count context; separate current nearby counts | F13; td-2c866c; [specification](phase-02a-trip-count-context.md) |
| 2B | Comparable ranking evidence, progress/completeness and Home Best places | F13; td-f730cf; [detailed specification](phase-02b-comparable-rankings.md) |
| 3 | Recent-report source/window/review status, deduplication, personal sightings and Nearest consistency | F14; td-766bfd, td-3d9544 / td-d71bad; [specification](phase-03-report-evidence.md) |
| 4 | Missing hotspot metadata recovery and clear paused/scheduled/running load states | F15; td-c9e804; [detailed specification](phase-04-load-recovery.md) |
| 5A | Shared journey core, trip/hotspot/bird returns and safe place links | F01–F02; td-ea384e; [specification](phase-05a-navigation-context.md) |
| 5B | Adopt journey context across remaining list/search/county entry points | F01; td-750277; [specification](phase-05b-navigation-adoption.md); [review](phase-05b-review.md) |
| 6 | Keyboard drawer, map reveal/focus and touched control sizing | F03/F08/F09; [specification](phase-06-shell-map-controls.md); [review](phase-06-review.md) |
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
