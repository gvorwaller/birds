# Bird sightings sources beyond eBird: a survey by country (2026-10-22)

Part of epic td-eec7db (external sightings sources). The survey has two purposes:
1. **Reading eBird for a place.** Where a local portal holds most of a country's records, eBird likelihoods rest on a small and unusual group of birders, often visitors.
2. **Picking future connectors** for the generic ingest API (`docs/2026-10-21-external-sources-plan-CC.md`).

## Method
- **Source:** GBIF occurrence search, read-only and with no key: `taxonKey=212` (birds), `year=2024`, `occurrenceStatus=PRESENT`, faceted by `country`, then by `datasetKey` for each country (top 8 datasets).
- **Why 2024:** it is the last complete year of eBird's own copy on GBIF (the eBird Observation Dataset, `4fa7b334-ce0d-4e88-aaae-2e0c138d049e`). eBird's 2024 total there is 248.7M.
- **Units:** occurrence records. An eBird checklist with 40 species is 40 records, and so is a report portal's 40 single reports. The counts compare records, not checklists or birders.
- **Coverage:** 250 countries and 181 distinct datasets among the top 8 per country.
- **The script** (`gbif_survey.py`) is reproduced at the end. Re-run it for a later year once eBird's GBIF copy has caught up.

## Where a local portal beats eBird (2024, GBIF records)

| Country | Local source (GBIF dataset) | Local | eBird | Local ÷ eBird |
|---|---|---|---|---|
| Denmark | DOFbasen (DOF/BirdLife Denmark) | 2,095,338 | 212,390 | 9.9× |
| Sweden | Artportalen (SLU Artdatabanken) | 4,889,235 | 549,934 | 8.9× |
| Netherlands | Observation.org / Waarneming.nl | 4,388,163 | 598,982 | 7.3× |
| Norway | Norwegian Species Observation Service (Artsobservasjoner) | 1,557,241 | 352,576 | 4.4× |
| Estonia | Estonian Ornithological Society (BirdLife Estonia) | 211,620 | 54,279 | 3.9× |
| Nigeria | Nigerian Bird Atlas Project (ad hoc records) | 43,710 | 15,887 | 2.8× |
| Russia | iNaturalist research-grade + RU-BIRDS.RU (Moscow State Univ. Zoological Museum) | 474,932 + 264,066 | 277,490 | 2.7× combined |
| South Africa | Southern African Bird Atlas Project 2 (SABAP2) | 1,548,041 | 1,330,693 | 1.2× |
| Eswatini | SABAP2 | 12,746 | 10,958 | 1.2× |

## Where a local source is large but smaller than eBird

| Country | Source | Local | eBird |
|---|---|---|---|
| Germany | NABU naturgucker | 722,662 | 1,698,422 |
| Finland | Fourth Finnish Bird Atlas 2022–2025 + FinBIF Notebook | 75,086 + 69,886 | 475,806 |
| Australia | BirdLife Australia, Birdata | 961,711 | 8,707,543 |
| Belgium | Waarnemingen.be (non-native set shown on GBIF); Flemish farmland monitoring | 80,480; 82,004 | 218,839 |
| Namibia | SABAP2 | 69,093 | 145,324 |
| Zimbabwe | SABAP2 | 54,259 | 128,744 |
| Italy | Atlas of Wintering Birds in Italy (AIRONE) | 199,570 | 625,565 |

Global sources show up almost everywhere: iNaturalist research-grade (e.g. US 1.82M, CA 389k, AU 290k, MX 204k) and Observation.org (worldwide; e.g. ES 277k, DE 228k, FR 158k). Birda shows up in the UK (1.24M) and the US (322k).

## Where eBird dominates on GBIF (90–99% of 2024 bird records)
US, Canada, Mexico, Costa Rica, Brazil, Argentina, India, Japan, China, Taiwan, South Korea, New Zealand, Israel, Turkey, Spain, Portugal, Poland, Czechia, Slovakia, Hungary, Lithuania, Latvia, Ireland, Switzerland, Iceland.
- In the UK eBird is 82%, in Australia 84%, in France 69% and in Austria 63%.

