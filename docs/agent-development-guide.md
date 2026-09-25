# Birds repository development guide

This is the canonical, tool-agnostic workflow for coding, testing, reviewing,
and releasing changes in this repository. It applies to human contributors and
AI coding agents, including Codex, Gemini, Grok, and Claude Code.

The short instruction to give an agent is:

> Follow `docs/agent-development-guide.md` for this change. Read the required
> repository context first, protect the existing test data, implement only the
> requested scope, and return the verification evidence without committing or
> deploying unless I explicitly ask.

This guide organizes the workflow. [`../cs.md`](../cs.md) remains the authority
for project-specific safety, infrastructure, data, and UI rules.

## 1. Required startup

Before diagnosing or editing:

1. Read `cs.md` completely.
2. Read this guide completely.
3. Run `td usage --new-session` at the beginning of a new agent conversation;
   use `td usage -q` after that. Read the named ticket with `td show <id>` and
   inspect its dependencies when they may affect the work.
4. Read the latest relevant entry in `docs/devlog/`. For UX work, also read the
   applicable specification and acceptance record under `docs/ux/`.
5. Read the relevant source and tests before proposing a cause or solution.
6. Inspect the repository state:

   ```sh
   git status --short --branch
   git diff --stat
   git diff --check
   ```

   Existing changes belong to the user or another agent. Preserve them, do not
   reformat them incidentally, and do not include them in a commit.

7. State the intended scope and the evidence needed to call it complete. If the
   request leaves a product decision genuinely unresolved, ask one focused
   question instead of inventing behavior.

Repository context is applied in this order: the user's current request and
explicit decisions; `cs.md` hard rules; the accepted ticket/specification;
this workflow; then current source and tests as implementation evidence. If a
document is stale, report the conflict and use live code/data to establish the
current state. Do not silently reinterpret the requested product behavior.

## 2. Scope and change discipline

- Make the smallest coherent change that satisfies the accepted behavior. Do
  not bundle opportunistic cleanup, dependency updates, redesigns, or unrelated
  ticket work.
- Diagnose from evidence: trace browser/client -> route -> server module -> SQL
  or provider -> stored state -> rendered response. Verify each relevant
  boundary before changing code.
- Prefer shared helpers and components when the same contract is already used
  in more than one place. Do not create a broad abstraction for one call site.
- Preserve existing query parameters, authorization, empty/partial/stale/error
  states, pagination, and no-JavaScript behavior unless the task explicitly
  changes them.
- Never fix a presentation problem by silently reducing data, adding a hidden
  row cap, changing a default, or substituting fallback data. Unknown coverage
  is not zero; missing data is not evidence of absence.
- Do not add external requests merely to render a page. Respect cache-first and
  fail-soft behavior, provider rate limits, worker deduplication, retry windows,
  pause/cancel controls, and last-good data.
- Use targeted editing. Avoid repository-wide formatters in a dirty worktree.
  Format or check only touched files when possible.
- Do not commit, push, deploy, mutate production data, run a backfill, or send
  messages to outside services unless the user explicitly authorizes that
  action. An implementation request does not imply release authorization.

## 3. Protecting data

### Production

Production is never a test fixture.

- Default production access is read-only diagnosis and post-release smoke
  verification.
