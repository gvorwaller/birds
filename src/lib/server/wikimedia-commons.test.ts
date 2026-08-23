import { describe, expect, it } from "vitest";
import {
  CommonsError,
  commonsSourceUrl,
  fetchCommonsFileInfo,
  isDisplayableImage,
  isPlayableAudio,
  parseArtistHtml,
} from "./wikimedia-commons";

describe("wikimedia-commons pure helpers", () => {
  it("parseArtistHtml strips tags, decodes entities, trims; null passes through", () => {
    expect(parseArtistHtml('<a href="https://example.com">John Doe</a>')).toBe("John Doe");
    expect(parseArtistHtml("Jane &amp; Bob")).toBe("Jane & Bob");
    expect(parseArtistHtml("  spaced   out  ")).toBe("spaced out");
    expect(parseArtistHtml(null)).toBeNull();
    expect(parseArtistHtml("")).toBeNull();
    expect(parseArtistHtml("<span></span>")).toBeNull(); // tags-only → empty → null
  });

  it("isPlayableAudio / isDisplayableImage check the accepted MIME allowlists", () => {
    for (const m of [
      "audio/ogg",
      "application/ogg",
      "audio/mpeg",
      "audio/wav",
      "audio/flac",
      "audio/webm",
    ])
      expect(isPlayableAudio(m), m).toBe(true);
    for (const m of ["image/jpeg", "video/mp4", null])
      expect(isPlayableAudio(m as string | null), String(m)).toBe(false);

    for (const m of ["image/jpeg", "image/png", "image/gif", "image/webp", "image/svg+xml"])
      expect(isDisplayableImage(m), m).toBe(true);
    for (const m of ["audio/ogg", "application/pdf", null])
      expect(isDisplayableImage(m as string | null), String(m)).toBe(false);

    // Case-insensitive.
    expect(isPlayableAudio("AUDIO/OGG")).toBe(true);
    expect(isDisplayableImage("IMAGE/JPEG")).toBe(true);
  });

  it("commonsSourceUrl builds a File: description-page link, spaces underscored", () => {
    expect(commonsSourceUrl("Marbled Godwit RWD.jpg")).toBe(
      "https://commons.wikimedia.org/wiki/File:Marbled_Godwit_RWD.jpg",
    );
  });
});

