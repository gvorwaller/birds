/**
 * td-6093ae: the pure parts of the taxonomy refresh — change classification,
 * the taxonomy hash, batch cutting and eBird's latest-version parsing.
 */
import { describe, expect, it } from "vitest";
import {
  classifyChanges,
  cutBatches,
  normalizeTaxon,
  taxonFromEntry,
  taxonomyHash,
  type TaxonRow,
} from "./taxonomy-refresh";
import { latestVersionOf } from "./ebird";

const taxon = (code: string, over: Partial<TaxonRow> = {}): TaxonRow => ({
  species_code: code,
  com_name: `Bird ${code}`,
  sci_name: `Avis ${code}`,
  category: "species",
  family: "Birds",
  taxon_order: "100",
  order_name: "Passeriformes",
  family_code: "birds1",
  family_sci_name: "Avidae",
  banding_codes: ["BIRD"],
  report_as: null,
  extinct: null,
  ...over,
});

const kindsOf = (before: TaxonRow[], after: TaxonRow[]) =>
  Object.fromEntries(classifyChanges(before, after).changes.map((c) => [c.code, c.kinds]));

describe("classifyChanges", () => {
  it("reports nothing for identical taxonomies, whatever the row order", () => {
    const a = [taxon("aaa1"), taxon("bbb1")];
    expect(classifyChanges(a, [...a].reverse()).changes).toEqual([]);
  });

  it("names every kind of difference", () => {
    const before = [
      taxon("gone1"),
      taxon("cat1"),
      taxon("sci1"),
      taxon("com1"),
      taxon("rep1", { category: "issf", report_as: "par1" }),
      taxon("oth1"),
    ];
    const after = [
      taxon("cat1", { category: "slash" }),
      taxon("sci1", { sci_name: "Avis nova" }),
      taxon("com1", { com_name: "Western Bird" }),
      taxon("rep1", { category: "issf", report_as: "par2" }),
      taxon("oth1", { family_code: "birds2", taxon_order: "101" }),
      taxon("new1"),
    ];
    expect(kindsOf(before, after)).toEqual({
      gone1: ["removed"],
      cat1: ["category"],
      sci1: ["scientific"],
      com1: ["common"],
      rep1: ["report_as"],
      oth1: ["other"],
      new1: ["added"],
    });
  });

  it("counts every stored field as a change, null-safely", () => {
    for (const field of ["family", "order_name", "family_sci_name", "extinct"] as const) {
      const after = taxon("x1", { [field]: field === "extinct" ? true : "Changed" });
      expect(kindsOf([taxon("x1")], [after]).x1, field).toEqual(["other"]);
    }
    expect(kindsOf([taxon("x1", { family: null })], [taxon("x1", { family: "Birds" })]).x1).toEqual(["other"]);
  });

  it("treats banding codes as a set and taxon order as a number", () => {
    const before = [taxon("x1", { banding_codes: ["AAAA", "BBBB"], taxon_order: "12.50" })];
    const after = [taxon("x1", { banding_codes: ["bbbb", "AAAA", "BBBB"], taxon_order: "12.5" })];
    expect(classifyChanges(before, after).changes).toEqual([]);
    expect(kindsOf(before, [taxon("x1", { banding_codes: ["AAAA"], taxon_order: "12.5" })]).x1).toEqual(["other"]);
  });

  it("marks a species for reload when it was removed, demoted or renamed, a common name included", () => {
    const before = [taxon("gone1"), taxon("cat1"), taxon("sci1"), taxon("com1"), taxon("oth1")];
    const after = [
      taxon("cat1", { category: "slash" }),
      taxon("sci1", { sci_name: "Avis nova" }),
      // A split that keeps the old code for one daughter: only the name changes.
      taxon("com1", { com_name: "Western Bird" }),
      taxon("oth1", { order_name: "Other" }),
      taxon("new1"),
    ];
    const { changes, affecting } = classifyChanges(before, after);
    expect([...affecting].sort()).toEqual(["cat1", "com1", "gone1", "sci1"]);
    expect(changes.find((c) => c.code === "oth1")?.affects).toBe(false);
    expect(changes.find((c) => c.code === "new1")?.affects).toBe(false);
  });

  it("never marks a code that was not a species (nothing is stored under it)", () => {
    const { affecting } = classifyChanges([taxon("sp1", { category: "spuh" })], [taxon("sp1", { category: "species" })]);
    expect([...affecting]).toEqual([]);
  });

  it("marks both reporting parents of a report_as change", () => {
    const before = [taxon("par1"), taxon("par2"), taxon("ssp1", { category: "issf", report_as: "par1" })];
    const after = [taxon("par1"), taxon("par2"), taxon("ssp1", { category: "issf", report_as: "par2" })];
    const { changes, affecting } = classifyChanges(before, after);
    expect([...affecting].sort()).toEqual(["par1", "par2"]);
    // The parents themselves did not change, so they have no change row.
    expect(changes.map((c) => c.code)).toEqual(["ssp1"]);
  });
});

describe("taxonomyHash", () => {
  it("matches a taxonomy parsed from eBird and the same one read back from Postgres", () => {
    const parsed = taxonFromEntry({
      speciesCode: "x1",
      comName: "Bird",
      sciName: "Avis",
      category: "species",
      familyComName: "Birds",
      taxonOrder: 12.5,
      order: "Passeriformes",
      familyCode: "birds1",
      familySciName: "Avidae",
      bandingCodes: ["BBBB", "AAAA"],
      reportAs: null,
      extinct: null,
    });
    const stored = taxon("x1", {
      com_name: "Bird",
      sci_name: "Avis",
      taxon_order: "12.5",
      banding_codes: ["AAAA", "BBBB"],
    });
    expect(taxonomyHash([parsed])).toBe(taxonomyHash([stored]));
    expect(taxonomyHash([parsed])).not.toBe(taxonomyHash([{ ...stored, com_name: "Other" }]));
  });

  it("does not depend on row order", () => {
    expect(taxonomyHash([taxon("a1"), taxon("b1")])).toBe(taxonomyHash([taxon("b1"), taxon("a1")]));
  });

  it("normalizes missing fields to null", () => {
    expect(normalizeTaxon({ ...taxon("a1"), taxon_order: "" }).taxon_order).toBeNull();
  });
});

describe("cutBatches", () => {
  it("cuts fixed batches in order", () => {
    const items = Array.from({ length: 450 }, (_, i) => i);
    const batches = cutBatches(items);
    expect(batches.map((b) => b.length)).toEqual([200, 200, 50]);
    expect(batches.flat()).toEqual(items);
  });
});

describe("latestVersionOf", () => {
  it("reads the one latest version as eBird sends it", () => {
    expect(
      latestVersionOf([
        { authorityVer: 2026.0, latest: true },
        { authorityVer: 2025.0, latest: false },
      ]),
    ).toBe("2026");
    expect(latestVersionOf([{ authorityVer: 2021.01, latest: true }])).toBe("2021.01");
  });

  it("is unknown for anything else, never a guess", () => {
    expect(latestVersionOf(null)).toBeNull();
    expect(latestVersionOf([])).toBeNull();
    expect(latestVersionOf([{ authorityVer: 2026, latest: false }])).toBeNull();
    expect(
      latestVersionOf([
        { authorityVer: 2026, latest: true },
        { authorityVer: 2025, latest: true },
      ]),
    ).toBeNull();
    expect(latestVersionOf([{ authorityVer: "2026", latest: true }])).toBeNull();
  });
});
