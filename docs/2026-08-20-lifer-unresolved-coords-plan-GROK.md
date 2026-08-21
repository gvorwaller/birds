# Life-list map: 17 locations with no pin (td-2fbfc1)

GROK 2026-08-20. Prod screenshot: `/life` discloses "17 locations have no
map pin — eBird returned no coordinates (more resolve on each sync)." Gaylon
expected eBird to geocode every location he has submitted a checklist for —
and for a life list, that *is* most of the unique spots, because one hotspot
cluster (e.g. FL ×11) hides a long tail of personal yards / street addresses.

Status: diagnosis + remedy plan, **BINDING**, **updated from live
prod + eBird probes 2026-08-20 (GROK)**. CODEX1 REJECT → APPROVE
folded. CC1 adversarial **ACCEPT WITH PINS** folded (A–E + CASCADE).
Gates (0) and (1) are **done**. **Gaylon 2026-08-20 accepted B**
(owner GET `/checklist/{subId}` + tight lat/lng extract; same
unofficial class as the CSV sync). Privacy: current users are family
and friends so communal pins would not bother him, **but user-scoped
`lifer_loc_coords` stays** — the safe move if the user set grows.
Implementation still waits for an explicit build word (no code this
turn).

## CODEX1 adversarial review (binding) — 2026-08-20

Independently verified against `CookieJar` / `fetchAuthenticatedEbird`
(`AUTH_FETCH_ALLOWED_HOSTS = ebird.org|www.ebird.org`),
`resolveLiferLocations` `DISTINCT ON (loc_id)`, `/life` join-only loader
(does not read `lifer_loc_attempts`), Settings `sync_lifelist` (enqueue
only; `/api/jobs` omits `result`; no completion flash), and
`hotspotPlace` reading `ebird_locations` by bare `loc_id`. Verdict:
**REJECT of the first draft**. Review 1/2 blockers plus review 2/2
remaining pins 6–11 are folded below. Question dispositions (1–8)
recorded at the end.

### Review 2/2 remaining pins (6–11) — adopted

6. **Cap accounting.** First-draft "≤25 CAS; hotspot successes do not
   count" is gone. Two budgets (total HTTP ≤40, CAS ≤25), sequential,
   remaining decremented **before** each request and never negative,
   absolute `deadlineAt`, no negatives on exhausted budget. Tests cover
   26 CAS-needed **and** many hotspot-success candidates. See §5.
   Intra-pass `updateProgress` + `bumpWorkerHeartbeat` so a long
   resolve cannot false-dead the 60s worker chip or ignore cancel
   (`WORKER_ALIVE_WINDOW_MS`; `runSyncJob` currently heartbeats only
   at start/end).
7. **Loader counts.** `/life` cannot derive the three-state UI from
   join-nulls. Server returns pending/unattempted, verified-negative
   by reason, stopped/capped, and no-loc as **separate counts**. No
   "sync again" on persistent auth/schema stop. See §6.
8. **CSV-only.** Manual import never calls the resolver. No-login copy
   is "need an eBird sign-in sync", never "still resolving." Tested.
9. **Settings flash.** Promise removed. Durable surface is `/life`
   disclosure + existing admin `jobs.result` history.
   `jobsPoll.track` already narrates the running job. `/api/jobs`
   stays result-less (communal).
10. **Wipe / classification.** Transactional invalidation of
    reason-less rows; candidate selection distrusts NULL /
    `legacy_untrusted`. CHECK / NOT NULL **deferred** until after
    that distrust is in the candidate SQL (not the same statement as
    the wipe). Parse/schema mismatch is never `no_coords`. Migration
    contains no user-specific IDs. See §7.
11. **ToS / supportability.** JSON-only, no HTML, sequential bounded
    fetches, attribution, no raw payload retention, Gaylon's
    acceptance of the verified unsupported `ebird.org` endpoint
    before merge. Official materials document API-key API +
    "Download My Data", not session-cookie access to `api.ebird.org`.

## CC1 adversarial review (binding) — 2026-08-20

