# Taxonomy reference fixture

`taxonomy-reference.json` contains unmodified sample rows from the public eBird
API taxonomy response, retrieved September 11, 2026:
https://api.ebird.org/v2/ref/taxonomy/ebird?fmt=json

Samples include species, an identifiable subspecific form, an extinct species,
and the real hyphenated `bird-o1` spuh identifier. Taxonomy data: eBird.org.

The database integration tests require the isolated `birds_test` taxonomy
snapshot with migration 0057 and source metadata backfilled. They use real
family membership and retain the separate source-driven ordering. No live
provider calls are made by these tests.
