import { it, expect, vi, afterEach } from "vitest";
import { parseAdwFamily, fetchAdwFamily } from "./animal-diversity";

const prose =
  "Fixture birds inhabit woods and wetlands. Some eat seeds; others feed on insects. These example paragraphs exist solely to exercise source extraction and do not describe a real taxon.";
const html = `<h1 class="rank--Family">Testidae</h1>
<article data-class-scientific-name="Aves"><div class="byline">By Test Author</div>
<aside>Navigation and unrelated material</aside>
<section><h2 id="habitat">Habitat</h2><p>${prose}</p><div popover>Glossary text</div></section>
<section><h2 id="physical_description">Description</h2><p>${prose} <i>Italic</i> &amp; entities.</p></section>
<section><h2 id="conservation_status">Status</h2><p>Outdated conservation claim</p></section>
</article>`;
afterEach(() => vi.useRealTimers());
it("extracts exact family prose and author credit, excluding boilerplate and status", () => {
  const source = parseAdwFamily(html, "Testidae")!;
  expect(source.provider).toBe("adw");
  expect(source.attribution).toContain("Test Author");
  expect(source.license).toBe("CC BY-NC-SA 3.0");
  expect(source.text).toContain("Italic & entities.");
  expect(source.text).not.toMatch(/Navigation|Glossary|Outdated/);
  expect(parseAdwFamily(html, "Otheridae")).toBeNull();
  expect(
    parseAdwFamily(html.replace("rank--Family", "rank--Species"), "Testidae"),
  ).toBeNull();
  expect(
    parseAdwFamily(
      '<h1 class="rank--Family">Testidae</h1><p>Classification only</p>',
      "Testidae",
    ),
  ).toBeNull();
});
it("enforces the eight-second request interval and reports upstream throttling", async () => {
  vi.useFakeTimers();
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(new Response(html))
    .mockResolvedValueOnce(
      new Response("", { status: 429, headers: { "retry-after": "60" } }),
    );
  const first = fetchAdwFamily("Testidae", fetcher);
  const second = fetchAdwFamily("Testidae", fetcher);
  const result = expect(second).rejects.toMatchObject({ status: 429, rateLimited: true, retryAfterMs: 60_000 });
  await vi.advanceTimersByTimeAsync(7_999);
  expect((await first)?.provider).toBe("adw");
  expect(fetcher).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  await result;
  expect(fetcher).toHaveBeenCalledTimes(2);
});
