import { fetchAdwFamily } from "./animal-diversity";
import { fetchWikidataTaxonCandidates, isRateLimitedError } from "./wikidata";
import { fetchFamilyArticle } from "./family-wikipedia";
import { revisionPermalink } from "./wikipedia";
import type {
  FamilySource,
  FamilySourceDocument,
} from "./family-enrichment-ai";
import type { TaxonomyFamily } from "./taxonomy-reference";

export const FAMILY_RESOLVER_VERSION = "3"; // Deliberately independent of input freshness hashes.
export class FamilySourceInterrupted extends Error {}
export interface DiscoveryDiagnostic {
  candidate: string;
  outcome:
    | "accepted"
    | "missing_page"
    | "ambiguous_identity"
    | "identity_mismatch"
    | "insufficient_natural_history"
    | "transport_failure";
  detail: string;
}
export const sourceDependencies = {
  adw: fetchAdwFamily,
  candidates: fetchWikidataTaxonCandidates,
  article: fetchFamilyArticle,
};
export function hasNaturalHistory(text: string) {
  // Length alone accepts species lists and fossil-only family stubs. Require
  // actual natural-history sentences; short but useful accounts are valid.
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .filter(
      (sentence) =>
        !/classified|phylogen|taxonom|fossil|extinct|comprising|only member/i.test(
          sentence,
        ) &&
        /\b(habitat|plumage|feed\w*|diet|nest\w*|breed\w*|forag\w*|insect\w*|forest\w*|wing\w*|beak\w*|flightless|omnivor\w*|nocturnal|tropical|endemic|woodland|bill|wetland\w*|found|seen|migratory|flock\w*)\b/i.test(
          sentence,
        ),
    );
  return sentences.length >= 2 && sentences.join(" ").length >= 120;
}
export async function discoverFamilySources(
  family: TaxonomyFamily,
  members: string[],
  deps = sourceDependencies,
  diagnostics: DiscoveryDiagnostic[] = [],
  shouldStop?: () => Promise<boolean>,
  options: {
    allowScopedExamples?: boolean;
    preferMemberAccounts?: boolean;
    preferSpeciesAccounts?: boolean;
    maxExampleDocuments?: number;
  } = {},
): Promise<FamilySource | null> {
  if (
    options.maxExampleDocuments !== undefined &&
    (!options.allowScopedExamples ||
      !Number.isInteger(options.maxExampleDocuments) ||
      options.maxExampleDocuments < 1)
  )
    throw Error(
      "An explicit example-document limit requires scoped examples and a positive integer",
    );
  if (!family.scientificName) return null;
  const record = (
    candidate: string,
    outcome: DiscoveryDiagnostic["outcome"],
    detail: string,
  ) => diagnostics.push({ candidate, outcome, detail });
  let transient: unknown;
  const checkpoint = async () => {
    if (await shouldStop?.())
      throw new FamilySourceInterrupted("Source discovery paused");
  };
  try {
    await checkpoint();
    const adw = await deps.adw(family.scientificName);
    if (adw) {
      record(
        family.scientificName,
        "accepted",
        "Animal Diversity Web family account",
      );
      return { ...adw, resolverVersion: FAMILY_RESOLVER_VERSION, members };
    }
    record(
      family.scientificName,
      "missing_page",
      "No usable Animal Diversity Web family account",
    );
  } catch (error) {
    if (error instanceof FamilySourceInterrupted) throw error;
    record(
      family.scientificName,
      "transport_failure",
      "Animal Diversity Web request failed",
    );
    if (isRateLimitedError(error)) throw error;
    transient = error;
  }
  async function lookup(
    name: string,
    rank: "family" | "genus" | "species",
    scopedMembers: string[],
  ) {
    try {
      await checkpoint();
      const candidates = await deps.candidates(name, rank);
      if (!candidates.length) {
        record(
          name,
          "identity_mismatch",
          `No exact ${rank} identity in Wikidata`,
        );
        return null;
      }
      // Try the scientific title even if multiple Wikidata entities share it.
      const titles = [
        ...new Set([
          name,
          ...candidates.map((c) => c.title).filter((s): s is string => !!s),
        ]),
      ];
      const valid: FamilySourceDocument[] = [];
      for (const title of titles) {
        await checkpoint();
        const page = await deps.article(title);
        if (!page) {
          record(title, "missing_page", "Wikipedia page missing");
          continue;
        }
        if (
          page.disambiguation ||
          !candidates.some((c) => c.qid === page.qid)
        ) {
          record(
            title,
            "identity_mismatch",
            "Page identity does not match the exact scientific name and rank",
          );
          continue;
        }
        if (!hasNaturalHistory(page.text)) {
          record(
            title,
            "insufficient_natural_history",
            "Not enough study-useful natural history",
          );
          continue;
        }
        if (valid.some((d) => d.qid === page.qid && d.title === page.title))
          continue;
        valid.push({
          provider: "wikipedia",
          title: page.title,
          url: revisionPermalink(page.title, page.revId),
          revision: page.revId,
          qid: page.qid,
          attribution: "Wikipedia contributors",
          license: "CC BY-SA 4.0",
          licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
          fetchedAt: new Date().toISOString(),
          text: page.text,
          scope: { rank, scientificName: name, members: scopedMembers },
        });
        // With one exact identity, a verified scientific-title redirect settles
        // the lookup; do not fetch the same page again through its common title.
        if (new Set(candidates.map((candidate) => candidate.qid)).size === 1)
          break;
      }
      if (valid.length > 1) {
        record(
          name,
          "ambiguous_identity",
          "Multiple distinct usable articles match; no arbitrary selection",
        );
        return null;
      }
      if (!valid.length) return null;
      record(name, "accepted", `${rank} account: ${valid[0].title}`);
      return valid[0];
    } catch (error) {
      if (error instanceof FamilySourceInterrupted) throw error;
      record(name, "transport_failure", "Wikipedia or Wikidata request failed");
      if (isRateLimitedError(error)) throw error;
      transient = error;
      return null;
    }
  }
  const familyDoc = options.preferMemberAccounts
    ? null
    : await lookup(family.scientificName, "family", members);
  let documents: FamilySourceDocument[] = familyDoc ? [familyDoc] : [];
  if (!documents.length && members.length) {
    // Each current genus must be represented. A single source about one genus
    // cannot silently stand in for a larger family (e.g. cassowaries AND emu).
    const genera = [...new Set(members.map((m) => m.split(" ")[0]))].sort();
    for (const genus of genera) {
      if (
        options.maxExampleDocuments !== undefined &&
        documents.length >= options.maxExampleDocuments
      )
        break;
      const subset = members.filter((m) => m.split(" ")[0] === genus);
      const document =
        subset.length === 1
          ? ((await lookup(subset[0], "species", subset)) ??
            (options.preferSpeciesAccounts
              ? null
              : await lookup(genus, "genus", subset)))
          : options.preferSpeciesAccounts
            ? null
            : await lookup(genus, "genus", subset);
      if (document) {
        documents.push(document);
        continue;
      }
      // Sparse genus pages can be replaced by accounts covering EVERY current
      // member. Keep each account scoped; never synthesize a shared trait.
      const speciesDocuments: FamilySourceDocument[] = [];
      if (subset.length > 1)
        for (const species of subset) {
          if (
            options.maxExampleDocuments !== undefined &&
            documents.length + speciesDocuments.length >=
              options.maxExampleDocuments
          )
            break;
          const speciesDoc = await lookup(species, "species", [species]);
          if (!speciesDoc) {
            if (options.allowScopedExamples) continue;
            break;
          }
          speciesDocuments.push(speciesDoc);
        }
      if (speciesDocuments.length !== subset.length) {
        if (options.allowScopedExamples) {
          documents.push(...speciesDocuments);
          continue;
        }
        documents = [];
        break;
      }
      documents.push(...speciesDocuments);
    }
  }
  if (!documents.length) {
    if (transient) throw transient;
    return null;
  }
  const coveredMembers = [
    ...new Set(documents.flatMap((document) => document.scope.members)),
  ];
  const uncoveredMembers = members.filter(
    (member) => !coveredMembers.includes(member),
  );
  if (options.maxExampleDocuments !== undefined && uncoveredMembers.length)
    record(
      family.scientificName,
      "accepted",
      `Selected examples from ${documents.length} source accounts (explicit limit ${options.maxExampleDocuments}); ${uncoveredMembers.length} current species are outside source coverage. The summary must label its examples.`,
    );
  return {
    ...documents[0],
    documents,
    members,
    resolverVersion: FAMILY_RESOLVER_VERSION,
    ...(uncoveredMembers.length
      ? { coverage: { coveredMembers, uncoveredMembers } }
      : {}),
  };
}
