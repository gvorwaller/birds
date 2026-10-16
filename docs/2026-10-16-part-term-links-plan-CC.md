# td-e4c6dd — Link bird-part terms on species pages to Parts of a Bird

## Context
Species pages use field-guide words like supercilium, tertials or speculum. Many readers won't know them.
Parts of a Bird (td-9c9655, td-a1bfd9) already supports deep links: `/parts-of-a-bird#{diagram}-{part}` opens the right bird and view, highlights the part, shows its "look for" caption and scrolls to it.
This ticket turns those words on species pages into links to that highlighted part. Back returns to the species page.

## Owner decisions (2026-10-16)
- **Where:** Similar species notes, and the About section titled "Description" or "Description and taxonomy". Nowhere else: not the opening paragraph, not other Wikipedia sections, not "Finding this bird".
- **Words:** technical terms only. No crown, nape, rump, flanks, mantle, back, breast, belly, throat, bill, tail, wing or legs.
- **Part not on the bird's own drawing:** link to the drawing that has it.
- **Repeats:** first mention of each part per note, and per Description section.
- **Interaction:** a plain link to the page, and Back returns. A popover is out of scope.

## Measured on production (backup pulled 2026-10-16 05:07 UTC, read-only)
| Text | Count | Share with a technical term |
|---|---|---|
| `species_similar.note` | 25,807 notes | about 40%; nearly all have 1 or 2 terms |
| Description sections | 7,592 (7,330 "Description", 211 "Description and taxonomy", the rest other "Description…" titles) | about 75%; many name 4 or more terms |

**CODEX1 plan review (2026-10-16):** four P2 findings, all integrated: the exact title allowlist, unique focus ids, spelled-out variants, and the tap-size decision (owner).

- **Distinctive terms read correctly in samples:** tertials, primaries, speculum, supercilium and the coverts.
- **False matches seen:**
  - "behavior **mirrors** the common paradise kingfisher";
  - "scan the **crown**" (of a tree), excluded anyway;
  - "**back** of the neck", excluded anyway;
  - "**sides** of the breast", excluded anyway.
- Hyphen-joined forms ("White-browed", "black-crowned") must never match.
- The match rule is `(?<![\w-])…(?![\w-])`, case-insensitive.
- Only sections titled exactly "Description" or "Description and taxonomy" are included (exact allowlist, CODEX1 P2). The 51 other "Description…" titles are left out.

## Design

### 1. `src/lib/bird-parts/terms.ts` (new, pure)
- **`diagramForFamily(familySciName)`:**
  - Anatidae → `duck`;
  - Laridae and Stercorariidae → `gull`;
  - shorebird families → `shorebird`: Scolopacidae, Charadriidae, Recurvirostridae, Haematopodidae, Jacanidae, Burhinidae, Glareolidae, Rostratulidae, Thinocoridae, Chionidae, Dromadidae, Ibidorhynchidae, Pluvianellidae, Pluvianidae, Pedionomidae;
  - anything else, including null → `songbird`.
- **`TERMS`:** each entry is `{ part, pattern, gullOnly? }`. Technical list:
  - head: supercilium/supercilia/superciliary/eyebrow(s), lores/loral, eye-ring/eye ring/eyering(s), eye-line/eye line/eyeline/eyestripe/eye-stripe/eye stripe(s), ear coverts/ear-coverts/auriculars, submoustachial, malar, orbital ring(s);
  - every term spells out its hyphen, space, closed-up, singular and plural forms in `TERMS`. Corpus regressions include buggna→bktgna "little or no obvious white eye ring" and buggna→calgna "lacks a bold white eye ring" (CODEX1 P2);
  - bill: gonys, gonydeal spot;
  - upperparts: scapulars;
  - wing: lesser, median, greater and primary coverts; wing coverts/upperwing coverts; alula; tertials; secondaries; primaries; primary projection; wing bars/wingbars; underwing coverts/wing linings; axillaries; speculum/specula;
  - gull wing: tertial crescent, apical spots, mirrors (gull-group species only, because of the "behavior mirrors" misfire);
  - tail: undertail coverts, uppertail coverts, rectrices.
- **`partTarget(part, diagram)`:** uses the bird's own drawing if its glossary has the part. Otherwise it uses the first entry of `DIAGRAMS` that has it (owner: "use the drawing that has it").
- **`linkPartTerms(blocks: string[], diagram)`:** returns segments per block, `{text}` or `{text, diagram, part}`.
  - One combined regex, longest alternative first, so "primary coverts" wins over "primaries" and "underwing coverts" over "wing coverts".
  - The original wording and case are kept in the link text.
  - Only the first mention of a part in the whole call is linked. A Description section is one call, so blocks share the seen set.
- **Unit tests in `bird-parts.test.ts` or a new `terms.test.ts`:**
  - every `TERMS.part` exists in some diagram's glossary;
  - no excluded everyday word is ever linked;
  - hyphen-joined forms don't match;
  - the prod false-match sentences above stay unlinked;
  - first mention only, across blocks;
  - longest match wins;
  - the fallback drawing is used (e.g. "wing bars" on a duck goes to the songbird);
  - family mapping covers every family listed above.

