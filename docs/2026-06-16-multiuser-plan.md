# Multi-user (strict per-user isolation, with hooks for family-sharing)

_Plan — 2026-06-16. Priority P1. Tracking: td-425243._

## Context

The app is single-owner today: every data read/write resolves through `locals.ownerId`
(a cached single admin id from `getOwnerId()`). Goal: real per-user accounts for a small
known family set (gaylon=admin, wife=the existing `family` viewer, Marcus=son, his own
account) — each seeing only their own trips / life list / needs / eBird key / home. No
public signup (admin-provisioned). The gallery (gaylon.photos) is decoupled since other
users have no equivalent photo source.

**The data layer is already multi-user-ready:** every server function (`trips.ts`,
`needs.ts`, `ebird-account.ts`, `ebird.getEbirdApiKey`, `query-engine.runQuery`) already
takes an explicit `userId` and scopes its SQL by it. The single-owner assumption lives only
in `locals.ownerId`, used in 7 route files.

## Decisions locked in
- **Strict per-user isolation now**, architected so family-visibility (#2) is a localized
  later change, not a rewrite.
- **The `family` viewer keeps reading gaylon's data** transitionally (no regression for the
  wife); Marcus is a fully isolated account. #2 later replaces this with real sharing.
- **Gallery is per-owner + optional**: only a user whose scope owner has a configured photo
  source sees photos; others get a graceful empty state.

## Core design — the read/write seam (one nullable column)

Add `users.views_user_id` (nullable FK → users.id). Data-scope owner:
`scopeOwnerId(user) = user.views_user_id ?? user.id`.
- Normal users (gaylon, Marcus): NULL → scope = self (isolation).
- `family` viewer: `views_user_id = gaylon.id` → scope = gaylon (transitional).

In `src/hooks.server.ts`, set `locals.scopeId = scopeOwnerId(user)` alongside `locals.user`.
- **Reads** (trips, targets, needs, species, eBird key, home, gallery) use `locals.scopeId`.
- **Writes** (create/update/delete trip, save, settings) use `locals.user.id`. Viewers are
  already blocked from writes + `/settings`; for normal users `scopeId === user.id`.
- **Retire `locals.ownerId` / `getOwnerId()`** for request scoping.

**#2 hook:** `src/lib/server/access.ts` exports `scopeOwnerId(user)` (used now) + stub
`readableUserIds(user)` → `[scopeOwnerId(user)]`. Family-sharing later = a `shares` table +
`readableUserIds` returning a set + list-reads UNIONing it. Routes funnel scope through one
value, so the change stays contained.

## Changes by area

1. **Migration `backend/db/migrations/0006_multiuser.sql`** — add `users.views_user_id` +
   `users.gallery_url`; backfill `family.views_user_id = gaylon.id`,
   `gaylon.gallery_url = <gaylon.photos collection URL>`. `photo_links` stays global (gated
   by ownership).
2. **Auth/hooks** — `auth.ts`/`session.ts` include `views_user_id` in `SessionUser`;
   `hooks.server.ts` sets `locals.scopeId`, drops `locals.ownerId`; update `src/app.d.ts`.
3. **Routes (7)** — reads `locals.ownerId` → `locals.scopeId`; trip write actions use
   `locals.user.id`. Server data modules unchanged (already take `userId`).
4. **Gallery decoupling** — `needs.ts` takes a `photoCounts: Map` param (empty unless scope
   owner has a gallery); `gallery.ts` reads the owner's `gallery_url`; gate UI on
   `hasGallery` (`/photos`, species strip, home count + nav, settings panel).
5. **Account provisioning** — admin-only "Users" panel in `/settings` (create user, set
   role + optional `views_user_id`/`gallery_url`, set password via `hashPassword`).
   `scripts/set-password.ts` stays a CLI fallback.

## Security / IDOR checklist
- Trip mutations already guard via `assertOwnsTrip(user.id, tripId)`; `getStops(tripId)` has
  no user check but is always preceded by `getTrip(scopeId, tripId)` (404 if not owned) —
  keep that invariant in the `[id]` load + `export`.
- Trip writes scope by `locals.user.id` (defense in depth).
- No route may return another user's `seen_species`/`user_ebird`/trips/home via a stale
  `ownerId`. Global tables (`taxonomy_cache`, `ebird_cache` = public eBird; `photo_links` =
  gallery-gated) are not user-private.

## Verification (local test stack, 15436 / 5178)
1. Migrate; create **Marcus** (admin) + password; confirm `family.views_user_id=gaylon`,
   `gaylon.gallery_url` set, Marcus NULL.
2. As **Marcus**: empty data; add own eBird key; save a trip; gaylon can't see it.
3. As **gaylon**: only his trips + gallery; can't see Marcus's.
4. As **family**: read-only, sees gaylon's data + gallery; blocked from writes + `/settings`.
5. IDOR: as Marcus, GET gaylon's `/trips/<id>` + `/export` → 404.
6. Gallery: Marcus sees no `/photos`/badges, no errors; gaylon/family do.
7. `npm run check` (0), `npm run build`, `npm test`; browser-verify each role.