- Do not run `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, DDL, a worker/backfill,
  cache flush, sync, import, or admin mutation without explicit authorization
  for that production effect.
- A requested deployment authorizes the migration files in the intended
  release through the deploy script. It does not authorize unrelated manual
  SQL or an optional backfill.
- Source `.local/ops.env` only when operations are authorized. Never print,
  commit, copy, or document its values or any credentials.
- For diagnostic SQL, use a read-only transaction where practical and report
  counts as dated snapshots, not permanent product facts.

### The local `birds_test` database

`birds_test` is isolated from production, but it is not disposable. It contains
a production-sized, useful snapshot that supports realistic UI and query tests.
Protect existing owner, viewer, taxonomy, enrichment, frequency, region, and
location rows.

Before any DB-writing test or manual test setup:

```sh
npm run test:env
npm run test:db:up
```

The safety gate must resolve to `BIRDS_ENV=test`, `127.0.0.1:15436`, and
`birds_test`. Never bypass `scripts/lib/test-env.sh`, point tests at ports
5433/5434/5435/5436, or use the production database name `birds`.
`npm run test:db:reset` destroys the useful snapshot; do not run it unless the
user explicitly authorizes replacing the local test database.

Every test that writes to `birds_test` must follow all of these rules:

1. **Own every mutable row.** Create a uniquely named fixture account or use a
   reserved fixture identifier owned by that test. Prefer a UUID suffix.
2. **Never borrow an existing row.** Do not select `MIN(id)`, “the first admin,”
   the real owner, or an existing viewer and then write related data.
3. **Use narrow cleanup.** Delete by the exact IDs/codes created by the test.
   Never use an unqualified `DELETE`, `TRUNCATE`, or broad role/name predicate.
4. **Make ownership cascade-friendly.** When safe, attach dependent fixtures to
   a disposable user and delete that exact user during cleanup. Still verify
   which tables cascade before relying on it.
5. **Clean up on failure.** Use `afterAll`/`afterEach` and `try/finally` for
   mutations that can fail mid-test. Cleanup must be idempotent.
6. **Do not overwrite corpus rows.** Prefer new reserved codes in namespaces
   that cannot collide with real taxonomy/region/location identifiers. If a
   test must temporarily alter a pre-existing row, snapshot the exact row,
   restore it in `finally`, and explain why an owned fixture cannot prove the
   behavior.
7. **Bound corpus-dependent work.** Select stable, explicit fixtures before
   pagination; do not walk every page or assume a fixture sorts into a global
   `LIMIT`. A production-sized corpus is evidence, not permission for a slow or
   order-dependent test.
8. **No live provider traffic by default.** Mock eBird, Google, NWS, NOAA,
   Wikidata, iNaturalist, AI, and gallery calls or use sanitized captured
   fixtures. Never put production secrets into `.env.test` merely to make a
   test pass.
9. **Keep the local worker out of fixture races.** Stop it unless the worker is
   the subject of the test. Worker tests must use owned job labels/dedup keys and
   verify final queue cleanup.
10. **Prove hygiene.** For changes touching user state or shared corpus tables,
    capture relevant before/after counts and verify that existing account data
    is unchanged and no fixture rows remain.

Vitest files are intentionally serialized (`fileParallelism: false`) because
DB integration files share one database. Do not re-enable file parallelism
until suites own isolated schemas or databases.

Restored production eBird credentials are encrypted with a different secret.
Do not use the production encryption secret as a convenience. Follow `cs.md`'s
re-key guidance or use cached data, and state when that makes a test unsuitable
for live-provider or latency claims.

### Migrations

- Put schema changes in `backend/db/migrations/`; never perform runtime DDL.
- Use the repository migration scripts, not `psql -f`.
- Make migrations safe for the established deploy path and verify grants for
  `birds_owner` and `birds_app` where applicable.
- Test the migration against `birds_test`, including the application behavior
  that consumes it. Do not edit an already-deployed migration.
- Treat data backfills separately from schema installation when they are
  expensive, externally metered, or operationally risky. Require explicit
  authorization and visible progress/retry semantics.

## 4. Server, SQL, auth, and provider conventions

- Validate untrusted input at route/API boundaries. Return explicit 4xx errors
  for malformed, repeated, unknown, unauthorized, or missing required values.
- Use parameterized SQL and the actual schema constraints. Use
  `withTransaction` for multi-statement mutations that must succeed together.
- PostgreSQL `NUMERIC` values arrive as strings unless cast; coerce at the SQL
  or TypeScript boundary. PostgreSQL `JSONB` normally arrives as an object; do
  not blindly `JSON.parse` it. Store timestamps as `TIMESTAMPTZ` in UTC.
- Apply filters and account scope in SQL before counts, ordering, and
  pagination. Do not fetch broad data and hide it in the UI.
- Keep owner/viewer semantics explicit:
  - `locals.user.id` is the signed-in account and owns personal Viewed and
    Special-interest state.
  - `locals.scopeId` is the account whose shared life-list Seen/Need state the
    viewer is allowed to see.
  - Admins choose a viewer's owner. A viewer must not be able to reassign that
    relationship.
  - Test owner, ordinary user, assigned viewer, reassignment, and unauthorized
    cases when a change touches account scope.
- Preserve current data on upstream failure. Validate live and cached provider
  payloads at the boundary, omit sensitive payloads from diagnostics, treat a
  malformed fresh cache as a miss, and use only previously validated stale
  data as fallback.
- Keep eBird attribution wherever eBird data appears. Store and join by stable
  species code, not display name.
- Gallery media remains link-out metadata. Do not add uploads, binary proxying,
  image processing, or local media storage.
- Never log tokens, API keys, passwords, encrypted credentials, session
  cookies, full sensitive payloads, or `.env` values.

## 5. Unified UI/UX approach

Before changing visible behavior, inspect the current page, the shared
components it uses, `src/app.css`, `src/routes/+layout.svelte`, and the relevant
approved mockup/specification. Extend the existing visual language; do not
introduce a page-specific design system.

### Visual and interaction rules

- Use Svelte 5/SvelteKit patterns already in the repository. Do not casually
  mix in legacy reactivity or client-only state when server-rendered state is
  required.
- Component-scoped CSS and existing theme tokens only. No Tailwind or utility
  framework. Reuse the breakpoints at 640px and 1024px.
- Mobile-first, with deliberate checks at 320px, 390x844, and a representative
  desktop width around 1200px. Do not accept horizontal page overflow.
- Interactive controls have at least a 48px target. Inputs/selects remain at
  least 16px to avoid iOS zoom. Honor safe-area insets and the fixed mobile
  bottom navigation.
- Meet the repository's WCAG AAA text-contrast requirement. Status must always
  have a text label as well as color.
- Use existing inline feedback and accessible dialogs. Do not add toast
  notifications. Destructive actions require a clear confirmation.
- Prefer native links, forms, buttons, details, and headings. Preserve
  modifier-click, new-tab, refresh, browser Back/Forward, focus order, visible
  focus, Escape behavior, and meaningful accessible names.
- Use the shared navigation-context and return-link patterns. Name the actual
  return destination, preserve canonical content state, reject unsafe return
  URLs, and never fabricate ancestry.
- Empty, loading, partial, stale, unavailable, covered-zero, and error states
  must be visibly distinct and truthful. A spinner or HTTP 200 is not adequate
  acceptance evidence.
- Preserve full result sets and exact counts. Pagination or progressive
  disclosure is acceptable; silent truncation is not.
- Reuse existing components such as Field Guide rows, tabs, map picker, badges,
  and path navigation when their contract fits. If two surfaces should behave
  the same, centralize the behavior and test both callers.

### Documentation

For user-visible workflow, control, meaning, availability, or limitation
changes, review and update `src/routes/help/+page.svelte`. For a meaningful
user-visible release, add a plain-language Version History item in
`src/routes/about/+page.svelte`. Internal refactors need neither, but make that
decision explicitly.

## 6. Standard testing method

Choose evidence by risk. Different test layers prove different things; do not
claim that one substitutes for another.

| Layer                         | What it proves                                                                                       | Standard use                                                       |
| ----------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Pure unit/policy test         | Deterministic transformation, validation, sorting, state machine                                     | Every extracted rule or regression that can run without DB/network |
| Mocked server/route test      | Request parsing, auth branching, error mapping, calls made                                           | Route/API changes; not proof of SQL or real rendering              |
| Real `birds_test` integration | SQL shape, migrations, constraints, account isolation, transactions, pagination                      | Every meaningful DB/query/schema change                            |
| Browser journey               | Rendered behavior, navigation, focus, responsive layout, JS/no-JS behavior, console/network failures | Every meaningful user-visible change                               |
| Read-only production smoke    | Exact deployed revision, live auth/config/data integration and health                                | After an explicitly authorized deployment                          |

### A. Establish the baseline

- Identify the nearest existing tests and run them before editing when a
  baseline is reasonably quick.
- Reproduce the reported failure using the real layer where it occurs. Save the
  exact URL, account role, data state, viewport, response/error, and expected
  behavior.
- For DB-writing or browser work, record the durable test-data invariants that
  must remain unchanged. Examples include an owner's Seen count and the number
  of fixture-prefixed users/regions/jobs.

### B. Add focused regression coverage

- Test the user-visible contract or invariant, not implementation wording.
- Include success, empty/zero, partial/stale, malformed, unauthorized, and
  upstream-failure cases that are relevant to the change.
- For bug fixes, make the test fail for the demonstrated pre-fix mechanism.
- Prefer bounded fixtures over global corpus ordering. Use real DB tests for SQL
  claims and mocks only for provider/route seams.
- Run exact files during iteration:

  ```sh
  npx vitest run path/to/changed.test.ts path/to/related.test.ts --reporter=verbose
  ```

### C. Run proportional integration checks

For DB changes:

```sh
npm run test:env
npm run test:db:up
npx vitest run path/to/db-integration.test.ts --reporter=verbose
```

Confirm that DB suites actually ran. A suite that skipped because the test
cluster was unavailable is not passing integration evidence.

For user-visible changes, run the application in test mode:

```sh
npm run dev:test
```

Use available browser automation or a real browser. Test the affected journey
with the relevant account roles and realistic stored data. At minimum verify:

- initial render and the actual answer/content, not just status 200;
- keyboard operation, focus placement/restoration, and accessible names;
- 390px phone and desktop layout; add 320px for dense or changed layouts;
- no horizontal overflow, unexpected console exceptions, or failed requests;
- refresh and Back/Forward; direct/shared URLs when URL state changed;
- both Chromium and WebKit for navigation, forms, selects, sticky/fixed UI, or
  responsive behavior when both engines are available;
- for taps, focus/blur, the on-screen keyboard, pointer events, comboboxes, or
  sticky UI, a Mobile Safari pass on the iOS Simulator (procedure below);
- JavaScript disabled when the route promises server-rendered forms/links or
  progressive enhancement;
- before/after test-data invariants and fixture cleanup.

A desktop Chromium or desktop WebKit run does not cover iOS Safari touch
behavior. `pointerdown` `preventDefault()` cancels the following tap in iOS
Safari (Field Guide Place option, td-daff98; fixed in `d71470f`). For the
touch-sensitive cases above, boot the simulator and open the test app there.
No Xcode app project is required. The simulator shares the Mac's network, so
the local test server is reachable at `127.0.0.1:5178`:

```sh
xcrun simctl boot "iPhone 16 Pro"
open -a Simulator
xcrun simctl openurl booted http://127.0.0.1:5178/species
```

Drive taps and typing with XcodeBuildMCP UI automation when it is available,
otherwise with Appium's XCUITest driver. Save evidence with
`xcrun simctl io booted screenshot <file>`. Report that run as an iOS Simulator
result. A check on Gaylon's physical iPhone remains the final gate.

Do not claim Safari, physical iPhone, PWA, or installed-app verification from a
desktop WebKit run or from the simulator. List physical-device checks as
outstanding until performed.

### D. Run repository gates

After code changes, the normal completion gate is:

```sh
npm run check
npm run build
git diff --check
```

Also run `npm test` for cross-cutting server, schema, auth, queue, shared UI, or
test-infrastructure changes. For a narrow isolated change, focused tests plus
check/build may be sufficient, but report that the full suite was not run.

Use `npx prettier --check <touched files>` when formatting is in doubt. Do not
run `npm run format` over unrelated dirty work. Treat new warnings, unhandled
rejections, unexpected skips, timeouts, browser console errors, or test-data
drift as failures. Do not merely raise a timeout until the query/test design has
been examined.

### E. Review the final diff

Before handing back:

```sh
git status --short --branch
git diff --stat
git diff --check
git diff -- <intended paths>
```

Confirm that the diff contains only the intended work; no secret, generated
artifact, debug logging, fixture residue, hidden cap, or unrelated formatting;
Help/About changes are included when required; and every acceptance criterion
has evidence or is clearly marked outstanding.

## 7. Completion and review

An implementation agent saying “done” means ready for review, not accepted.
The final handoff must state:

- behavior implemented and paths changed;
- tests run, with pass/fail/skip counts when available;
- whether real DB, browser engines/viewports, account roles, and JS/no-JS were
  exercised;
- test-data before/after invariants and cleanup result;
- `npm run check`, `npm run build`, and `git diff --check` results;
- anything not tested and why;
- current git status and whether any unrelated work was preserved;
- explicitly: not committed, not deployed, and no production data changed,
  unless those actions were separately authorized and verified.

Use `td log <id> --result "..."` for concise evidence. Submit completed work
through the repository's `td review` -> independent `td approve` flow; the
implementing session must not self-approve.

For risky, account-scoped, data-mutating, migration, worker, or broad UI work,
seek an independent source/diff review when a reviewer is available. A reviewer
must inspect the actual diff and evidence, not merely accept the implementer's
summary.

## 8. Commit and release procedure

Only begin this section after an explicit instruction to commit or deploy.

1. Reconfirm the exact release scope and preserve unrelated work.
2. Add a concise entry to today's `docs/devlog/YYYY-MM-DD.md` when requested or
   when it is part of the established release work.
3. Re-run task-appropriate focused tests, `npm run check`, `npm run build`, and
   `git diff --check` against the final commit contents.
4. Commit only intended files. Push only when authorized.
5. Deploy only with:

   ```sh
   ./scripts/deploy-to-DO.sh
   ```

   Never perform a manual production deployment. Use `--skip-push` only when
   the intended revision is already on `origin/main` and that mode is needed.

6. Verify the exact deployed revision, migration result, PM2 `birds` and
   `birds-worker` status, and `/api/health`. Health must include the required
   healthy DB/worker state; report gallery status separately rather than hiding
   degradation.
7. Perform authenticated, read-only production smoke checks on every changed
   surface and relevant account role. Verify rendered meaning, not merely 200.
8. Report the commit SHA, deployed SHA, health response, smoke evidence, and
   final local/origin state. Never call work shipped before these checks pass.