Independently verified: candidate SQL excludes only `ebird_locations` +
`lifer_loc_attempts` (`lifer-locations.ts` 103–111); `lookupOne` treats
`loc.locId !== csv locId` as a miss (`73–82`); `Cookie: jar.header()`
on every CAS hop (`fetchWithJar` 69; `casLogin` 99–186);
`hotspotPlace` `SELECT … FROM ebird_locations WHERE loc_id = $1`
(line 127). Verdict: **ACCEPT WITH PINS**. Architecture stands.
Pins A–E are binding; CASCADE is in-scope schema.

**A. Candidate query excludes `lifer_loc_coords`.** After an owner-JSON
hit the loc is in `lifer_loc_coords`, not in `ebird_locations` or
`lifer_loc_attempts`. Without `AND NOT EXISTS (… lifer_loc_coords …
user_id + source_loc_id)` every later sync re-pays the CAS budget for
already-plotted personal pins and starves the unresolved tail. See §4.

**B. CAS redirect-chain regression test.** Domain-aware jar changes
every hop of login (form GET → POST → 302 ticket → ebird.org session).
A filter bug breaks **all** life-list syncs, not just the 17 pins.
See Tests.

**C. API-key checklist locId mismatch is fall-through, not a
negative.** §1's "403/404 is not a negative" does not cover a **200
with a different `loc.locId`** (today that returns null → negative).
Mismatch → owner-JSON path. If owner JSON also mismatches, §3 stores
both IDs. The implementer must not leave the strict match as terminal.

**D. `loc_resolution_*` columns (exact).** Not two free-text fields
the implementer has to parse into three flags. Pin:

```
user_ebird.loc_resolution_status  text  -- 'ok' | 'capped' | 'stopped' | 'error'
user_ebird.loc_resolution_error   text  -- nullable; set when status='error'
```

Cap exhaustion **is** `capped` (a kind of stop); 429/timeout/5xx →
`stopped`; persistent owner-JSON auth/schema → `error`; clean finish →
`ok`. These do not combine. Loader copy keys off `status` (see §6).
No jsonb blob.

**E. Drop `checklist_api` provenance.** API-key checklist **match**
still writes public `ebird_locations` (today). API-key **mismatch**
falls through (pin C) and does not write. All `lifer_loc_coords` rows
come from the owner-JSON path; `provenance` is `'checklist_owner'`
only in v1. No ambiguous trigger.

**CASCADE.** `lifer_loc_coords.user_id REFERENCES users(id) ON DELETE
CASCADE` (same as `lifer_loc_attempts`). PK `(user_id, source_loc_id)`
is the join/NOT EXISTS index; no extra index.

## Why the copy is lying (diagnosis, now scoped)

eBird **does** store a lat/lng on every checklist. Cornell: "Every eBird
checklist includes a set of latitude and longitude coordinates selected by
the observer."

eBird **does not** put those coordinates in the life-list CSV. Verified
header (td-b5986c): LocID + SubID, no lat/lng. `/life` is join-only
against `ebird_locations`. Coordinates appear only if a later step wrote
the loc_id there.

The on-page sentence "eBird returned no coordinates" is therefore wrong
for personal/unshared locations. eBird has the pin. The **public API
key** cannot read unshared checklists (documented 403).

**The 17-are-poisoned-negatives claim is a strong hypothesis, not a
proof.** `/life` computes one undifferentiated set
(`loc_id IS NOT NULL AND joined lat/lng IS NULL`) and never reads
`lifer_loc_attempts`. Seventeen can be:

- (a) rows in `lifer_loc_attempts` (poisoned 403s),
- (b) never-attempted tail after an earlier pass whose candidate count
  exceeded the cap of 25,
- (c) leftover after a 429/timeout stopped the pass (`stopped: true`,
  no negatives written).

17 < 25 only rules out (b) **for a pass that started with ≤25
candidates**. It does not prove (a). Prod was not queried this turn.

The screenshot still names the *class* of miss: **"97 Ellsworth Rd, Blue
Hill ME"** is a personal location. Hotspot/info 404s it. If that
checklist is unshared, API-key checklist/view 403s it. That path is
real even if this particular 17 is a mix of (a)(b)(c).

### Step 0 — forensic query (read-only, before any code)

Run against prod (owner user_id). Pin the result in this doc / the td
before implementing:

