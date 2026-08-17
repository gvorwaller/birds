import { describe, expect, it } from "vitest";
import { sectionBlocks } from "./wiki-render";

describe("sectionBlocks — raw === markers never reach the page (GROK P1)", () => {
  it("turns subsection markers into sub blocks and groups paragraphs", () => {
    const text = [
      "=== Feeding ===",
      "Probes mudflats with its long bill.",
      "Often in flocks.",
      "",
      "=== Breeding ===",
      "Nests in prairie grass.",
    ].join("\n");
    expect(sectionBlocks(text)).toEqual([
      { kind: "sub", text: "Feeding" },
      { kind: "p", text: "Probes mudflats with its long bill.\nOften in flocks." },
      { kind: "p", text: "Nests in prairie grass." },
    ].toSpliced(2, 0, { kind: "sub", text: "Breeding" }));
  });

  it("plain text without markers becomes paragraphs split on blank lines", () => {
    expect(sectionBlocks("One.\n\nTwo.")).toEqual([
      { kind: "p", text: "One." },
      { kind: "p", text: "Two." },
    ]);
    expect(sectionBlocks("")).toEqual([]);
  });

  it("no literal equals-markers survive in any block", () => {
    const blocks = sectionBlocks("==== Deep ====\ntext\n== Odd ==\nmore");
    for (const b of blocks) expect(b.text).not.toMatch(/^=+/);
  });
});
