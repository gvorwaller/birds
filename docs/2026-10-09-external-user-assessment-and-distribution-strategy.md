# Birds: external-user assessment and distribution strategy

*Assessment date: 2026-10-09. Scope: research and assessment only. No product change is authorized by this document.*

## 1. Executive summary

Birds could interest a narrow group of experienced eBird users who want to turn their life list, recent reports, seasonal patterns, and nearby hotspots into an outing. Its strongest question is **“Where should I go for birds I still need?”** Home, Forecast, hotspot pages, and the trip planner support that workflow ([Home loader](../src/routes/+page.server.ts), [Forecast loader](../src/routes/forecast/+page.server.ts), [trip planner](../src/routes/trips/plan/+page.server.ts)). This is a hypothesis about user value, not evidence of repeat use.

Do not invite unrelated users yet. The checked-in [nginx configuration](../deploy/nginx.conf) describes Cloudflare Flexible TLS and HTTP from Cloudflare to the origin, while Birds accepts passwords and stores optional eBird login credentials. [Cloudflare recommends Full or Full (strict)](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/flexible/) for login and personalized data. The [backup script](../scripts/backup-pg.sh) checks archive structure, but the reviewed evidence does not show a completed restore drill. Verify the live configuration and recovery path before invitations.

This assessment used current source and project documentation, current external product and provider pages, and one live unauthenticated request. On 2026-10-09, the public home URL redirected to `/login?returnTo=%2F`. No signed-in production journey, device test, production-data inspection, or load test was performed. Signed-in polish and capacity remain unverified.

## 2. What Birds actually does

| Area | Implemented | Limit |
| --- | --- | --- |
| Platform | SvelteKit/Svelte 5, Node adapter, PostgreSQL, a background worker, and a shared DigitalOcean droplet ([package](../package.json), [PM2 configuration](../ecosystem.config.cjs)). | Capacity for 20–30 active birders has not been measured here. |
| Accounts | Administrator-created `admin`, `user`, and linked `viewer` accounts; Argon2id password hashing; database sessions. Viewers read a selected owner's life-list scope ([account creation](../src/routes/settings/+page.server.ts), [auth](../src/lib/server/auth.ts), [scope](../src/lib/server/access.ts)). | No public registration or guest mode. Provisioning and password resets require the owner. |
| Personal data | Encrypted eBird API key and optional web-login credentials; life-list species, home area, trips, interests, and viewed species persist by account ([schema](../backend/db/migrations/0001_schema.sql), [view history](../src/lib/server/species-views.ts)). | The credentialed life-list sync uses an unofficial eBird web-login flow. CSV import is the fallback. |
| Field Guide | Search by name and enriched text, trait tags, family, All/Need/Seen, and country through hotspot or map area. Results are paginated and linkable. Species pages include identification material, similar species, seasonal distribution, reports, and source links when data exists ([guide](../src/routes/species/+page.server.ts), [species detail](../src/routes/species/[code]/+page.svelte)). | Enrichment and geographic coverage vary. This is not verified automatic photo or sound identification. |
| Field planning | Home compares local reports with the user's life list. Forecast uses stored seasonal data. Hotspot pages offer recent and monthly views. Trips can plan and save stops, show needs and field context, and navigate or export ([Home](../src/routes/+page.server.ts), [Forecast](../src/routes/forecast/+page.server.ts), [hotspot](../src/routes/hotspots/[locId]/+page.server.ts), [trip](../src/routes/trips/[id]/+page.server.ts)). | Useful output depends on account setup, available reports, and loaded historical coverage. |
| Photos and alerts | Gallery links to the owner's `gaylon.photos` collection; other users without a configured photo source see an empty state. Need alerts use Web Push and an in-app history ([gallery](../src/routes/photos/+page.server.ts), [alerts](../src/routes/alerts/+page.server.ts)). | The owner's photography is not a personal gallery workflow for every new user. Push requires device setup. |
| Mobile/PWA | Responsive navigation and an installable manifest exist ([navigation](../src/routes/+layout.svelte), [manifest](../static/manifest.webmanifest)). | The current [service worker](../src/service-worker.ts) intentionally does not cache pages offline. “Installable” must not be described as “works offline.” |

