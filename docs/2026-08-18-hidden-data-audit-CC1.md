# Hidden-Data Audit: everything the app has but doesn't show

## Context

Gaylon (2026-08-18, after learning alert trigger data was "available but not
exposed"): "Tell me ALL the data we have that is as yet not exposed in the UI.
All of it means opportunities for enhancements." This is a full-inventory
audit across three lenses — (1) database columns written but never/partially
rendered, (2) external-API fields fetched but dropped (or cached raw in
ebird_cache JSONB but untyped/unused), (3) loader payloads shipped to pages
but unrendered — compiled into a ranked opportunity list he can turn into tds.

## Inventory

### Lens 3 — shipped to pages but never rendered (route audit)

**/ Home:** notable rows hide `distanceKm` (computed+shipped; needs rows show
it, rare rows don't); per-species `nReports` hidden; `fetchedAt` reduced to a
binary "cached" badge (no as-of time); inline place lists lack the
eBird-hotspot chip + `locId` deep link that BestPlaces has; per-obs
subId/howMany/unconfirmed collapsed by aggregate(); bestPlaces ranks only the
recent feed — notable-only places never rank ("rare bird here" marker missing).

**/species/[code]:** `nearby[].subId` SHIPPED but unrendered — checklist links
one field away (the /alerts pattern); `obsValid/obsReviewed` shipped →
"unconfirmed" flag missing; `locationPrivate` → "personal location" note;
`seen.source` (how it got on the life list) hidden; `photos[].taken_on`
ordered-by but never captioned; teaser hides best-month % + lowSample at card
level; observer names never fetched (detail=simple; detail=full has
userDisplayName); pickSpeciesTeaserState computes month curves for EVERY
loaded state, returns one ("also good in GA (April)" thrown away).

**/species (Field guide):** every result ships full `tags` + `iucn_status` —
rows render neither (user JUST filtered by tags); name-tier/rank stripped
(could group "name matches" vs "mentioned in text").

**/forecast:** per-hotspot sample n hidden on site rows (only †);
county checklist-n + computed `longshot` band hidden; `oldestFetchedAt`
never shown (freshness line); `view.suggested` computed+shipped every request
but UI removed (render as "recommended picks" or stop shipping);
species sciName unrendered.

**/forecast/species:** the FULL 48-week sample_sizes histogram is shipped and
never drawn (chart is 12-month roll-up) — weekly sparkline / "18k checklists
behind this curve" is free; `unmatchedNames[]` shipped, only the count shown.

**/forecast/data:** `n_unmatched` SELECTed then dropped in row mapping (one
line to restore); sample_sizes not selected ("total checklists" column).

**/trips:** card hides `notes` preview; per-trip target totals derivable in
the same GROUP BY ("4 stops · 26 targets").
**/trips/[id]:** `needsCountForStops` builds the actual need-species SET per
stop and returns only .size — "3 needs here: Least Bittern, Black Rail,
Seaside Sparrow" is computed and discarded (biggest one on the page);
`target_count_at_save` shipped → "planned with 7, 4 reported now" delta;
hotspot county codes shipped → county-forecast deep link; search-result
hotspots lack the MapLink the other lists have; weather beyond name/text.

**/photos:** `taken_on` + GPS rendered ONLY on the map — grids show bare
thumbnails (no dates, no 📍); `match_method` hidden (fuzzy matches are
silent misfile risks with an existing override action); full-size `url`
unused (lightbox); coverage stat ("photos of 148 of 312 lifers") one query
away.

**/alerts:** row title links the checklist but nothing links the SPECIES
page; `reports[].obsDt` not shown on chips ("seen 2 hr before the alert");
per-report howMany + unconfirmed dropped at candidate build;
need_alerts_sent could power "muted until Aug 25" per species.

**/admin + APIs:** jobs API ships startedAt/durationMs the chip never shows
("running 4 min" free); geocode returns `bounds` MapPicker ignores (fit-to-
viewport); cache ages are admin-only while every page shows a bare "cached"
badge; health `version` could power a "new version — reload" hint;
progress.lastError unrendered even on /admin.

### Lens 1 — DB columns written but never/partially exposed

Fully dead (written, zero reads): sessions.created_at; user_ebird.updated_at;
photo_links.match_method; species_match_overrides.note/created_at (+ NO UI to
list/edit/delete overrides at all); jobs.heartbeat_at (stalled-job detection
impossible); worker_status.updated_at; user_alert_prefs.created/updated_at;
need_alerts_sent.first_loc_id/first_obs_dt/sub_id (the "why was I pinged /
muted until X" view); push_subscriptions.last_ok_at (never even WRITTEN —
silent-device warning needs one UPDATE first); species_enrichment.wiki_error/
ai_error (failures invisible even to admin), ai_model, updated_at;
users.created_at; the whole ebird_locations Google cluster
(google_place_name/lat/lng/types[]/distance_m/name_score/confidence/status/
first_seen_at — venue-type chips, address, match-quality audit, all dark).

Shipped-to-page but unrendered (see also Lens 3): species_enrichment
.wikidata_qid (free CC0 link), iucn_status + tags on guide rows;
need_alert_log.species_code (no path from an alert to the app's own species
page!) + reports[].obsDt; trip_stops.target_count_at_save (planned-vs-now
delta); trips.created_at; frequency_fetch.unmatched_names (count renders,
names never); users.home_google_place_id (mapsPlaceUrl already prefers it,
home links fall back to bare coords); seen.source per-species.

Structural: species_frequency stores 48 WEEKS; every UI collapses to 12
months — 4× temporal resolution unrendered (migration timing: "arrives ~week
2 of April"). seen_species.first_seen exists for every lifer — no life-list
timeline view exists anywhere. job_events narration (unit_ok/failed/retry)
admin-only; /forecast/data users watching a 60-county load see only a bar.

### Lens 2 — fetched from APIs but dropped (or cached raw, untyped)

KEY FACT: ebird_cache stores FULL raw JSON — most "dropped" eBird fields are
already in the DB; recovery is type-widening, not re-fetching.

eBird obs (in cache, untyped): exoticCategory (escapee flags!), county/state
codes per obs (group feed by county). Never fetched (detail=simple):
userDisplayName (observer names), hasRichMedia ("this report has PHOTOS" —
camera icon → Macaulay), hasComments. Unused params: hotspot-only feeds,
multi-locId feed (r= up to 10 locs — cheap "my patches" feed). Unused
endpoints: /data/nearest/geo/recent/{species} ("NEAREST LIFER CHANCE"),
/product/spplist, /product/stats, /product/lists (region checklist feed),
/ref/hotspot/info/{locId} (numChecklists per hotspot), checklist view,
/ref/region/info (bounds for map framing).

Taxonomy sync — the worst loss: fetched then DISCARDED every sync:
taxonOrder (canonical TAXONOMIC SORT — app sorts alphabetically everywhere),
bandingCodes (GBHE-style 4-letter codes birders type), order + familyCode
(browse-by-family), familySciName (typed, deliberately not inserted),
reportAs (subspecies→parent mapping — would cut barchart unmatched counts),
extinct/extinctYear. hotspotsNear fetches full records, keeps a locId Set.

Life-list CSV — parser keeps 3 columns (name, sciName, date); DROPS: Location
+ LocID ("where I got each lifer" = a LIFE-LIST MAP), SubID (link each lifer
to its checklist), Count, state/country (state life lists), exotic/countable
flags, row # (lifer #400 milestones). (Header set assumed — verify one live
export.) Barchart TSV: "Number of taxa" preamble dropped (coverage metric);
hybrid/spuh/subspecies-group rows discarded wholesale (Harlan's, Cackling-
type frequencies); matcher is common-name-only (no sciName fallback).

Wikidata — current 6 properties all render (clean pipeline). NOT asked for,
same single query: P18 image (species with no gallery photo have ZERO
imagery), P51 audio, taxon range-map image, LENGTH (the field-guide
measurement — we show mass+wingspan but not length), lifespan, clutch size,
IUCN assessment date, common names in other languages, GBIF/EOL/ITIS/
Avibase/BirdLife/Birds-of-the-World cross-ids.

Wikipedia: the section whitelist DROPS standalone "Vocalization(s)"/"Voice"
— arguably the most field-useful section in a bird article; also In culture,
Etymology, Predators, Similar species. Not requested: pageimages (free lead
image, one param), categories, revision timestamp (attribution shows fetch
date, not edit date). Section-cap flush can silently skip a long section
then keep a later short one. AI prompt re-filters to a NARROWER section set
than the UI shows.

Weather (NWS) — caches the trimmed payload (unlike eBird, re-fetch needed):
keeps 4 of ~14 periods (multi-day trips see 2 days); drops detailedForecast
(better AI input), startTime (can't align periods to stop arrival times),
windGust (seawatching/raptors), humidity/dewpoint (fog), icon. Unused:
hourly forecast, active ALERTS (severe weather on a trip day), current
conditions (app has forecast only, no "now"). NO TIDE SOURCE AT ALL — NOAA
CO-OPS would pair directly with the tide: tag vocabulary.

Google: Places types[]/formatted_address/opening_hours ("gate opens at
sunrise") dropped; geocode address_components (derive eBird region codes
from a search); Directions overview_polyline (can't draw the actual route —
only pins), per-leg times ("42 min to stop 3"), traffic ETAs.

Gallery API (per own design doc): exif (camera/lens/settings), speciesAI
(independent ID guess — could auto-resolve the unmatched pile), phash
(burst dedupe) — none typed or stored; full-size url stored, unused
(lightbox). Sync is delete+reinsert — any future per-photo state dies.

AI: Anthropic usage tokens discarded (NO cost accounting anywhere);
max_tokens truncation parsed as if complete; ai-guidance asks the model to
attribute each tip to weather-vs-behavior then THROWS THE ANSWER AWAY
(schema keeps only "tip"); droppedTags (vocabulary-evolution signal) only in
prunable admin job events.

## Ranked enhancement opportunities

**Tier 1 — already on the page, render it (hours each):** species-page
checklist links + unconfirmed flags; /alerts species-page link + report
ages; Home notable distances + report counts + as-of time; guide-row tag
chips + IUCN; trip-stop need NAMES + planned-vs-now delta; photo dates +
match-method + lightbox; n_unmatched on /forecast/data + names on
/forecast/species; job chip "running 4 min".

**Tier 2 — stored, needs plumbing (about a day each):** weekly migration
timing (48-week data); ebird_locations venue chips/filters; "muted until X"
alerts view; silent-device warning (write last_ok_at); enrichment error
visibility + Wikidata link + ai_model attribution; life-list timeline
("your birding year"); home place-id map links; droppedTags report;
overrides management UI.

**Tier 3 — in the raw cache, type-widening:** exotic/escapee flags; county
grouping on feeds; full hotspot records on the near path.

**Tier 4 — one API param/endpoint/query away:** detail=full (observer names,
PHOTO icons on reports); taxonomy resync with taxonOrder + banding codes +
family browse; life-list CSV re-import (LIFE-LIST MAP, lifer checklists,
state lists); nearest-lifer endpoint; Wikidata images/audio/length/lifespan;
Wikipedia Vocalization section + lead images; NWS 7-day/hourly/alerts +
NOAA TIDES; Directions polyline + per-leg ETAs; gallery exif/speciesAI/
phash; AI cost accounting.

**Marquee features hiding in the data:** (1) Life-list map + timeline;
(2) taxonomic sort + 4-letter-code search + browse-by-family; (3) "nearest
lifer" page; (4) weekly migration timing; (5) photo-bearing report flags;
(6) tides beside the tide: tags.

## Proposed next step (on approval)

File tds per tier (Tier 1 as one batch td, marquee features individually),
then implement the Tier-1 batch first — all fields already cross the wire;
it's a render-only change set, one review cycle.
