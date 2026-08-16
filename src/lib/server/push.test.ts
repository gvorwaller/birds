import { beforeEach, describe, expect, it, vi } from "vitest";

// Real VAPID-shaped env before importing the module ($env/dynamic/private
// reads process.env in vitest).
process.env.VAPID_PUBLIC_KEY ??= "test-public";
process.env.VAPID_PRIVATE_KEY ??= "test-private";

const webpushMock = vi.hoisted(() => ({
  setVapidDetails: vi.fn(),
  sendNotification: vi.fn(),
}));
vi.mock("web-push", () => ({ default: webpushMock }));

const { sendWebPush, validPushEndpoint, validPushKeys, PushError, PUSH_TIMEOUT_MS } =
  await import("./push");

const SUB = {
  endpoint: "https://push.apple.example/device-SECRET-xyz",
  p256dh: "key",
  auth: "auth",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("validPushEndpoint — the SSRF boundary (CODEX1)", () => {
  const P256 = "B" + "a".repeat(86); // 87 chars, base64url
  const AUTH = "b".repeat(22);

  it("accepts the real push-service origins browsers hand out", () => {
    for (const url of [
      "https://web.push.apple.com/QOZzz0HzALxSAB3ilJDANQ",
      "https://fcm.googleapis.com/fcm/send/abc123:APA91b",
      "https://updates.push.services.mozilla.com/wpush/v2/gAAAA",
      "https://sg2p.notify.windows.com/w/?token=abc",
    ]) {
      expect(validPushEndpoint(url), url).toBe(true);
    }
  });

  it("rejects attacker-chosen destinations: private nets, loopback, ports, creds, fragments, http", () => {
    for (const url of [
      "https://localhost/push",
      "https://127.0.0.1/push",
      "https://10.0.0.7/push",
      "https://192.168.1.1/push",
      "https://169.254.169.254/latest/meta-data", // cloud metadata
      "https://birds.gaylon.photos/api/health", // own host
      "https://evil.example.com/collect",
      "https://web.push.apple.com.evil.example/x", // suffix spoof
      "https://web.push.apple.com:8443/x", // non-default port
      "https://user:pass@web.push.apple.com/x", // credentials
      "https://web.push.apple.com/x#frag",
      "http://web.push.apple.com/x", // not https
      "not a url",
      "https://web.push.apple.com/" + "x".repeat(1100), // oversize
    ]) {
      expect(validPushEndpoint(url), url).toBe(false);
    }
  });

  it("sanitizeDeviceLabel strips control chars, collapses whitespace, clamps, nulls junk", async () => {
    const { sanitizeDeviceLabel } = await import("./push");
    expect(sanitizeDeviceLabel("iPhone · Safari")).toBe("iPhone · Safari");
    expect(sanitizeDeviceLabel("  Mac \n\t Safari  ")).toBe("Mac Safari");
    expect(sanitizeDeviceLabel("a\u0000b\u001fc\u007fd")).toBe("abcd");
    expect(sanitizeDeviceLabel("x".repeat(200))).toHaveLength(60);
    expect(sanitizeDeviceLabel("")).toBeNull();
    expect(sanitizeDeviceLabel("\u0000\u0001")).toBeNull();
    expect(sanitizeDeviceLabel(null)).toBeNull();
    expect(sanitizeDeviceLabel(42)).toBeNull();
  });

  it("platformFromEndpoint maps allowlisted origins; junk stays Unknown", async () => {
    const { platformFromEndpoint } = await import("./push");
    expect(platformFromEndpoint("https://web.push.apple.com/x")).toBe("Apple device (Safari)");
    expect(platformFromEndpoint("https://fcm.googleapis.com/fcm/send/a")).toBe(
      "Chrome-based browser",
    );
    expect(platformFromEndpoint("https://updates.push.services.mozilla.com/w/1")).toBe("Firefox");
    expect(platformFromEndpoint("https://sg2p.notify.windows.com/w/?t=1")).toBe("Windows (Edge)");
    expect(platformFromEndpoint("not a url")).toBe("Unknown device");
    expect(platformFromEndpoint("https://evil.example/x")).toBe("Unknown device");
  });

  it("validPushKeys enforces base64url shape and P-256/auth lengths", () => {
    expect(validPushKeys(P256, AUTH)).toBe(true);
    expect(validPushKeys("short", AUTH)).toBe(false);
    expect(validPushKeys(P256, "x")).toBe(false);
    expect(validPushKeys(P256 + "!", AUTH)).toBe(false); // non-base64url
    expect(validPushKeys("a".repeat(200), AUTH)).toBe(false); // oversize
    expect(validPushKeys(P256, "c".repeat(50))).toBe(false);
  });
});

describe("sendWebPush", () => {
  it("sends a JSON payload with title/body/url/tag, TTL and a timeout", async () => {
    const sender = vi.fn(async () => ({}));
    await sendWebPush(
      SUB,
      {
        title: "Lifer nearby: ʻAkikiki",
        body: "Kōkeʻe · 3 mi from home",
        url: "https://birds.gaylon.photos/forecast/species?species=akikik",
        tag: "need-akikik",
      },
      sender,
    );
    const [pushSub, payload, options] = sender.mock.calls[0] as unknown as [
      { endpoint: string; keys: { p256dh: string; auth: string } },
      string,
      { TTL: number; timeout: number },
    ];
    expect(pushSub).toEqual({ endpoint: SUB.endpoint, keys: { p256dh: "key", auth: "auth" } });
    const parsed = JSON.parse(payload);
    expect(parsed.title).toBe("Lifer nearby: ʻAkikiki"); // UTF-8 body, no header limits
    expect(parsed.url).toMatch(/^https:\/\//);
    expect(parsed.tag).toBe("need-akikik");
    expect(options.TTL).toBe(3600);
    expect(options.timeout).toBe(PUSH_TIMEOUT_MS);
  });

  it("404/410 → PushError with gone=true; other statuses gone=false", async () => {
    for (const [status, gone] of [
      [410, true],
      [404, true],
      [500, false],
      [429, false],
    ] as const) {
      const sender = vi.fn(async () => {
        throw Object.assign(new Error("boom"), { statusCode: status });
      });
      const err = (await sendWebPush(SUB, { title: "t", body: "b" }, sender).catch(
        (e) => e,
      )) as InstanceType<typeof PushError>;
      expect(err).toBeInstanceOf(PushError);
      expect(err.status).toBe(status);
      expect(err.gone).toBe(gone);
    }
  });

  it("errors NEVER contain the endpoint (capability secrecy)", async () => {
    const sender = vi.fn(async () => {
      throw Object.assign(new Error(`request to ${SUB.endpoint} failed`), { statusCode: 502 });
    });
    const err = (await sendWebPush(SUB, { title: "t", body: "b" }, sender).catch(
      (e) => e,
    )) as Error;
    expect(err.message).not.toContain(SUB.endpoint);
    expect(err.message).not.toContain("device-SECRET");
  });

  it("network failure (no status) → PushError(0, not gone)", async () => {
    const sender = vi.fn(async () => {
      throw new Error("socket hang up");
    });
    const err = (await sendWebPush(SUB, { title: "t", body: "b" }, sender).catch(
      (e) => e,
    )) as InstanceType<typeof PushError>;
    expect(err.status).toBe(0);
    expect(err.gone).toBe(false);
  });
});