## Caveat: GBIF only shows portals that publish to it
Several large national portals publish little or nothing there. This is from background knowledge and was **not verified in this survey**:
- Germany: ornitho.de
- Switzerland: ornitho.ch (Swiss Ornithological Institute)
- France: Faune-France
- Italy: ornitho.it
- Austria: ornitho.at
- Catalonia and the Basque Country: ornitho.cat, ornitho.eus
- UK: BirdTrack (BTO)
- Finland: Tiira (BirdLife Finland)
- Czechia: Faunistic database, birds.cz
- China: China Bird Report, birdreport.cn
- Brazil: WikiAves

In several of these countries the local data likely dwarfs eBird, even though GBIF shows eBird at 63–98%. It is also harder to get: mostly there is no open API, or data comes by request or under a data-sharing agreement.

## Not sightings (connectors must leave these out)
These show up high in some countries but are not reports of birds seen:
- **GPS-tracking datasets**, e.g. DELTATRACK and HG_JUVENILE / LBBG_JUVENILE gull tracking in Belgium, France, the Netherlands and Algeria, and the "Griffon Vulture movement on the Balkans" in Bulgaria.
- **Bird-ringing and recapture databases**: the Swedish ringing centre (NRM), Finland's TIPU and Luxembourg ringing records.

## How to read eBird for a place
- **Scandinavia, the Netherlands, Estonia (and, per the caveat, much of continental Europe and the UK):** eBird holds 10–25% of the records, or less. Its likelihoods rest on few checklists from a group of birders that isn't representative. Treat eBird percentages as rough, check the checklist counts behind them, and expect local specialities to be under-recorded.
- **Southern Africa (SABAP2):** an atlas protocol with set effort per grid square (pentad cards). It is the one non-eBird source here that could support a real likelihood. It would need its own record type in the ingest design: the "real checklists" extension, which is still kept out of the eBird tables.
- **The Americas, India, East Asia, Australia, New Zealand and Iberia:** eBird is the main record, and its numbers mean what they say.

## Candidate connectors (same pattern as Norway: reports via GBIF)
| Candidate | Coverage | Notes |
|---|---|---|
| Artportalen | Sweden | On GBIF; also has its own keyed API (api-portal.artdatabanken.se) |
| DOFbasen | Denmark | On GBIF |
| Observation.org | Worldwide; strongest in the Netherlands and Belgium | One connector adds data wherever it is strong |
| Estonian Ornithological Society | Estonia | On GBIF |
| RU-BIRDS.RU | Russia | On GBIF |
| SABAP2 | Southern Africa | Atlas with checklists, so it needs the checklist record type first |

## Script
```python
import json, urllib.request, concurrent.futures as cf, time
B = "https://api.gbif.org/v1/occurrence/search?taxonKey=212&year=2024&occurrenceStatus=PRESENT&limit=0"
def get(url):
    for i in range(4):
        try:
            with urllib.request.urlopen(url, timeout=60) as r: return json.load(r)
        except Exception:
            time.sleep(2 * (i + 1))
    return None
cs = get(B + "&facet=country&facetLimit=300")["facets"][0]["counts"]
def one(c):
    d = get(B + f"&country={c['name']}&facet=datasetKey&facetLimit=8")
    return c["name"], d["count"] if d else None, (d["facets"][0]["counts"] if d and d["facets"] else [])
out = {}
with cf.ThreadPoolExecutor(4) as ex:
    for code, total, ds in ex.map(one, cs):
        out[code] = {"total": total, "datasets": ds}
keys = {x["name"] for v in out.values() for x in v["datasets"]}
def title(k):
    d = get(f"https://api.gbif.org/v1/dataset/{k}")
    return k, (d.get("title"), d.get("publishingOrganizationKey")) if d else (None, None)
with cf.ThreadPoolExecutor(4) as ex:
    titles = dict(ex.map(title, keys))
json.dump({"countries": out, "titles": titles}, open("gbif_survey_2024.json", "w"))
```
