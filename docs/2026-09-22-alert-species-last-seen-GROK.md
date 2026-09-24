# Alert vs species last-seen mismatch — GROK spec (td-48c22e)

**Date:** 2026-09-22
**Status:** Binding implementation spec, amended 2026-09-23
**td:** `td-48c22e` — Last seen mismatch: Alerts vs species page

The Alerts page can show a close unconfirmed checklist that the species
page then describes as absent nearby, with a much farther Accepted row
labeled `source: nearest endpoint`. The same alert list can show two
sends from one calendar day as "2 days ago" and "1 day ago". This
document is the fix. Product choice, confirmed: when the live feeds
omit a checklist the alert already stored, the species page shows that
stored line.

## What the two pages actually read

An alert is a snapshot. The scan calls nearby notable observations for
the last 1 day, inside the saved alert radius, and refuses a stale
cache. The history page renders that stored title, body, and report
list. It does not ask eBird again.

The species page does not read that snapshot. Nearby reports call the
species geo feed for the page window (default 14 days, 50 km) without
`includeProvisional`, then merge a different notable request
(`back` = the page window). eBird omits not-yet-reviewed records unless
the request asks for them, so an unconfirmed checklist never enters the
species half of that merge. The notable half can still miss it: that
request has its own cache key, and a longer window is not a superset
when the payload is truncated or the checklist later leaves the notable
list.

Nearest reports retain the established direct-endpoint head start and
regional fallback. An earlier draft asserted, based on a comment about a
different region endpoint, that five direct rows could not be trusted as
the nearest five. That assertion was not verified for
`/data/nearest/geo/recent`, so this change does not alter the established
race, proof semantics, or shared regional-probe budget. The nearest and
species-recent caches last 3 hours. The alert uses a 30-minute notable
cache and will not notify from a stale one. A reload can therefore agree
or disagree depending on which feed answered and whether the cache
predates the checklist.

"Accepted" on the species page means `obsValid === true`. The alert
title "(unconfirmed)" means the report was not valid or had not been
reviewed. Those words stay as they are. Help already says the alert
word means not reviewed yet. The Amelia Island row was missing, not
mislabeled.

The right-hand alert stamp is `sent_at`, not the sighting clock.
`Math.round(hours / 24)` flips at about 36 hours, so two sends an hour
apart on Saturday can read "1 day ago" and "2 days ago" for about an
hour, then match again. The day header is already the local calendar
day of `sent_at`.

31 miles on the species page is the default 50 km radius. A report 23
miles from home is inside that circle. The Alerts species link does not
pass a searched place, so both pages are anchored on saved home.

## Behavior

1. **Nearby species feed includes unconfirmed records.**
   `recentNearbySpeciesObs` sends `includeProvisional=true` and stores
   the payload under a new cache key (`geosp2:`) so a provisional-free
   entry cannot be served for the old key.

2. **Nearest search behavior is unchanged.** The direct endpoint keeps its
   established head start; if it returns a real answer, it wins. The
   regional ladder starts only after that head start and shares the existing
   page-wide probe budget. Notable rows continue to merge in
   `nearestWithEvidence`. This ticket makes no new completeness claim about
   direct results and does not change `proven` semantics.

3. **Empty nearby copy follows the feeds.** When the merged live list
   is empty and every requested feed returned, the sentence is that
   the checked feeds returned no matching reports within the distance
   and window. When a feed was truncated, stale, or failed, the page
   says the look is incomplete and that other reports may be missing.
   It does not say there are no reports in that circle.

4. **Alert age uses elapsed time, then the calendar.** For the first 24
   hours, the stamp stays in minutes or hours even across midnight. After
   24 hours, day counts use the viewer's local calendar, the same calendar
   as the day header, so older alerts sent on the same date agree. The row
   stamp is prefixed "sent" so it is not read as the sighting time. The
   sighting time stays the exact eBird clock string.

5. **Stored alert line.** For the signed-in account (not the shared
   life-list owner), the species page loads that account's stored
   alert reports for this species. A report is shown only when its
   sighting date falls in the page's report window and the live nearby
   rows, plus nearest rows when that section was requested, do not
   already contain its checklist. Identity is the checklist id when
   eBird stored one; otherwise place plus sighting time. Duplicate
   alerts for the same checklist keep the newest send.
   The line shows the stored place, the stored distance from home, the
   sighting time, a checklist link when a checklist id was stored, and
   when the alert was sent. It has no Accepted or Unconfirmed chip and
   no map pin: the log does not store review flags or coordinates.
   The line sits in the recent-reports card. The nearest card repeats
   it only when the stored distance is closer than every live nearest
   row (or that card's live list is empty).

## Out of scope

Alert push wording, the `!obsValid || !obsReviewed` title rule, alert
radius, and the 30-minute scan interval stay as they are. The stored
line is not inserted into the live feed as if eBird had just returned
it. No About version note in this change; that belongs with the
release. No production reads, writes, or deploy.

## Tests that must fail on the previous code

- The nearby-species request omits `includeProvisional`, or reuses the
  `geosp:` cache key.
- Two `sent_at` values on the same local date can format as different
  day counts once both are at least 24 hours old.
- A stored checklist whose id is absent from the live rows is hidden,
  or a checklist the live rows already contain is shown again.
