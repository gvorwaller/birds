# Taxonomy refresh re-matches external sources (td-493c58)

Revision 2: CODEX1's hostile plan review (3 P2, 2 P3) is incorporated; see "Review changes" at the end. Where the sections below differ from that list, the list wins.

## Why
External sources (Artsobservasjoner today) store eBird species codes, matched by scientific name when a region loads (`matchExternalTaxa`, `src/lib/server/external-sources/taxa.ts`). The taxonomy sync does not touch them.

The eBird 2026 update (run 1, 2026-10-31) touches 7 Norway taxa (measured read-only on prod):

| Norway name | eBird change | Today | After a plain **Re-match species** |
|---|---|---|---|
| *Muscicapa striata* | `spofly1` became the slash "Spotted/Mediterranean Flycatcher"; the species is `spofly2` | **wrong**: 108 rows in 37 places on the slash | right (`spofly2`) |
| *Emberiza schoeniclus*, *E. pusilla*, *E. rustica*, *E. melanocephala* | genus moved (*Schoeniclus*, *Melophus*), codes kept | right | **lost**: no current species has that name |
| *Troglodytes troglodytes* | now *Nannus troglodytes*, code kept | right | **lost** |
| *Phylloscopus humei* | common name only | right | right |

Reed Bunting is in 43 Norway places and Eurasian Wren in 42. A plain re-match would trade one wrong species for five missing ones. The sources keep the names they publish, so every future genus move would do the same.

## What changes

### 1. The matcher remembers eBird's former names
In `matchExternalTaxa`, the order stays:
1. override;
2. current species with the same scientific name;
3. current issf/form → its species;
4. **new:** a former eBird name. This is tried only when steps 1–3 find nothing (no_match), never to break an ambiguity.

**Former name lookup:**
- It reads `taxonomy_backup_rows` (0099) for the names still unmatched: species, plus issf/form with their then `report_as`. Names compare by `normalizeName`.
- The newest backup that has the name wins.
- That old code is then followed into today's taxonomy:
  - still a species → that code (the buntings, the wren);
  - now an issf/form whose `report_as` is a current species → that species (a lump, e.g. House Swift → Little Swift);
  - anything else (a slash, removed, a spuh) → no match. eBird has no single answer, so it shows in Admin → Sources "Not matched" for **Change a match**, as now.
- If the newest backup holding the name gives more than one code → ambiguous.

**Recording it:**
- New method `former_name`. Migration 0100 widens the `external_taxa.match_reason` CHECK to allow it.
- Admin → Sources shows it as "matched by eBird's former scientific name *Emberiza schoeniclus* (eBird 2025)". `AdminMatched` gains `formerVersion`.
- The fallback applies everywhere matching runs: loads, overrides, **Re-match species** and the taxonomy run. It reads only backups, so it never needs eBird traffic.

### 2. The taxonomy run re-matches each source and records what moved
New tables (migration 0100):
- `taxonomy_source_rematches(run_id, source_id, rematched_at, moved, lost, gained, PK(run_id, source_id))`
- `taxonomy_source_changes(run_id, source_id, upstream_taxon_id, canonical_name, old_code, new_code, old_reason, new_reason, places, PK(run_id, source_id, upstream_taxon_id, canonical_name))`
- Both are `ON DELETE CASCADE` from `taxonomy_runs` and from `external_sources`.

**`rematchSourceForRun(runId, sourceId)`** runs in one transaction:
1. lock the source (`lockSourceDerived`);
2. snapshot `external_taxa` (code, reason);
3. `deriveSpecies(c, sourceId, null)`;
4. diff, insert the change rows and the summary row.

It never runs twice for the same pair: if the summary row exists, it is skipped. A retried finish would otherwise record an empty diff over the real one.
- `places` = distinct place keys in `external_place_month_species` for the new code, or the old code when the taxon was lost.

**In the job:**
- The run's `finish` step calls it for every active source, after `rematchPhotoLinks`.
- A failure leaves the run `compared`, and **Try again** resumes it, as today.
- The result gains `sources: {<id>: {moved, lost, gained}}`.

