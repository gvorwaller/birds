# Special interest species — implementation plan

Date: 2026-09-12. Task: td-e73377, incorporating duplicate td-ce9a96.
Owner authorized planning and implementation. Commit and deployment are separate.

## User outcome

Save a bird while browsing, then find it again when preparing an outing. Both
Seen and Need species can be saved. A personal marker expresses interest; it
does not record a sighting, imply occurrence, or change a trip.

## First release

1. Add a star plus text toggle to species detail. Show saved state, pending
   feedback and explicit retry on failure. Change the state only after the
   server confirms it. Keep viewing history independent.
2. Add a Special interest collection as a Field Guide tab, with name/code search,
   alphabetical/recent ordering, saved dates, and removal. Preserve all saved
   entries without a hidden cap. Retired taxonomy codes remain removable and
   visibly unavailable; never guess replacement species or names.
3. Add a Special interest only checkbox to Browse species and saved badges on
   its results. Intersect in SQL before counting/pagination. Preserve the filter
   through search, tags, family, geography, paging and detail/back navigation.
   Existing location coverage disclosures continue to apply.
4. Scope reads and writes to the actual authenticated account, including viewers.
   Add only an exact personal API write exception to the viewer hook. Validate
   origin, body, current species and the page's account identity. Set an explicit
   boolean instead of toggling database state, so repeated add/remove is safe.
5. Store a unique user/species row with a TIMESTAMPTZ saved date and account-delete
   cascade. No taxonomy FK because taxonomy refresh replaces the table. Repeated
   saves retain the original date. Allow removing retired entries.
6. Update Help and Version History; document results in the devlog.

## Deferred scope

Personal notes, multiple lists, priorities, trip membership, destination/month
ranking and notifications. The existing geographic Field Guide filter can narrow
saved species using loaded historical reports, with its existing coverage limits.

## Verification

- Real isolated PostgreSQL: owner/viewer separation, Seen/Need and viewing-history
  independence, duplicate/concurrent saves, removal, account deletion, taxonomy
  retirement, complete collection, and guide intersection before pagination.
- API and hook: unauthenticated, cross-origin, malformed and stale-account
  requests rejected; personal permission does not open owner writes.
- Authenticated WebKit at phone/desktop widths: save/remove, reload and another
  session, collection/search/filter/back navigation, failure/retry, keyboard and
  48px controls, no overflow or browser exceptions. This is desktop WebKit, not
  physical iPhone verification.
- Focused regression tests, npm run check, npm run build, git diff --check.
- Apply migration only to dedicated birds_test via the migration runner. Preserve
  existing unrelated family-quality work. No production data operation.
