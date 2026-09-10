import { describe, expect, it } from "vitest";
import {
  familyGroups,
  studyHref,
  studyOptions,
  type StudySpecies,
} from "./species-study";

describe("study navigation and grouping", () => {
  it("defaults not-yet-viewed to families and alphabetical, never a meaningless recent sort", () => {
    expect(
      studyOptions(new URLSearchParams("status=unviewed&sort=recent")),
    ).toEqual({ status: "unviewed", group: "family", sort: "name", q: "" });
    expect(
      studyOptions(new URLSearchParams("status=bogus&group=bogus")),
    ).toEqual({ status: "viewed", group: "none", sort: "recent", q: "" });
  });
  it("round trips search/status/group/sort without copying unrelated route data into links", () => {
    const options = studyOptions(
      new URLSearchParams("status=unviewed&group=country&q=Rock%20%26%20Roll"),
    );
    const href = studyHref({
      ...options,
      ...{ accountId: 1, rows: ["private"] },
    });
    expect(
      studyOptions(new URL(href, "https://birds.test").searchParams),
    ).toEqual(options);
    expect(href).not.toContain("private");
    expect(href).not.toContain("accountId");
  });
  it("groups every species once, keeps selected row ordering, and exposes missing classification", () => {
    const row = (code: string, family: string | null): StudySpecies => ({
      code,
      family,
      name: code,
      scientificName: null,
      current: true,
      view: null,
    });
    const groups = familyGroups([
      row("b", "Woodpeckers"),
      row("a", "Woodpeckers"),
      row("c", null),
      row("d", "Ducks"),
    ]);
    expect(groups.map((g) => g.name)).toEqual([
      "Ducks",
      "Family unavailable",
      "Woodpeckers",
    ]);
    expect(groups.flatMap((g) => g.rows.map((r) => r.code))).toEqual([
      "d",
      "c",
      "b",
      "a",
    ]);
  });
});
