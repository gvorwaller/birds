# Birds UX phase 5B — independent review

September 19, 2026 · td-750277 · Parent td-8ff597

Status: independently accepted; submitted for owner review. Not committed or deployed.
Production remains phase 5A, `c731094`.

[Detailed specification](phase-05b-navigation-adoption.md).

## Delivered behavior

The released journey context now covers Field Guide, Taxonomy, Viewed species,
Special interest, Photos, Life list, Home, Nearest, Alerts, bird-to-Forecast,
Forecast hotspot results and Hotspots & data. Each adopted source registers a
trusted name, keeps its complete canonical content URL and gives each meaningful
row a stable focus target. Root workspaces stay visually quiet when opened from
primary navigation while still participating in an onward journey.

Bird family/order links enter the focused Taxonomy family and return to the
bird. Forecast treats selector changes for one bird as one workspace and a
different bird as a distinct resource. Home and Nearest report origins use real
report/location/time identity rather than species alone. Alerts use alert ID plus
species; shared Life-list navigation stores state under the signed-in viewer,
not the list owner.

Ordinary links still carry a named, nonrecursive immediate fallback. Reload,
new-tab, JavaScript-disabled and blocked-storage paths retain filters and remain
usable without stored ancestry. Help and About explain the wider behavior.

## Independent verification

| Check | Verified result |
| --- | --- |
| Field Guide → bird → Taxonomy → another bird → returns | Chromium and WebKit at 390px restored Ridgway's Rail in the Rallidae taxonomy, then Black Rail on Field Guide page 2. `country=US`, `sort=name`, the unknown `future=kept` key and `#results` all survived. |
| Searched Home → bird → return | Jacksonville, 50-mile, 7-day Home restored Blackburnian Warbler and retained `place`, `dist` and `back`. |
| Bird → Forecast → county → hotspot → returns | Common Grackle entered the named Forecast workspace, opened a real Manatee hotspot row, returned to that focused row, then returned to Common Grackle. Same-bird month/county/hotspot-count changes did not deepen the path. |
| Nearest → report hotspot → return | White-rumped Sandpiper at 30 days/500 km opened the real Big Talbot report hotspot and returned to its checklist/location/time-specific row with all controls retained. |
| Collections | Photos returned to `photos-species-royter1`; Alerts returned to `alert-27-whrsan`. Both exact links regained focus. |
| Desktop and mobile browsers | Chromium 390px and 1280px plus WebKit 390px passed the full journey suite with no page errors or horizontal overflow. |
| Degraded modes and account isolation | Chromium and WebKit passed bird-detail reload and exact origin restoration, JavaScript-off/new-tab immediate fallback, blocked sessionStorage fallback, and family-viewer Life-list navigation in namespace `u2` with no owner `u1` namespace. |
| Code checks | 89 focused tests across 10 files passed; framework check reported zero errors and zero warnings; production web and worker builds passed; diff whitespace check is clean. |

The browser acceptance used real copied-production accounts, taxonomy, alerts,
reports, photos and frequency data. Manatee's cached county list initially had no
frequency rows for its bounded selected hotspots. Through the normal test app
action, job 5433 loaded six selected hotspots and succeeded; the resulting real
Common Grackle rows enabled the county-to-hotspot journey. This changed only the
isolated test database. Production was not read or written for phase 5B.

## Review corrections that mattered

- Replaced source names accidentally used as destination labels, so every path
  displays the page or record it actually opens.
- Registered root workspaces without adding unconditional back controls.
- Reconciled Taxonomy's direct `focus` behavior with shared delayed restoration.
- Adopted bird-detail family/order and Forecast links without recursive return
  URLs, and made each selected Forecast bird a distinct resource.
- Adopted Home place/report, Nearest report, Photos, Alerts and Life-list rows
  with stable IDs derived from actual records.
- Preserved fragments when attaching SvelteKit history state. Added a common-core
  guard for the brief route-render/page-state race exposed by an explicit return
  after a document reload.
- Waited for streamed/hydrated targets before focusing; automation separately
  proved ordinary native links rather than treating fast pre-hydration clicks as
  application behavior.

## Data and release boundary

The protected Myakka baseline is unchanged: 5,657 species/week rows with the
original fingerprint, owner Seen count 227 and family enrichment paused. Test
health reports database, worker and gallery source healthy. Temporary browser
sessions were removed by the harness. The unrelated migration 0049 comment
remains outside this phase.

Evidence and executable browser checks are in the task's
`work/birds-ux/audit/phase05b-*` files. Phase 5B remains uncommitted and
undeployed pending owner instruction. Phase 6 covers drawer keyboard behavior,
map reveal/focus and touched control sizing; phase 7 covers compact Field Guide
controls and species-section navigation. The parent UX epic remains in progress.