### 3. Admin → Taxonomy shows it
- **New run section "Other sources":** one line per source, e.g. "Artsobservasjoner: 1 taxon moved to a new species, 0 lost". There is a fold listing each change: name, old → new eBird species, places.
- "Lost" lines link to Admin → Sources, where **Change a match** fixes them.
- **For run 1**, which finished before this existed: a **Re-match sources** button appears on the newest run while a source has no summary row for it. It runs the same function. After that it disappears; everyday re-matching stays on Admin → Sources.
- **Instructions:** step 1's text adds that sources re-match themselves.
- **Help and About:** one line each.

## Not changed
- Override behaviour: an override pointing at a code that is now a slash still shows `override_code_missing`. Today there are none on prod (checked).
- eBird frequency data and life lists.

## Tests (birds_test, owned fixtures only)
- **Pure/matcher:**
  - current name beats a former name;
  - a former name gives a current species;
  - a former name whose code became an issf follows `report_as`;
  - a former name whose code became a slash, or was removed → no match;
  - an override still wins;
  - an ambiguous current name never falls back.
- **DB:**
  - fixture backups and a fixture source with reserved codes. `taxonomy_cache` is never rewritten: the matcher's taxonomy read is injected, as the run tests already do.
  - `rematchSourceForRun` records moved, lost and gained, and the places count;
  - a second call is a no-op;
  - a stale lock or claim writes nothing;
  - cascade on run delete.
- **Action:** admin-only; the button disappears once all sources are recorded.
- **Browser:** the new section in all 5 themes at 320, 390 and 1200, Chromium and WebKit, plus the iOS Simulator.

## After deploy (owner)
On the newest run in Admin → Taxonomy, press **Re-match sources**.

Expected: Artsobservasjoner shows 1 moved (Spotted Flycatcher → `spofly2`) and 0 lost. The five genus moves stay matched, now by former name.

## Review changes (CODEX1 plan review, 2026-10-31)
1. **P2: the places count read derived rows after the rebuild.** A lost taxon has no rows under its old code, and a shared species would count other taxa's places.
   - `places` is now counted from the raw rows of that exact (upstream id, name) pair, across monthly counts, records and recent reports. It doesn't depend on the match.
2. **P2: the first diff could be lost.** A connector publish (`deriveTaxa` is source-wide) or a Sources-tab re-match between the sync and the finish step would leave the run recording zero changes.
   - **Now:** a per-run, per-source **baseline** of `external_taxa` (code and reason per pair) is copied in the same transaction as the before-sync backup.
   - The diff is always baseline vs the matches after re-matching, so it is recomputed identically on every replay, whoever re-matched in between. Summary and change rows are replaced, not one-shot.
   - **Run 1** has no baseline. Its button takes the baseline at the moment it's pressed, and the card says so: "compared with the matches just before this re-match", not "before the sync". On prod nothing has re-derived `external_taxa` since the sync (max `updated_at` is 2026-10-29), so that baseline is still the 2025 one in practice. The card does not claim it.
   - A source added after a run's baseline gets a "before this re-match" baseline the same way.
3. **P2: "the newest backup holding the name wins" hides name reuse across years.**
   - **Now:** every backup holding the name gives a candidate, and each candidate is resolved into today's taxonomy.
   - Exactly one surviving species, with no unresolved candidate → match.
   - No surviving species → no match.
   - Different survivors, or a survivor plus an unresolved candidate → ambiguous.
   - Following stays bounded and needs no loop: a former issf/form takes its then `report_as`, then a code that is now an issf/form takes its current `report_as` if that is a species.
4. **P3: lost taxa aren't under "Change a match"** (that lists matched taxa only).
   - The card links to the source's **Unmatched taxa** section, where **Match species** is.
5. **P3: run 1's before-backup has no recorded version.**
   - No version is claimed. Admin → Sources says "matched by a scientific name eBird used before; eBird now calls it *X*".
- **Gates adopted:**
  - every write runs through `withClaimTx` (a plain transaction on the web path);
  - the source lock is taken before any read;
  - the button's action checks, under the run row lock, that its run is the newest run, is compared or done, and that no run is open;
  - tests cover a stale claim at finish, a connector publish or Sources re-match landing first, partial success then retry, and a stale run id posted to the action;
  - the matcher's taxonomy is injected for both `deriveSpecies` and `deriveTaxa` in DB tests.