```
unresolved distinct loc_ids
  = seen_species.loc_id NOT NULL LEFT JOIN ebird_locations miss
with attempt row
without attempt row
current lifer_loc_attempts count
last sync_lifelist job result (resolved/negative/capped/stopped)
```

### Live findings — 2026-08-20 (GROK, read-only prod + live eBird)

**Step 0 is closed.** User `gaylon` (id 1): 226 lifers, **32 distinct
loc_ids, 17 unresolved, 0 `lifer_loc_attempts` rows, 0 `no loc_id`.**
All 17 have a SubID. Last `sync_lifelist` jobs (246, 247) finished in
~3s with result `{total, matched, unmatched}` and **no `locs` key.**
`runSyncJob` only includes `locs` when it is truthy
(`job-handlers.ts` 1580). Combined with
`syncLifeListFromEbird`'s swallow (`result.locs = undefined` on any
throw), that means **the resolver threw before returning.** Poisoned
negatives (hypothesis a) is **false**. Cap leftover (b) is **false**
(17 < 25 and zero attempts). Stopped-on-error (c) is **true**, and
the error never became `EbirdError` so it was not even a clean
`stopped: true`.

**Root cause of the throw (live-verified).**
`GET /ref/hotspot/info/{locId}` for a **personal** L-id returns
**HTTP 200, empty body, `Content-Type` null** — not 404.
`ebirdFetchOrNull` treats `res.ok` as JSON and `res.json()` throws
`SyntaxError`. That is **not** an `EbirdError`, so
`resolveLiferLocations`'s per-unit catch rethrows, the outer
sync catch swallows it, **zero writes, zero attempts.** The
candidate list is ordered by `loc_id`; the first unresolved id is
`L16391957` (personal). One empty 200 aborts the whole pass, so the
nine *real* hotspots behind it never get their public coords.

**The 17, classified live against hotspot/info:**

Public hotspots (JSON 200 + lat/lng) — **9 loc_ids, 45 lifers**:
`L199974` Ravine Gardens SP, `L2272702` Ågestasjön, `L230621` Amelia
Island SP, `L2390323` Camp Chowenwaw Park, `L248149` UNF Nature
Trails, `L26951859` Visingsö--Erstad kärr, `L298649` Lake Apopka
Wildlife Drive, `L4072756` Evergreen Cemetery, `L9270019` Oslo
downtown.

Personal / unpublished (HTTP 200 empty body) — **8 loc_ids, 70
lifers**: `L16391957` Fort George Island (coords in the *name*),
`L16494455` 5511 Lakewood Cir E (41 lifers — the map's missing
mass), `L16817382` Goat Island (coords in the name), `L17386771`
Boneyard Beach, `L17676662` Mandarin Landing, `L18585037` Goat
Island, `L18649500` Fort George Island Cultural SP, `L26320859`
Hjo Sverige.

Marcus: 107 distinct locs, **75 unresolved** — same bug class (first
personal empty-200 would abort his pass too).

**Step 1 is closed — there is no same-origin JSON URL.** Logged in
as Gaylon via the existing CAS flow:

- `api.ebird.org/v2/product/checklist/view/{subId}` returns **200
  JSON with no lat/lng** (keys: `locId`, effort, species count — no
  `loc` object). Unusable for pins. Still fine as a locId echo.
- `ebird.org/ws/v2/…`, `/ws/v1/…`, `/api/v2/…`, `?fmt=json` → 404
  HTML or the same HTML page.
- `ebird.org/checklist/{subId}` as owner → **200 HTML**, ~210k,
  **contains `lat` / `lng` numeric pairs** (Lakewood Cir E:
  30.263016, −81.637047, repeated). Not a login wall.
- Checklist CSV download has **no coordinates**.
- Checklist JS (`checklist-report-app.min.js`) has **no lat fetch**;
  coords are already in the JSP.

So the "owner JSON" path in the first draft **cannot be implemented
as specified**. The owner data *does* exist, on the same `ebird.org`
host, in the HTML the CSV login already authorizes us to fetch.

**Implication for a clean implementation:** split the work.