Administrative, data-loading, and taxonomy-study tools also exist. Their presence is not a reason to put them in a first-user pitch.

## 3. Most compelling features

| Candidate | Birder and reason to use it | Sufficiently polished to attract a new user? |
| --- | --- | --- |
| Personal needs at a chosen place | An experienced eBird user can view recent birds around a destination through their own Seen/Need lens ([Home](../src/routes/+page.server.ts)). | **Conditional yes.** API-key and life-list setup must work first. |
| Place and season exploration | A travelling birder can compare likely months and places using stored frequency data ([Forecast](../src/routes/forecast/species/+page.server.ts), [Field Guide](../src/routes/species/+page.server.ts)). | **Promising.** Coverage must stay explicit: unknown or unloaded data does not mean no birds. |
| Needs-aware trip planning | A birder can compare stops, save a route, and use it in the field ([planner](../src/routes/trips/plan/+page.server.ts), [trip detail](../src/routes/trips/[id]/+page.server.ts)). | **Best beta task.** It joins the strongest existing capabilities into a concrete outcome. Validate it with unfamiliar users. |
| Integrated species study | Intermediate birders can combine traits, similar species, seasonal context, and reports ([species sections](../src/routes/species/[code]/+page.svelte)). | **Supporting value.** Uneven enrichment and established guides weaken it as the sole acquisition claim. |
| Photography connection | The owner's linked photographs make Birds personal and may start conversations with photographers ([gallery source](../src/lib/server/gallery.ts)). | **No as a general-user feature.** New accounts do not get a personal photo workflow. |

These are useful *combinations*, not unique underlying data. eBird already offers nearby species, hotspots, Targets, Needs Alerts, and species profiles. Birds' possible distinction is the path from a personal need to a place, seasonal context, and a saved outing ([eBird species exploration](https://support.ebird.org/en/support/solutions/articles/48001255128-find-birds-with-ebird), [eBird Targets](https://support.ebird.org/en/support/solutions/articles/48000960317-ebird-alerts-and-targets)).

## 4. Comparison with existing birding applications