### 2. `src/lib/components/PartTermText.svelte` (new)
- Renders segments as text plus `<a>`, never `{@html}`.
- **Link:** `href = withReturnTo('/parts-of-a-bird#d-p', current, …, comName)` with `onclick={navigationAction(accountId, { label: comName, originId })}`. This is the same pattern `SimilarSpeciesCard` uses for species links (`$lib/navigation-context`, `$lib/navigation-context.svelte`). `PathNavigation` on the Parts page (`hideWhenNoPath`) then shows the way back to the species.
- **Focus on Back:** `originId` must be unique on the page (CODEX1 P2). It is built from a caller namespace plus the part:
  - a similar note: `part-term-similar-{partnerCode}-{part}`, since each note links a part at most once;
  - a Description section: `part-term-desc-{sectionIndex}-{part}`.
  - A test covers two notes that both mention the same term. Focus is restored by `PathNavigation.svelte`, which looks the id up with `getElementById`.
- **Tap size (owner, 2026-10-16):** plain links inside the text. WCAG's inline-link exception applies, and the app already does this ("gallery sync", the Help links). The links don't use the 48px rule; the browser check confirms they're inline and nothing overflows.
- **Style:** the existing link token with a dotted underline, scoped CSS only, and AAA contrast in all 5 themes.
- **Accessible name:** the term itself, plus a visually hidden " (Parts of a Bird)" suffix.

### 3. Loader
- `src/routes/species/[code]/+page.server.ts`: add `family_sci_name` to the taxonomy SELECT (line 74) and to the taxon type (line 69).

### 4. Callers
- **`SimilarSpeciesCard.svelte`:** new prop `partsDiagram`. `.diff-note` renders through `PartTermText`, one call per note. The diagram comes from the page's own species.
- **`src/routes/species/[code]/+page.svelte`:** in the `wikipedia_sections` loop, when `s.title` starts with "Description", run `sectionBlocks(s.text)` (`src/lib/wiki-render.ts`). Text blocks are linked in one call per section; subheads stay plain. Other sections and the lead are unchanged.

### 4b. Found while building: the Parts page's path node (fixed)
- **Bug:** the Parts page registered its path node as `/parts-of-a-bird` (pathname only). A link arriving with `#songbird-supercilium` was pending under its full href, so the page never matched it. Instead it started a new path with no parent. The "Back to …" link then fell back to plain `returnTo`, which restored neither the open section nor focus.
- **Fix:** `PathNavigation href={page.url.pathname + page.url.hash}`. The page also gained `+page.ts`, which reads `returnTo`/`returnLabel` with `safeReturnTo`. With that, the back link names the species without JS, in a new tab, or from a shared link.
- **Browser Back** (popstate) reopens the section but, by app-wide rule, does not move focus (`shouldRestoreNavigationOrigin`). The in-page "← Back to …" link restores focus as well.

### 5. Docs
- **Help** (`src/routes/help/+page.svelte`, the species page and Parts of a Bird paragraphs): explain the links, where they appear, and that Back returns.
- **About:** a Version History line.

## Verification (full tier: wrong matches put wrong links in text)
- **Test data (owner, 2026-10-16):** `birds_test` is a near-prod snapshot, rich enough for complete test scenarios. Browser and route tests use its real species (e.g. a duck with a speculum note, a gull with mirrors, a songbird whose Description has tertials and wing bars), chosen by query, not hard-coded guesses. Design numbers above still come from prod.
- **Prod-text audit:** a scratchpad script runs `terms.ts` over the extracted prod COPY files (notes and Description sections).
  - Report links per block and per term.
  - Hand-check 100 random links for false matches, and record the result in `td log`.
- **Unit tests:** above. Route test: the loader returns `family_sci_name`.
- **Playwright, Chromium and WebKit, 320/390/1200, 5 themes:**
  - links appear only in notes and Description;
  - a click opens Parts with the part selected;
  - Back returns to the species page and focus goes back to the link;
  - the Parts `PathNavigation` names the species;
  - no-JS: plain anchor, and the native `<details>` reveal works;
  - no overflow and no console errors.
- **Mobile Safari:** a short tap pass on the iOS Simulator with `axe`.
- **Gates:** `npm run check` 0/0, `npm run build`, `git diff --check`, full `npm test` (baseline: 1 known `searchable-select` failure), and fixture hygiene. These changes are read-only, so no DB fixtures are expected.
- **Reviews:** CODEX1 hostile review at high effort, and a UI test by GROK or AGY. Neither reviewer edits files or touches td.
- **Release:** `td review`, then the owner approves. No commit, push or deploy without the owner's explicit go. After deploy, the public-bundle check.
- **Hand-off:** a plain step-by-step explainer of the matching rules, for the owner.
