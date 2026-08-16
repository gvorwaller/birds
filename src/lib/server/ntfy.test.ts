import { describe, expect, it, vi } from "vitest";
import { NtfyError, sendNtfy, validNtfyTopic, NTFY_TIMEOUT_MS } from "./ntfy";

const SECRET_TOPIC = "gv-birds-x7Qp29rTmZ";

function okFetcher() {
  return vi.fn(async () => new Response("ok", { status: 200 }));
}

describe("validNtfyTopic", () => {
  it("accepts long random names; rejects URLs, whitespace, short guessables", () => {
    expect(validNtfyTopic(SECRET_TOPIC)).toBe(true);
    expect(validNtfyTopic("a".repeat(64))).toBe(true);
    expect(validNtfyTopic("short")).toBe(false);
    expect(validNtfyTopic("https://ntfy.sh/mytopic")).toBe(false);
    expect(validNtfyTopic("has space99")).toBe(false);
    expect(validNtfyTopic("")).toBe(false);
    expect(validNtfyTopic("a".repeat(65))).toBe(false);
  });
});

describe("sendNtfy", () => {
  it("publishes via the JSON body — topic in the payload, never the URL", async () => {
    const fetcher = okFetcher();
    await sendNtfy(
      SECRET_TOPIC,
      {
        title: "Lifer nearby: Snail Kite",
        body: "Sweetwater · 12 mi from home",
        clickUrl: "https://birds.gaylon.photos/forecast/species?species=snakit",
        tags: ["bird"],
      },
      fetcher as unknown as typeof fetch,
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://ntfy.sh");
    expect(init.method).toBe("POST");
    const payload = JSON.parse(init.body as string);
    expect(payload).toEqual({
      topic: SECRET_TOPIC,
      title: "Lifer nearby: Snail Kite",
      message: "Sweetwater · 12 mi from home",
      click: "https://birds.gaylon.photos/forecast/species?species=snakit",
      tags: ["bird"],
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(NTFY_TIMEOUT_MS).toBeLessThanOrEqual(15_000);
  });

  it("non-Latin-1 bird names survive the REAL Request boundary (CODEX1 — ʻAkikiki)", async () => {
    // The old header API threw TypeError constructing the Request because a
    // Title header is a ByteString. Prove the JSON path clears the real
    // undici boundary, not just a mock.
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      new Request(url, init); // throws on invalid header values
      return new Response("ok", { status: 200 });
    });
    await expect(
      sendNtfy(
        SECRET_TOPIC,
        { title: "Lifer nearby: ʻAkikiki", body: "Kōkeʻe · 3 mi from home" },
        fetcher as unknown as typeof fetch,
      ),
    ).resolves.toBeUndefined();
    const payload = JSON.parse((fetcher.mock.calls[0][1] as RequestInit).body as string);
    expect(payload.title).toBe("Lifer nearby: ʻAkikiki");
  });

  it("refuses invalid topics WITHOUT sending", async () => {
    const fetcher = okFetcher();
    await expect(
      sendNtfy("https://evil", { title: "t", body: "b" }, fetcher as unknown as typeof fetch),
    ).rejects.toBeInstanceOf(NtfyError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("typed errors NEVER contain the topic or URL (CODEX1 #4)", async () => {
    const rejecting = vi.fn(async () => {
      throw new Error(`connect ETIMEDOUT for https://ntfy.sh/${SECRET_TOPIC}`);
    });
    const err1 = (await sendNtfy(
      SECRET_TOPIC,
      { title: "t", body: "b" },
      rejecting as unknown as typeof fetch,
    ).catch((e) => e)) as NtfyError;
    expect(err1).toBeInstanceOf(NtfyError);
    expect(err1.message).not.toContain(SECRET_TOPIC);
    expect(err1.message).not.toContain("ntfy.sh/");

    const failing = vi.fn(async () => new Response("nope", { status: 429 }));
    const err2 = (await sendNtfy(
      SECRET_TOPIC,
      { title: "t", body: "b" },
      failing as unknown as typeof fetch,
    ).catch((e) => e)) as NtfyError;
    expect(err2).toBeInstanceOf(NtfyError);
    expect(err2.status).toBe(429);
    expect(err2.message).not.toContain(SECRET_TOPIC);
  });
});