describe("fetchCommonsFileInfo", () => {
  function fakeFetch(pages: object[], status = 200) {
    return (async () =>
      new Response(JSON.stringify({ query: { pages } }), {
        status,
      })) as typeof fetch;
  }

  it("parses url/size/mime/license/artist from a formatversion=2 response", async () => {
    const fetcher = fakeFetch([
      {
        title: "File:Marbled Godwit RWD.jpg",
        imageinfo: [
          {
            url: "https://upload.wikimedia.org/full.jpg",
            thumburl: "https://upload.wikimedia.org/640px-full.jpg",
            width: 4000,
            height: 3000,
            mime: "image/jpeg",
            extmetadata: {
              Artist: {
                value: '<a href="https://example.com/u/Dick_Daniels">Dick Daniels</a>',
              },
              LicenseShortName: { value: "CC BY-SA 3.0" },
              LicenseUrl: {
                value: "https://creativecommons.org/licenses/by-sa/3.0",
              },
            },
          },
        ],
      },
    ]);
    const out = await fetchCommonsFileInfo(["Marbled Godwit RWD.jpg"], {
      fetcher,
    });
    const info = out.get("Marbled Godwit RWD.jpg");
    expect(info).toBeDefined();
    expect(info?.url).toBe("https://upload.wikimedia.org/full.jpg");
    expect(info?.thumbUrl).toBe("https://upload.wikimedia.org/640px-full.jpg");
    expect(info?.width).toBe(4000);
    expect(info?.mimeType).toBe("image/jpeg");
    expect(info?.artist).toBe("Dick Daniels");
    expect(info?.licenseCode).toBe("CC BY-SA 3.0");
    expect(info?.licenseUrl).toBe("https://creativecommons.org/licenses/by-sa/3.0");
  });

  it("requests valid imageinfo properties and parses timed-media duration from metadata", async () => {
    let seenUrl = "";
    const fetcher = (async (input: URL | RequestInfo) => {
      seenUrl = String(input);
      return new Response(
        JSON.stringify({
          query: {
            pages: [
              {
                title: "File:Loon call.ogg",
                imageinfo: [
                  {
                    url: "https://upload.wikimedia.org/loon.ogg",
                    mime: "application/ogg",
                    metadata: [{ name: "playtime_seconds", value: 4.8065 }],
                    extmetadata: {
                      LicenseShortName: { value: "Public domain" },
                    },
                  },
                ],
              },
            ],
          },
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    const out = await fetchCommonsFileInfo(["Loon call.ogg"], { fetcher });
    const props = new URL(seenUrl).searchParams.get("iiprop") ?? "";
    expect(props.split("|")).toContain("metadata");
    expect(props.split("|")).not.toContain("duration");
    expect(out.get("Loon call.ogg")?.duration).toBeCloseTo(4.8065);
    expect(isPlayableAudio(out.get("Loon call.ogg")?.mimeType ?? null)).toBe(true);
  });

  it("API-normalized titles (underscores, first-letter case) are keyed by the REQUESTED filename", async () => {
    // Commons normalizes 'File:grey_heron.jpg' → 'File:Grey heron.jpg' and
    // reports the page under the normalized title. The caller looks up by
    // the raw P18/P51 filename, so the map must be keyed by what was asked.
    const fetcher = (async () =>
      new Response(
        JSON.stringify({
          query: {
            normalized: [
              { from: "File:grey_heron.jpg", to: "File:Grey heron.jpg" },
            ],
            pages: [
              {
                title: "File:Grey heron.jpg",
                imageinfo: [
                  {
                    url: "https://upload.wikimedia.org/grey-heron.jpg",
                    mime: "image/jpeg",
                    extmetadata: { LicenseShortName: { value: "CC BY 4.0" } },
                  },
                ],
              },
            ],
          },
        }),
        { status: 200 },
      )) as typeof fetch;
    const out = await fetchCommonsFileInfo(["grey_heron.jpg"], { fetcher });
    expect(out.get("grey_heron.jpg")?.url).toBe(
      "https://upload.wikimedia.org/grey-heron.jpg",
    );
    expect(out.has("Grey heron.jpg")).toBe(false);
  });

  it("missing pages are simply absent from the result — not an error", async () => {
    const fetcher = fakeFetch([{ title: "File:Deleted.jpg", missing: true }]);
    const out = await fetchCommonsFileInfo(["Deleted.jpg"], { fetcher });
    expect(out.size).toBe(0);
  });

  it("anonymous upload: Artist absent → artist is null, not a crash", async () => {
    const fetcher = fakeFetch([
      {
        title: "File:Anon.jpg",
        imageinfo: [
          {
            url: "https://upload.wikimedia.org/anon.jpg",
            mime: "image/jpeg",
            extmetadata: { LicenseShortName: { value: "CC0 1.0" } },
          },
        ],
      },
    ]);
    const out = await fetchCommonsFileInfo(["Anon.jpg"], { fetcher });
    expect(out.get("Anon.jpg")?.artist).toBeNull();
    expect(out.get("Anon.jpg")?.licenseCode).toBe("CC0 1.0");
  });

  it("empty filename list never calls fetch", async () => {
    let called = 0;
    const fetcher = (async () => {
      called++;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const out = await fetchCommonsFileInfo([], { fetcher });
    expect(out.size).toBe(0);
    expect(called).toBe(0);
  });

  it("batch too large throws synchronously", async () => {
    const filenames = Array.from({ length: 51 }, (_, i) => `f${i}.jpg`);
    await expect(fetchCommonsFileInfo(filenames)).rejects.toThrow(/batch too large/);
  });

  it("HTTP 429 → CommonsError with rateLimited + parsed Retry-After", async () => {
    const fetcher = (async () =>
      new Response("busy", {
        status: 429,
        headers: { "retry-after": "120" },
      })) as typeof fetch;
    await expect(fetchCommonsFileInfo(["X.jpg"], { fetcher })).rejects.toMatchObject({
      name: "CommonsError",
      status: 429,
      rateLimited: true,
      retryAfterMs: 120_000,
    });
  });

  it("MediaWiki maxlag API errors retain rate-limit classification", async () => {
    const fetcher = (async () =>
      new Response(JSON.stringify({ error: { code: "maxlag", info: "Waiting for replicas" } }), {
        status: 200,
        headers: { "retry-after": "5" },
      })) as typeof fetch;
    await expect(fetchCommonsFileInfo(["X.jpg"], { fetcher })).rejects.toMatchObject({
      name: "CommonsError",
      rateLimited: true,
      retryAfterMs: 5_000,
    });
  });

  it("network failure wraps into CommonsError, not a raw TypeError", async () => {
    const fetcher = (async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    }) as typeof fetch;
    await expect(fetchCommonsFileInfo(["X.jpg"], { fetcher })).rejects.toBeInstanceOf(CommonsError);
  });
});