- **Merlin** is stronger when the task is identifying a bird in front of you, including stepwise, photo, and sound ID. Birds should not promise to replace it ([Merlin](https://merlin.allaboutbirds.org/)).
- **eBird** remains the record system and strongest direct competitor for reports, hotspots, Targets, and alerts. Birds' possible advantage is a personally tuned planning workspace; beta users must decide whether it saves enough steps ([eBird Explore](https://support.ebird.org/en/support/solutions/articles/48001255129-explore-regions-and-hotspots), [Targets and alerts](https://support.ebird.org/en/support/solutions/articles/48000960317-ebird-alerts-and-targets)).
- **iBird** offers a mature illustrated reference and detailed search. Birds' possible advantage is live personal planning context rather than reference depth ([iBird](https://www.ibird.com/about/ios/about.html)).
- **Audubon Bird Guide** already combines bird ID, nearby exploration, sightings, lists, and alerts. Merely placing those features together is not distinctive ([Audubon app help](https://apphelp.audubon.org/en/collections/6267981-using-the-app), [Bird ID](https://apphelp.audubon.org/en/articles/8416230-using-bird-id-to-identify-a-bird)).

## 5. Likely target users

Start with experienced eBird users who plan outings around life-list needs, particularly people who bird several Florida sites and are comfortable trying a web app. Intermediate birders who like species comparison and seasonal patterns are a second group. Casual backyard birders are less likely to complete API-key and life-list setup. Photographers may enjoy the owner's images, but the current photo feature gives them little personal workflow. These are hypotheses to test, not measured demand.

## 6. External-user readiness

### Critical before invitations

1. **Secure the transport path.** Confirm the live Cloudflare setting and encrypt the origin leg for credential-bearing traffic. The checked-in [nginx configuration](../deploy/nginx.conf) says Flexible TLS; [Cloudflare's guidance](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/flexible/) says login and personalized data should use Full or Full (strict). Because the droplet hosts sibling applications, plan the change deliberately.
2. **Prove recovery.** Check the actual backup schedule, the last successful off-host copy, and an isolated restore. `pg_restore -l` establishes that an archive can be read, not that user data and trips can be recovered ([backup script](../scripts/backup-pg.sh), [recovery plan](2026-10-09-infrastructure-tightening-plan.md)).
3. **Verify effective login abuse protection.** The reviewed [login action](../src/routes/login/+page.server.ts) and [nginx file](../deploy/nginx.conf) do not show an application or nginx rate limit. Cloudflare may supply a rule that the checkout cannot show. Verify the live edge policy, and add one bounded control only if absent. Source inspection alone does not establish exploitation.
4. **Explain data handling.** Invitees need to know that Birds stores their API key, optionally eBird username and password, life list, home location, and trips; who operates it; how to request deletion; and that web-login sync can break ([schema](../backend/db/migrations/0001_schema.sql), [credential settings](../src/routes/settings/+page.server.ts)). [Google Maps JavaScript API policy](https://developers.google.com/maps/documentation/javascript/policies) calls for publicly accessible Terms of Use and a Privacy Policy incorporating Google's terms; verify the precise Maps services in use and comply before opening access.

### Important, but not automatic blockers

- Test a genuine new-account phone and desktop journey: provision → sign in → set key and home → import life list → plan a stop → reopen it.
- Check per-user access with distinct test accounts on representative shared links, trip actions, and personal pages. The central [scope model](../src/lib/server/access.ts) is sensible but does not prove every route.
- Make the invitation and first sign-in explain one useful task. The public [login page](../src/routes/login/+page.svelte) currently says only “Sign in to continue.”
- Observe actual concurrency and provider cost before making a capacity claim. The web and worker are single PM2 processes on a shared droplet ([PM2 configuration](../ecosystem.config.cjs)).

## 7. Security, privacy, licensing, and infrastructure risks

The unusual privacy burden is holding another service's login password. Birds [encrypts it at rest](../src/lib/server/crypto.ts), but must decrypt it for unofficial sync. Clear opt-in and a usable CSV fallback reduce the obligation to fix every upstream login change. Account creation and password recovery are owner-managed, which is suitable for a small private beta but becomes administrative work if invitations expand.

Data rights warrant a focused review rather than a rewrite. [eBird API terms](https://www.birds.cornell.edu/home/ebird-api-terms-of-use/) permit specified noncommercial use, require attribution, and govern API keys and rate effects. Birds already renders eBird attribution. The species page shows Wikipedia revision and CC BY-SA attribution, while media records store source and license metadata ([species attribution](../src/routes/species/[code]/+page.svelte), [media metadata](../src/lib/server/species-enrichment.ts)). Verify representative live assets and each provider's terms before claiming the whole enriched corpus is cleared for broader distribution.

Birds depends on eBird, Google Maps, `gaylon.photos`, and enrichment providers. The [gallery cache](../src/lib/server/gallery.ts) preserves links across some source failures, but the source is personal infrastructure. The installable app needs a network connection for pages ([service worker](../src/service-worker.ts)).

## 8. First-time user experience

A birder receiving only the URL reaches an opaque login screen, with no preview, explanation, or account-request path. After manual provisioning, the most useful personal workflow asks for an API key and preferably a life-list import. Home deliberately skips expensive place enrichment before a first sync ([login](../src/routes/login/+page.svelte), [Home first-sync behavior](../src/routes/+page.server.ts)).

The smallest improvement is an invitation and first-run explanation built around one exercise: “Bring your eBird list; choose Huguenot or another familiar area; see your needs; save a two-stop outing.” A public guest mode would add another data and maintenance path before its value is established. Do not promise offline field access.

## 9. Distribution and recruitment strategy

Use personal invitations before group posts. Begin with four to six birders known from Huguenot, Spoonbill Pond, Merritt Island, or Lake Apopka. Ask each to try one real planning task, then ask whether they used Birds again a week later. If that works, invite another six to twelve through existing birding relationships. [Duval Audubon's field trips](https://duvalaudubon.org/field-trips/) welcome both seasoned birders and guests; attend for birding and conversation, not to make the chapter a support or promotion channel. [Huguenot](https://floridabirdingtrail.com/site/huguenot-memorial-park/) is a suitable familiar example.

For a ceiling around 20–30 people, use a few referrals from testers and perhaps one permission-respecting regional or photography-group post *after* the workflow proves useful. No particular Facebook group's current posting rules were verified, so none is prescribed. [Florida's birding trail](https://floridabirdingtrail.com/) supplies site and event context, not a marketing schedule.

Suggested invitation: “I built a private birding planner for myself. It uses your eBird list to help choose places to look for birds you need. I'm inviting a few birders to try it on a real outing; there's no obligation to keep using it or send formal feedback.”

## 10. Minimal analytics and feedback

Birds already records `last_login_at`, account life-list and trip counts for the administrator, optional per-account species-view history, and operational health and timing ([admin user query](../src/routes/settings/+page.server.ts), [view history](../src/lib/server/species-views.ts), [health](../src/routes/api/health/+server.ts)). These show some activity, but not whether a particular screen helped someone. No broad product-analytics system was established in this review.

For 10–20 testers, use a small private dated note with only: invited, onboarded, returned in week two, returned in week four, useful task completed, and one optional comment. Check existing login and trip data instead of adding page tracking. Around week three, ask once: **What task did you use Birds for? What stopped you? Would you choose it again for that task?** State this light measurement in the invitation. Do not inspect personal searches or locations to infer engagement.

## 11. Prioritized implementation plan

| Stage and task | Objective and reason | Complexity / expected benefit / ongoing burden | Necessary? |
| --- | --- | --- | --- |
| **A1 Transport** | Verify live TLS and encrypt the origin leg before more people submit credentials. | Medium / high / low after setup | **Yes** |
| **A2 Recovery** | Confirm an off-host backup and complete an isolated restore so a failure does not become a data-recovery emergency. | Low–medium / high / low, with occasional repeat | **Yes** |
| **A3 Access and privacy** | Verify effective login protection; provide short data-use, deletion, and provider-required notices. | Low–medium / high / low | **Yes** |
| **A4 First-run check** | Test one newly provisioned account, give invitees a one-task guide, and fix only demonstrated blockers. | Low–medium / high / low | **Yes** |
| **B1 Private beta** | Invite 10–20 suitable birders in two waves and ask them to plan a real outing. | Low / potentially high learning value / bounded invitation window | **Yes, if external use is desired** |
| **B2 Observe** | Review return use at weeks two and four and collect one short round of comments. | Low / high learning value / low | **Yes for deciding whether to expand** |
| **C1 Conditional expansion** | If several people independently return for planning, allow referrals up to about 30–50 total accounts. | Low / uncertain / grows with accounts | **Optional** |
| **C2 Evidence-led fixes** | Address only bottlenecks or recurring confusion observed in the beta. | Unknown / evidence-dependent / variable | **Optional** |

Stop rule: if fewer than a handful of the first 10–20 testers return for a second independent outing, do not build a growth funnel. Ask whether they preferred Birds for any particular task and keep using it yourself.

## 12. Features or improvements not worth pursuing now

Public self-registration, a general guest/demo dataset, social feeds, a support portal, a new analytics service, another photo-hosting pipeline, and Merlin-style photo or sound ID would add ongoing work before the planning value is established. Broad offline caching is especially unattractive now: the [service worker](../src/service-worker.ts) records a prior stale-client failure and deliberately avoids caching pages.

## 13. Final recommendation

**A. Is Birds currently good enough to interest other birders?** Probably yes, within a narrow group of experienced eBird birders who enjoy planning around personal needs. The proposition is credible from implemented workflows; repeat use is unproven.

**B. What is the minimum work before inviting them?** Confirm encrypted transport to the origin, prove a restore, verify login protection, provide clear data and provider notices, and complete one genuine new-account planning journey. Fix only what that journey shows is blocking.

**C. How can Birds be shared while preserving the owner's freedom?** Keep accounts invitation-only, recruit through birding relationships in two small waves, set a 20–30-person ceiling, and ask for feedback once rather than running a community or support program. Let repeat use of the planning workflow, not registration count, decide whether to invite anyone else.
