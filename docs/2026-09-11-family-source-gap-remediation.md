# Family source-gap remediation — 2026-09-11

Task: td-b27120. Implementation is local; deployment and production retry are separate.

## Verified baseline

Production completed pipeline v2 with 240 current descriptions and 11 source gaps. No remaining audit errors justified changing successful descriptions. A read-only before/after comparison verified that all 240 publication fingerprints remained unchanged during implementation.

## Discovery results

The revised collector found usable, identity-verified sources for every remaining family. Scientific names and ranks are checked against avian Wikidata identities and the actual Wikipedia page identity. Sparse family/genus pages can use explicitly scoped living-species accounts.

| Code | Family | Source accounts |
|---|---|---|
| ansera1 | Magpie Goose | [Magpie goose](https://en.wikipedia.org/w/index.php?title=Magpie_goose&oldid=1372315454) |
| casuar1 | Cassowaries and Emu | [Cassowary](https://en.wikipedia.org/w/index.php?title=Cassowary&oldid=1374173603), [Emu](https://en.wikipedia.org/w/index.php?title=Emu&oldid=1366022980) |
| corvid1 | Crows, Jays, and Magpies | [Corvidae](https://en.wikipedia.org/w/index.php?title=Corvidae&oldid=1374258435) |
| falcun1 | Shrike-tits | [Shriketit](https://en.wikipedia.org/w/index.php?title=Shriketit&oldid=1367946414) |
| machae1 | Boatbills | [Yellow-breasted boatbill](https://en.wikipedia.org/w/index.php?title=Yellow-breasted_boatbill&oldid=1370254682), [Black-breasted boatbill](https://en.wikipedia.org/w/index.php?title=Black-breasted_boatbill&oldid=1343448494) |
| sagitt1 | Secretarybird | [Secretarybird](https://en.wikipedia.org/w/index.php?title=Secretarybird&oldid=1374260602) |
| spheni1 | Penguins | [Penguin](https://en.wikipedia.org/w/index.php?title=Penguin&oldid=1371936752) |
| steato1 | Oilbird | [Oilbird](https://en.wikipedia.org/w/index.php?title=Oilbird&oldid=1370152710) |
| upupid1 | Hoopoes | [Hoopoe](https://en.wikipedia.org/w/index.php?title=Hoopoe&oldid=1374071054) |
| yelfly10 | Yellow Flycatchers | [Little yellow flycatcher](https://en.wikipedia.org/w/index.php?title=Little_yellow_flycatcher&oldid=1314842728), [Livingstone's flycatcher](https://en.wikipedia.org/w/index.php?title=Livingstone's_flycatcher&oldid=1314955061), [Chestnut-capped flycatcher](https://en.wikipedia.org/w/index.php?title=Chestnut-capped_flycatcher&oldid=1313936700) |
| zeledo1 | Wrenthrush | [Wrenthrush](https://en.wikipedia.org/w/index.php?title=Wrenthrush&oldid=1337994316) |

## Implementation and preservation

- The existing v2 input-hash contract is unchanged. Resolver revision 3 is recorded separately on newly selected sources. No migration resets data or queues enrichment.
- Family-specific extraction retains natural-history sections without the species pipeline's text caps; taxonomy, fossil and reference-list sections do not provide padding. A source-quality screen requires multiple natural-history sentences, including short habitat/range accounts; the independent AI audit still decides whether the resulting claims are supported.
- Multi-document evidence uses document-specific passage IDs and explicit family/genus/species scope. Existing single-document records continue to work. The page links every source revision and its license.
- Discovery attempts, rejected drafts, insufficient-source inputs, and pre-retry snapshots are retained in the additive family_enrichment_diagnostics table.
- Selected retries validate family codes, skip current publications, archive obsolete pending state, and return the actual selected codes. Current-version paid drafts survive service retries. Expired failed refreshes retain their previous published content.
- Retry refuses to reset state during an active family attempt, with a clear instruction to pause and wait. Source discovery checks pause/cancellation between network requests. Existing service cooldown and final taxonomy/job ownership checks remain.

## Verification

- Live source discovery: 11 of 11 gaps resolved.
- Live Sonnet 5 generation and independent verification: Cassowaries/Emu, Oilbird, and Yellow Flycatchers passed; an intentionally unsupported control claim was rejected. These calls used the isolated test database, not production enrichment rows.
- WebKit at 390 and 1200 pixels: all source revision links, family selection controls, no horizontal overflow, no page errors.
- Focused unit, isolated database, and Admin-action tests cover source identities, source scope, insufficient material, preservation, retries, pause, and backwards-compatible attribution. Type/framework checks and production build are required before release.

## Release procedure

1. Deploy through scripts/deploy-to-DO.sh when deployment is authorized. Migration 0059 only adds the diagnostic journal.
2. Capture production state with scripts/family-remediation-state.mjs through the read-only SSH procedure in cs.md. Keep the JSON locally. It contains the taxonomy targets and fingerprints, never credentials or full source prose.
3. Run `node scripts/family-source-report.mjs <snapshot.json> > <discovery-report.json>` locally to verify live sources without DB writes or AI calls. Progress is emitted on stderr.
4. In Admin → Status → Family descriptions, select only the eleven codes listed above and use Retry selected family gaps. If a family has already become current it is skipped. Pause/resume controls remain available.
5. After the targeted batch, capture production state again and compare every pre-existing code's publication fingerprint. Report each targeted outcome and any retained source/audit diagnostic. Do not use total job/API successes as the enrichment success rate.

Local evidence is in `.local/family-remediation-*.json` and `.local/family-remediation-*.log`. These diagnostic files are intentionally untracked.