1. **Must-fix, no CAS, no ToS change:** empty/non-JSON 200 on
   hotspot/info is a miss, never a throw. Next credentialed sync
   plots the **9 public hotspots** (and Marcus's equivalent). This
   is why the 17 exist at all.
2. **Personal 8:** same-origin owner **HTML** GET of
   `/checklist/{subId}`, tight extract of `lat`/`lng` numbers, store
   in user-scoped `lifer_loc_coords`. Same unofficial class as the
   life-list CSV fetch. JSON-only is **withdrawn**; HTML scrape of
   the whole page is still vetoed — extract only those two fields
   from the owner checklist document.

## What we actually do today (`resolveLiferLocations`)

Runs fail-soft at the **end** of `syncLifeListFromEbird` (after the CSV
import has already committed `ok`). Per loc_id, in order:

1. **Join `ebird_locations`.** Filled by `hydrateEbirdLocationPlaceIds`
   from **observation feeds**. Not a complete hotspot gazetteer.
2. **`GET /ref/hotspot/info/{locId}`** with the stored API key.
   Official hotspots → JSON lat/lng. Personal L-ids → **HTTP 200
   empty body** (not 404). `res.json()` throws; that is the prod abort.
3. **`GET /product/checklist/view/{subId}`** with the same API key.
   Live: **200 JSON with no lat/lng**. Unshared may 403. We persist
   `(user_id, loc_id)` in `lifer_loc_attempts` and **never retry**.
4. Strict match: coords kept only if `loc.locId === csv loc_id`.
5. **`DISTINCT ON (loc_id) … ORDER BY loc_id, sub_id NULLS LAST`**
   picks **one** SubID. A deleted/hidden sibling checklist becomes a
   loc-level permanent negative for every lifer at that spot.

Cap = 25 loc_ids per sync (up to 2 HTTP calls each). CSV-only import
does **not** call the resolver (td-b5986c pin 2). Settings enqueue
returns a queued message; worker completion lands in `jobs.result` /
admin history — there is **no** Settings completion flash.

`CookieJar` stores name=value only (no Domain/Path/Secure/SameSite) and
`fetchWithJar` sends the whole jar to every redirect hop.
`fetchAuthenticatedEbird` already allowlists **only** `ebird.org` and
`www.ebird.org` and refuses other hosts. `casLogin`'s jar is **not**
currently threaded into `resolveLiferLocations` (API key only).

## What we will not do

- **Google Geocoding / Places of `location_name`.** Vetoed
  (`resolveMissing:false`).
- **Send the CAS cookie jar to `api.ebird.org`.** Binding veto
  (CODEX1 #2). Cross-origin cookie leak + undocumented API-key-only
  host. `fetchAuthenticatedEbird` already refuses that host.
- **Whole-page HTML scrape** (My Locations, mychecklists, share
  links). A **tight `lat`/`lng` extract** from the owner
  `/checklist/{subId}` document is the verified fallback (live
  2026-08-20). JSON-only is withdrawn because no JSON URL exists.
- New recurring job type. Sync button on `/life`.
- Writing CAS-derived personal coordinates or names into the global
  `ebird_locations` gazetteer (CODEX1 #3). `/life` (any scope user)
  and `hotspotPlace` read that table by bare `loc_id`.
- Blindly storing checklist coords under a mismatched CSV loc_id **in
  `ebird_locations`** (CODEX1 #4).
- A new Settings "plotted N locations" completion flash (CODEX1 #9).
  The enqueue action does not wait for the worker. Surface on `/life`
  disclosure + existing job history.
- Classifying 401/403/login-redirect/HTML/malformed JSON/timeout/429/5xx
  as `no_coords` / `gone`. Those are retryable or stopped.
- User-specific IDs in a migration.

## Remedy

### 1. Harden hotspot-info; owner checklist HTML for personal pins

Keep API-key **hotspot-info first** (public, cheap, official
hotspots). **Harden the parse (live-verified must-fix):**

- HTTP 404 → miss (already).
- HTTP 200 with **empty body or non-JSON** → miss (`null`), **never
  throw**. Personal L-ids do this today; `res.json()` SyntaxError is
  what aborted every prod sync.
- HTTP 200 JSON with `latitude`/`longitude` numbers → INSERT missing
  `ebird_locations` (public hotspot).
- HTTP 403 → invalid API key, stop the pass, no negatives (existing
  pin).

API-key `product/checklist/view` is **not a coordinate source**
(live: 200 JSON, no lat/lng). Do not use it to plot pins. LocId echo
is optional and must not throw. A 200 whose `locId` ≠ CSV loc_id is
not a negative (CC1 pin C still applies if we keep the call).

**Owner fallback (personal L-ids only), same-origin HTML:**

- After hotspot-info miss, GET `https://ebird.org/checklist/{subId}`
  through the **post-CSV jar** / `fetchAuthenticatedEbird` allowlist
  (`ebird.org` / `www.ebird.org` only). Same unofficial class as the
  life-list CSV.
- Require 200 HTML, not a CAS login page.
- Extract the first plausible `lat` / `lng` numeric pair (observed
  on the owner JSP as `lat`/`lng` keys; Lakewood Cir E = 30.263016,
  −81.637047). Range-check lat ∈ [−90,90], lng ∈ [−180,180]. Four
  identical pairs were present; take the first valid pair.
- Do **not** parse the rest of the page, follow share/download
  links, or scrape My Locations HTML.
- Store in `lifer_loc_coords` (user-scoped). Never `ebird_locations`.
- No JSON URL exists to prefer. The earlier "stop if HTML-only"
  gate is **replaced** by this tight extract. Whole-page scrape
  remains vetoed.

If the HTML has no valid pair: try the next SubID (≤3). After
exhaustion: `no_coords` negative.

- Live-verify is **done** (2026-08-20): no same-origin JSON URL;
  owner HTML has `lat`/`lng`. Fetch that document through
  `fetchAuthenticatedEbird` (existing allowlist) or a narrow sibling
  that shares it. **Do not** widen the allowlist to `api.ebird.org`.
- **Domain/path-aware CookieJar first** (CODEX1 #2 + re-review
  hardening): on absorb, validate `Domain` against the **response
  origin** (a foreign redirect must not be able to plant
  `Domain=ebird.org`); honor host-only cookies (no Domain attribute);
  match Path and Secure when sending. Do **not** claim full SameSite
  semantics from the request URL alone — omit SameSite rather than
  fake it. Send only cookies that match the request URL. Required
  before any new authenticated endpoint.
- Thread the **actual post-CSV jar** into the resolver. Today
  `syncLifeListFromEbird` builds a **local** `casLogin` jar (lines
  568–575) while `fetchAuthenticatedEbird` calls `getSession`, whose
  memo is filled only by `loginFromStoredCreds`. Those are **not** the
  same object. Pin: either (a) pass that jar into a narrow
  same-origin fetcher used by the resolver, or (b) install the
  post-CSV jar into `sessionMemo` before resolve runs. A second
  blind `casLogin` is forbidden.
- **Explicit `deadlineAt`.** `runSyncJob` is an unbounded single
  function call (`job-handlers.ts` 346–368). `BATCH_TIME_BUDGET_MS`
  applies only to `runFrequencyJob`. There is no "remaining worker
  lease" to read. Pin: set `deadlineAt = claimedAt + SYNC_DEADLINE_MS`
  at job claim (pin **4 minutes**, same magnitude as the frequency
  budget unless review prefers otherwise) and pass it
  `runSyncJob` → `syncLifeListFromEbird` → every resolver fetch.
  Per-call timeout = `min(30s, remaining)`. Exhausted deadline →
  stop the pass, no negatives.
- Require Gaylon's acceptance of **GET `/checklist/{subId}` as the
  logged-in owner** (same unofficial website login already used for
  the CSV). Tight `lat`/`lng` extract only; no general HTML scrape.
  Official docs still do not document this; it is own-data, sequential,
  bounded, attributed, no raw HTML retained.

### 2. User-scoped pins, not a communal yard

Owner-JSON coordinates are **owner-private**. API-key checklist
**matches** stay in the public gazetteer; they never land here
(CC1 pin E).

New table `lifer_loc_coords`:

```
user_id            int  NOT NULL REFERENCES users(id) ON DELETE CASCADE
source_loc_id      text NOT NULL -- CSV LocID, the /life join key
canonical_loc_id   text null     -- loc.locId from the payload if present
lat, lng           float not null
loc_name           text null     -- payload name; do not overwrite seen_species
source_sub_id      text not null -- the checklist that supplied the pin
provenance         text not null -- v1: 'checklist_owner' only
fetched_at         timestamptz
PRIMARY KEY (user_id, source_loc_id)
```

`/life` loader (still join-only, still no live eBird):

```
LEFT JOIN ebird_locations el ON el.loc_id = ss.loc_id
LEFT JOIN lifer_loc_coords llc
       ON llc.user_id = $scopeId AND llc.source_loc_id = ss.loc_id
COALESCE(el.lat, llc.lat) AS lat, …
```

- Public hotspot-info hits still `INSERT … ON CONFLICT DO NOTHING`
  into **`ebird_locations`** (shared gazetteer, public data).
- Owner-derived pins **never** write `ebird_locations`.
- Viewers see the scope owner's pins (same as the rest of `/life`).
- Cross-user non-disclosure test: user B's `/life` / hotspot page must
  not observe user A's `lifer_loc_coords` row, including by guessing
  `source_loc_id`.

### 3. LocID mismatch is a mapping, not a rename

When payload `loc.locId` ≠ CSV `source_loc_id`:

- Store **both** on `lifer_loc_coords`. The pin belongs to this owner's
  life-list row (CSV id + this SubID), not to a global identity.
- Do **not** INSERT/UPDATE `ebird_locations` under either id from this
  path.
- Rendering: timeline location name stays `seen_species.location_name`;
  map pin uses `llc` coords. Hotspot deep-link only if
  `canonical_loc_id` (or source) is a loc_id that **already** exists in
  `ebird_locations` from a public/feed path — never 404 a personal L-id
  into `/hotspots/{id}`.
- The SubID used must be one of that loc's CSV rows (same user).

### 4. Several SubIDs per loc; negatives are loc-level only after exhaustion

Replace `DISTINCT ON (loc_id)` one-sub_id with a bounded set of distinct
non-null `sub_id`s per loc_id (pin **≤3 SubIDs per loc**, counted
against the CAS/API checklist budget). Try them in a stable order
(newest `first_seen` first).

Candidate SQL **must** also exclude already-plotted owner pins
(CC1 pin A):

```
AND NOT EXISTS (
  SELECT 1 FROM lifer_loc_coords llc
   WHERE llc.user_id = ss.user_id
     AND llc.source_loc_id = ss.loc_id)
```

Without this, every later sync re-spends the ≤25 CAS budget on the
17 just-resolved personal loc_ids and starves the tail.

Write `lifer_loc_attempts` **only after every eligible SubID is
exhausted** by a true owner-JSON miss (404 / JSON with no lat/lng).
Reasons (CHECK, after legacy handling): `no_coords` | `gone`.

Never a negative on: 401, 403, CAS login bounce, HTML body, malformed
JSON, schema drift, timeout, 429, 5xx, cap/deadline exhaustion.

### 5. Caps and deadline

Two budgets, sequential. Remaining is checked **and decremented before
each request** (clamped at 0; never negative):

- **Total HTTP** for the resolver pass: **≤40** (hotspot-info +
  API-key checklist + owner JSON combined).
- **Owner-JSON / CAS sub-budget: ≤25**.
- Hotspot-info successes **do** count against the total HTTP budget
  (they are network). They do **not** count against the CAS sub-budget.
- Stop the pass (no negatives) when either budget or `deadlineAt` is
  exhausted. Per-call timeout = `min(30s, remaining)`. 25 × 30s is
  not assumed to fit.
- Between loc_ids: `updateProgress` (job heartbeat + cancel check) and
  `bumpWorkerHeartbeat`. `runSyncJob` today only heartbeats at
  start/end; `WORKER_ALIVE_WINDOW_MS` is 60s.

### 6. Honest disclosure (loader must ship the states)

`/life` today cannot tell pending from negative (`unresolvedLocs` is
"loc_id but joined lat/lng is null"). Pin the loader to return **four
counts plus last-pass flags** (scope owner), not a single join-null:

| Field | How |
| --- | --- |
| `pendingUnattempted` | loc_id, no pin from either join, no **trusted** attempt row |
| `negativeByReason` | counts of `lifer_loc_attempts.reason` in (`no_coords`,`gone`) |
| last pass | `user_ebird.loc_resolution_status` (`ok` \| `capped` \| `stopped` \| `error`) and `loc_resolution_error` (set iff `error`) |
| `noLoc` | `loc_id IS NULL` |
| `hasCreds` | already returned, unused today |

Copy, never mixed, never "eBird returned no coordinates":

| State | Copy |
| --- | --- |
| `pendingUnattempted > 0` and **not** `hasCreds` | `N locations need an eBird sign-in sync to plot.` (CSV-only must not say "still resolving".) |
| `pendingUnattempted > 0` and last pass `capped` | `N locations still resolving — sync again to plot more pins.` |
| `pendingUnattempted > 0` and last pass `stopped` for **retryable** 429/timeout/5xx | same "still resolving — sync again" sentence. |
| last pass `status='error'` (persistent owner-JSON auth/schema) | do **not** say "sync again". Point at Settings / `loc_resolution_error`. |
| trusted negatives | `N locations have no map pin.` |
| `noLoc` | keep today's predate-tracking sentence |

Persistent auth/schema stop is **not** `life_list_status='error'` —
that flag is written `ok` **before** resolution and resolver
exceptions are swallowed (`ebird-account.ts` 604–619). Pin a
**separate fail-soft channel**: `user_ebird.loc_resolution_status` /
`loc_resolution_error`. Never flip a successful CSV import to failed.

Drop the blanket "more resolve on each sync."

### 7. Legacy attempts

Migration `0025`:

- Add `lifer_loc_coords`.
- Add `user_ebird.loc_resolution_status text`
  (`ok` | `capped` | `stopped` | `error`) and
  `loc_resolution_error text` (nullable; set when status=`error`;
  fail-soft, never fails the CSV import). CC1 pin D — two free-text
  columns are not a schema.
- Add `lifer_loc_attempts.reason text` (nullable at first).
- **Invalidate** existing reason-less rows in the **same transaction**
  (`UPDATE … SET reason = 'legacy_untrusted' WHERE reason IS NULL`,
  or `DELETE` where `reason IS NULL` — they are all NULL today). No
  user-id literals. Rollback/fallback: candidate SQL treats NULL and
  `legacy_untrusted` as unattempted, so a partial deploy cannot
  re-poison.
- Candidate selection **only** treats `reason IN ('no_coords','gone')`
  as terminal. Distrust is the rollback definition; do **not** add
  CHECK / NOT NULL in this migration.
- Follow-up migration may add CHECK (`reason IN ('no_coords','gone')`)
  + NOT NULL **after** candidate distrust is proven. Never classify
  parse / HTML / schema mismatch as `no_coords`.

Do not "retry after TTL" as a substitute for the owner-JSON path.

### 8. Sync result surface

Do **not** invent a Settings completion flash. `jobsPoll.track` already
narrates the running job. Durable numbers live in `jobs.result` (admin
history) and in the `/life` disclosure counts after the next page load
(poller invalidation on terminal). That is enough.

CSV-only import still does not run the resolver. Personal pins need one
credentialed sync — empty/unresolved copy is now the no-login sentence
in (6), not "still resolving."

## Tests (no prod credentials in `birds_test`)

cs.md: never seed real eBird credentials. Canned fetcher: hotspot
JSON, empty-200, and owner HTML with a known `lat`/`lng` pair.

- Forensic query helper is a SQL fixture in the test, not a prod login.
- **Empty/non-JSON 200** on hotspot-info → miss, resolver **completes**,
  later hotspot JSON in the same cap still INSERTs (the prod abort).
- Hotspot-info hit → `ebird_locations` INSERT, no `lifer_loc_coords`.
- Owner-JSON hit is excluded from the next candidate set (CC1 pin A):
  a second `resolveLiferLocations` makes **zero** owner-JSON calls for
  that loc_id.
- API-key 403 + owner JSON hit → `lifer_loc_coords` row for **that
  user**, provenance `checklist_owner`, **no** `ebird_locations` row,
  **no** attempt row.
- API-key checklist **200 with locId mismatch** is not a negative
  (CC1 pin C): owner JSON is called; on owner hit, `lifer_loc_coords`
  stores source + canonical.
- User B cannot see user A's `lifer_loc_coords` (direct query of the
  loader as B).
- Owner JSON `loc.locId` ≠ CSV loc_id → row keyed by CSV id, canonical
  stored, **no** `ebird_locations` write under either id.
- Two SubIDs at one loc: first 404, second hits → pin, no negative.
- One SubID 404, no siblings → negative `no_coords`.
- Owner HTML without a valid lat/lng pair → try next SubID; after
  exhaustion `no_coords`. Login-page HTML / 429 → `stopped`, no negative.
- 26 CAS-needed loc_ids → 25 owner fetches, `capped: true`, leftovers
  have no attempt row.
- Many hotspot-info successes plus CAS-needed: total HTTP cap binds;
  hotspot successes count against total, not CAS; remaining counters
  never go negative.
- `/life` copy matrix: no-login vs creds leftover vs verified negative
  vs no-loc vs auth-error.
- Migration: pre-wipe reason-less rows gone; candidate selection
  ignores NULL reason if any survive.
- Cookie jar: cookie with `Domain=ebird.org` is **not** sent to a
  non-matching host; a `Set-Cookie` from a foreign response origin
  claiming `Domain=ebird.org` is dropped; host-only + Path + Secure
  matching covered. Allowlist still throws on `api.ebird.org`.
- **CAS redirect-chain regression** (CC1 pin B): canned form GET →
  POST → 302 ticket → ebird.org session cookie → final page, through
  the domain-aware jar. ebird.org session cookie survives; CAS
  `JSESSIONID` is **not** sent to `ebird.org`. A filter bug here
  would break every life-list sync.
- Deadline: resolver stops with `stopped: true` and no negatives when
  `deadlineAt` is in the past; per-call timeout is `min(30s, remaining)`.
- Post-CSV jar is the jar the resolver uses (no second `casLogin` in
  the unit; inject the jar).
- Owner-JSON schema/login failure leaves `life_list_status='ok'` and
  sets `loc_resolution_status='error'` (CSV import not failed).

Do not CAS-login user 1 against the test cluster.

## Sequencing

**A (must-fix, no CAS):** `ebirdFetchOrNull` / hotspot-info: empty or
non-JSON 200 → `null`, never throw. Tests: empty body, `[]`, `{no
lat}`. Next Gaylon sync plots the 9 public hotspots. Can ship
alone.

**B (personal 8):** owner HTML GET + tight lat/lng extract +
user-scoped `lifer_loc_coords` + remaining CODEX1/CC1 pins
(domain-aware jar, jar threading, deadlineAt, multi-SubID, candidate
NOT EXISTS, disclosure, 0025). Dual review. Hold for Gaylon.

Do not CAS-login user 1 against the test cluster.

## Open questions

**Closed:** prod 17 classified; resolver throw identified; no
same-origin JSON URL; owner HTML has lat/lng; checklist CSV has none.

**Gaylon 2026-08-20:** B accepted. User-scoped pins kept (he does
not mind sharing among family/friends today; scoped storage is for
later expansion). A can still ship first; B is unblocked.

Optional later (not v1): parse `location_name` trailing `lat, lng`
(covers 2 of 8 personal names). Not a substitute for A or the HTML
extract.

## Question dispositions (CODEX1, adopted)

1. Cookie-auth to `api.ebird.org` — **not proven**. Do not ship.
2. Cross-host jar — **fantasy until a same-origin request is observed;
   current cross-host jar use vetoed.**
3. Thread the exact post-CSV jar — **yes**, after cookie scoping, with
   an absolute sync `deadlineAt`.
4. Global `ebird_locations` for personal pins — **yes, privacy bug.**
5. Blind locId-mismatch storage in the gazetteer — **yes, corrupts
   identity.** Mapping lives only on per-user `lifer_loc_coords`.
6. Permanent "still resolving" for CSV-only — **yes, a lie.**
7. Wipe — **only as atomic legacy invalidation after the resolver is
   safe.** No user ids in the migration. Candidate SQL distrusts NULL.
8. Cap and supportability — **need the pins above.** JSON-only,
   sequential bounded fetches, attribution, no raw payload retention,
   owner acceptance of the verified unsupported endpoint.
