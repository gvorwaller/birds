import { beforeEach, describe, expect, it, vi } from "vitest";
import { haversineKm } from "$lib/geo";
import predictionsFixtureRaw from "./fixtures/tide-predictions-8726364.json";
import stationsFixtureRaw from "./fixtures/tide-stations-sample.json";

// ---------------------------------------------------------------------------
// DB mock (pattern: barchart.test.ts) — every ebird_cache statement is
// recorded and routed by cache_key so tests can assert on exact reads/writes
// without a real Postgres.
// ---------------------------------------------------------------------------
const dbCalls: { text: string; params: unknown[] }[] = [];
let queryHandler: (
  text: string,
  params?: unknown[],
) => { rows: unknown[] } | undefined = () => undefined;

async function mockQuery(text: string, params?: unknown[]) {
  dbCalls.push({ text, params: params ?? [] });
  return queryHandler(text, params) ?? { rows: [] };
}

vi.mock("$lib/db", () => ({
  query: (text: string, params?: unknown[]) => mockQuery(text, params),
}));

import {
  _resetStationMemo,
  extremesOnLocalDate,
  localDate,
  localDayOffset,
  nearestStation,
  nearestTideStation,
  parseCoopsTime,
  parsePredictions,
  parseStationList,
  pickNext,
  stationTimeZone,
  targetTripDate,
  tidesForStops,
  tidesNear,
  TIDE_MAX_STATION_KM,
  type RawTideExtreme,
  type TideStation,
} from "./tides";

// ---------------------------------------------------------------------------
// Shared fixtures/constants.
// ---------------------------------------------------------------------------
const REAL_STATIONS: TideStation[] = parseStationList(stationsFixtureRaw, 5);
const REAL_EXTREMES: RawTideExtreme[] = parsePredictions(
  predictionsFixtureRaw,
).extremes;
const STATION_ID = "8726364";
const FORT_DE_SOTO = { lat: 27.6159, lon: -82.7371 };
const ORLANDO = { lat: 28.5383, lon: -81.3792 };
// 15:00Z on 2026-08-24 is 11:00 AM EDT — station-local "today" for 8726364.
const NOW = new Date("2026-08-24T15:00:00Z");
const TODAY = "2026-08-24";

function paddingStations(n: number): TideStation[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `PAD${i}`,
    name: `Padding Station ${i}`,
    lat: 0,
    lng: 0,
    state: null,
    tz: "UTC",
  }));
}
// Real stations that resolve a tz + generous synthetic padding, so the
// MIN_STATIONS poison-cache gate (1000) is satisfied without fabricating
// fixture DATA — this is test scaffolding, not a claimed NOAA capture.
const PADDED_STATIONS: TideStation[] = [
  ...REAL_STATIONS,
  ...paddingStations(1000),
];

function rawPaddingRecords(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `PAD${i}`,
    name: `Padding Station ${i}`,
    lat: 0,
    lng: 0,
    state: "FL",
    timezonecorr: -5,
  }));
}
function rawStationsJsonWithPadding() {
  const raw = stationsFixtureRaw as { stations: unknown[] };
  return { stations: [...raw.stations, ...rawPaddingRecords(1000)] };
}

function row(payload: unknown, fetchedAt: Date = NOW) {
  return { payload, fetched_at: fetchedAt.toISOString() };
}
function staleRow(payload: unknown) {
  return row(payload, new Date(NOW.getTime() - 40 * 24 * 60 * 60_000)); // 40d > 30d TTL
}

function defaultHandler(
  opts: { stationsRow?: unknown; predRows?: Record<string, unknown> } = {},
): (text: string, params?: unknown[]) => { rows: unknown[] } | undefined {
  const hasOverride = "stationsRow" in opts;
  const stationsRow = hasOverride
    ? opts.stationsRow
    : row({ stations: PADDED_STATIONS });
  return (text, params) => {
    if (text.startsWith("SELECT payload, fetched_at FROM ebird_cache")) {
      const key = String(params?.[0]);
      if (key === "tideStations:v1")
        return { rows: stationsRow ? [stationsRow] : [] };
      if (opts.predRows && key in opts.predRows) {
        const v = opts.predRows[key];
        return { rows: v ? [v] : [] };
      }
      return { rows: [] };
    }
    return { rows: [] };
  };
}

function makeFetcher(handlers: {
  stations?: (url: string, init: RequestInit) => Response | Promise<Response>;
  predictions?: (
    url: string,
    init: RequestInit,
  ) => Response | Promise<Response>;
}) {
  const calls = { stations: 0, predictions: 0 };
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("mdapi/prod/webapi/stations.json")) {
      calls.stations++;
      if (!handlers.stations) throw new Error("unexpected stations fetch");
      return handlers.stations(url, init ?? {});
    }
    if (url.includes("datagetter")) {
      calls.predictions++;
      if (!handlers.predictions)
        throw new Error("unexpected predictions fetch");
      return handlers.predictions(url, init ?? {});
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
  return { fetcher, calls };
}

beforeEach(() => {
  dbCalls.length = 0;
  _resetStationMemo();
  queryHandler = defaultHandler();
});

// ---------------------------------------------------------------------------
// Pure helpers.
// ---------------------------------------------------------------------------

describe("parseCoopsTime", () => {
  it("parses a valid GMT timestamp to ISO UTC", () => {
    expect(parseCoopsTime("2026-08-24 14:01")).toBe("2026-08-24T14:01:00Z");
  });

  it("throws on malformed or calendar-invalid input", () => {
    expect(() => parseCoopsTime("garbage")).toThrow();
    expect(() => parseCoopsTime("")).toThrow();
    expect(() => parseCoopsTime("2026-13-01 00:00")).toThrow(); // bad month
    expect(() => parseCoopsTime("2026-02-30 00:00")).toThrow(); // Feb has no 30th
  });
});

describe("stationTimeZone", () => {
  it("resolves every documented allowlist pair", () => {
    expect(stationTimeZone(-5, "FL")).toBe("America/New_York");
    expect(stationTimeZone(-6, "FL")).toBe("America/Chicago");
    expect(stationTimeZone(-8, "CA")).toBe("America/Los_Angeles");
    expect(stationTimeZone(-9, "AK")).toBe("America/Anchorage");
    expect(stationTimeZone(-10, "AK")).toBe("America/Adak");
    expect(stationTimeZone(-10, "HI")).toBe("Pacific/Honolulu");
    expect(stationTimeZone(-4, "PR")).toBe("America/Puerto_Rico");
    expect(stationTimeZone(-4, "VI")).toBe("America/Puerto_Rico");
  });

  it("(-10, HI) vs (-10, AK) diverge; blank state at -10 is null", () => {
    expect(stationTimeZone(-10, "HI")).toBe("Pacific/Honolulu");
    expect(stationTimeZone(-10, "AK")).toBe("America/Adak");
    expect(stationTimeZone(-10, "")).toBeNull();
  });

  it("an offset outside the documented table returns null regardless of state", () => {
    expect(stationTimeZone(-7, "")).toBeNull();
    expect(stationTimeZone(-7, "AZ")).toBeNull();
  });

  it("foreign/blank-state pairs at -4/-5/-6/-8 return null rather than inheriting a US DST rule", () => {
    expect(stationTimeZone(-5, "")).toBeNull();
    expect(stationTimeZone(-5, "ON")).toBeNull(); // Ontario, Canada also runs -5
    expect(stationTimeZone(-6, "")).toBeNull();
    expect(stationTimeZone(-6, "MX")).toBeNull();
    expect(stationTimeZone(-8, "")).toBeNull();
    expect(stationTimeZone(-4, "")).toBeNull();
    expect(stationTimeZone(-4, "BS")).toBeNull(); // Bahamas also runs -4
  });

  it("trims and uppercases the state code before lookup", () => {
    expect(stationTimeZone(-5, " fl ")).toBe("America/New_York");
  });
});

describe("parseStationList", () => {
  it("parses the real 10-station fixture with an explicit test threshold, dropping unresolvable-tz stations", () => {
    const stations = parseStationList(stationsFixtureRaw, 5);
    // 1619000 (blank state) and 1633227 (GU, not in the allowlist) are dropped.
    expect(stations).toHaveLength(8);
    expect(stations.find((s) => s.id === "1619000")).toBeUndefined();
    expect(stations.find((s) => s.id === "1633227")).toBeUndefined();
    const mullet = stations.find((s) => s.id === "8726364")!;
    expect(mullet.tz).toBe("America/New_York");
    expect(mullet.state).toBe("FL");
  });

  it("trims/uppercases a messy state code on ingest", () => {
    const json = {
      stations: [
        {
          id: "X1",
          name: "Test Station",
          lat: 1,
          lng: 1,
          state: " fl ",
          timezonecorr: -5,
        },
      ],
    };
    const stations = parseStationList(json, 1);
    expect(stations[0].state).toBe("FL");
  });

  it("throws under the poison-cache threshold — production never overrides this default", () => {
    expect(() => parseStationList(stationsFixtureRaw)).toThrow(
      /implausibly small/,
    );
  });
});

describe("parsePredictions", () => {
  it("parses the real captured fixture", () => {
    const { extremes } = parsePredictions(predictionsFixtureRaw);
    expect(extremes).toHaveLength(12);
    expect(extremes[0]).toEqual({
      type: "H",
      at: "2026-08-23T13:00:00Z",
      feetMllw: 2.022,
    });
  });

  it("an {error} body throws (covers both the HTTP 200 and 400 error forms)", () => {
    expect(() =>
      parsePredictions({ error: { message: "No data was found." } }),
    ).toThrow();
    expect(() => parsePredictions({ error: "Wrong Type Datum" })).toThrow();
  });

  it("an empty predictions array throws", () => {
    expect(() => parsePredictions({ predictions: [] })).toThrow();
  });

  it("filters a bad type, a non-finite v, and a malformed timestamp without discarding the valid rows", () => {
    const { extremes } = parsePredictions({
      predictions: [
        { t: "2026-08-24 14:01", v: "2.123", type: "H" },
        { t: "2026-08-24 21:41", v: "-0.048", type: "L" },
        { t: "2026-08-24 23:00", v: "1.0", type: "X" }, // bad type
        { t: "2026-08-25 05:20", v: "abc", type: "H" }, // non-finite v
        { t: "not-a-time", v: "1.0", type: "L" }, // malformed timestamp
      ],
    });
    expect(extremes).toEqual([
      { type: "H", at: "2026-08-24T14:01:00Z", feetMllw: 2.123 },
      { type: "L", at: "2026-08-24T21:41:00Z", feetMllw: -0.048 },
    ]);
  });
});

describe("nearestStation", () => {
  it("the default cutoff constant is 25 km", () => {
    expect(TIDE_MAX_STATION_KM).toBe(25);
  });

  it("Fort De Soto → Mullet Key Channel (Skyway), ~1.03 km", () => {
    const result = nearestStation(
      REAL_STATIONS,
      FORT_DE_SOTO.lat,
      FORT_DE_SOTO.lon,
    );
    expect(result?.station.id).toBe("8726364");
    expect(result?.distanceKm).toBeCloseTo(1.03, 1);
  });

  it("Orlando → null at the 25 km cutoff", () => {
    expect(
      nearestStation(REAL_STATIONS, ORLANDO.lat, ORLANDO.lon, 25),
    ).toBeNull();
  });

  it("an exact tie resolves to the first station in input order", () => {
    const probe = { lat: 10, lon: 10 };
    const s1: TideStation = {
      id: "S1",
      name: "S1",
      lat: 10.01,
      lng: 10,
      state: null,
      tz: "UTC",
    };
    const s2: TideStation = {
      id: "S2",
      name: "S2",
      lat: 9.99,
      lng: 10,
      state: null,
      tz: "UTC",
    };
    // Pure-latitude offsets of equal magnitude are exactly equidistant under haversine.
    const result = nearestStation([s1, s2], probe.lat, probe.lon, 5);
    expect(result?.station.id).toBe("S1");
  });
});

describe("pickNext (real diurnal 2026-08-24 fixture — range=72 regression)", () => {
  it("finds the next high on 08-25 despite the 16h gap around the diurnal day", () => {
    const nowMs = Date.parse("2026-08-24T15:00:00Z");
    const { nextHigh, nextLow } = pickNext(REAL_EXTREMES, nowMs);
    expect(nextLow?.at).toBe("2026-08-24T21:41:00Z");
    expect(nextHigh?.at).toBe("2026-08-25T05:20:00Z");
  });
});

describe("localDate", () => {
  it("formats YYYY-MM-DD in the given zone via Intl.formatToParts", () => {
    expect(
      localDate(new Date("2026-08-24T03:00:00Z"), "America/New_York"),
    ).toBe("2026-08-23");
    expect(localDate(new Date("2026-08-24T03:00:00Z"), "UTC")).toBe(
      "2026-08-24",
    );
  });
});

describe("extremesOnLocalDate", () => {
  it("returns only the extremes whose station-local date matches, chronological", () => {
    const day = extremesOnLocalDate(
      REAL_EXTREMES,
      "2026-08-24",
      "America/New_York",
    );
    expect(day.map((e) => e.at)).toEqual([
      "2026-08-24T14:01:00Z",
      "2026-08-24T21:41:00Z",
    ]);
  });
});

describe("localDayOffset", () => {
  it('03:00Z the next UTC day is still "today" once converted to EDT', () => {
    const now = new Date("2026-08-24T20:00:00Z"); // 4:00 PM EDT
    expect(
      localDayOffset("2026-08-25T03:00:00Z", "America/New_York", now),
    ).toBe(0);
  });

  it("is stable across the 2026-11-01 US fall-back DST transition", () => {
    const now = new Date("2026-10-31T12:00:00Z"); // 08:00 EDT on 10-31
    expect(
      localDayOffset("2026-11-01T12:00:00Z", "America/New_York", now),
    ).toBe(1);
  });
});

describe("targetTripDate", () => {
  it("start == null → today, next", () => {
    expect(targetTripDate("2026-08-24", null, null)).toEqual({
      date: "2026-08-24",
      mode: "next",
    });
  });
  it("today < start → start, day", () => {
    expect(targetTripDate("2026-08-20", "2026-08-24", "2026-08-26")).toEqual({
      date: "2026-08-24",
      mode: "day",
    });
  });
  it("start <= today <= end → today, next", () => {
    expect(targetTripDate("2026-08-25", "2026-08-24", "2026-08-26")).toEqual({
      date: "2026-08-25",
      mode: "next",
    });
  });
  it("today > end → null (finished trip — archive, zero fetches)", () => {
    expect(targetTripDate("2026-08-27", "2026-08-24", "2026-08-26")).toBeNull();
  });
  it("end defaults to start when omitted", () => {
    expect(targetTripDate("2026-08-24", "2026-08-24", null)).toEqual({
      date: "2026-08-24",
      mode: "next",
    });
    expect(targetTripDate("2026-08-25", "2026-08-24", null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// nearestTideStation
// ---------------------------------------------------------------------------

describe("nearestTideStation", () => {
  it("resolves the nearest station via the cached list, no live fetch needed", async () => {
    const { fetcher, calls } = makeFetcher({});
    const result = await nearestTideStation(
      FORT_DE_SOTO.lat,
      FORT_DE_SOTO.lon,
      {
        fetcher,
        now: NOW,
      },
    );
    expect(result?.station.id).toBe("8726364");
    expect(calls.stations).toBe(0);
  });

  it("rejects an invalid coordinate without any DB call", async () => {
    const { fetcher } = makeFetcher({});
    const result = await nearestTideStation(999, 0, { fetcher, now: NOW });
    expect(result).toBeNull();
    expect(dbCalls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// tidesNear
// ---------------------------------------------------------------------------

describe("tidesNear", () => {
  it("fresh predictions cache → the fetcher is never called", async () => {
    queryHandler = defaultHandler({
      predRows: {
        [`tidePred:${STATION_ID}:${TODAY}`]: row({ extremes: REAL_EXTREMES }),
      },
    });
    const { fetcher, calls } = makeFetcher({});
    const result = await tidesNear(FORT_DE_SOTO.lat, FORT_DE_SOTO.lon, {
      fetcher,
      now: NOW,
    });
    expect(result).not.toBeNull();
    expect(result!.stale).toBe(false);
    expect(result!.mode).toBe("next");
    expect(result!.nextLow?.at).toBe("2026-08-24T21:41:00Z");
    expect(result!.nextLow?.dayOffset).toBe(0);
    expect(result!.nextHigh?.at).toBe("2026-08-25T05:20:00Z");
    expect(result!.nextHigh?.dayOffset).toBe(1);
    expect(result!.station.id).toBe("8726364");
    expect(calls.stations).toBe(0);
    expect(calls.predictions).toBe(0);
  });

  it("stale predictions row + a live fetch failure → stale:true", async () => {
    queryHandler = defaultHandler({
      predRows: {
        [`tidePred:${STATION_ID}:${TODAY}`]: staleRow({
          extremes: REAL_EXTREMES,
        }),
      },
    });
    const { fetcher } = makeFetcher({
      predictions: () => {
        throw new Error("network down");
      },
    });
    const result = await tidesNear(FORT_DE_SOTO.lat, FORT_DE_SOTO.lon, {
      fetcher,
      now: NOW,
    });
    expect(result).not.toBeNull();
    expect(result!.stale).toBe(true);
  });

  it("no cached row + fetch failure → null", async () => {
    const { fetcher } = makeFetcher({
      predictions: () => {
        throw new Error("down");
      },
    });
    const result = await tidesNear(FORT_DE_SOTO.lat, FORT_DE_SOTO.lon, {
      fetcher,
      now: NOW,
    });
    expect(result).toBeNull();
  });

  it("HTTP 200 with an {error} body → null, and NOTHING is cached", async () => {
    const { fetcher } = makeFetcher({
      predictions: async () =>
        new Response(
          JSON.stringify({ error: { message: "No data was found." } }),
          {
            status: 200,
          },
        ),
    });
    const result = await tidesNear(FORT_DE_SOTO.lat, FORT_DE_SOTO.lon, {
      fetcher,
      now: NOW,
    });
    expect(result).toBeNull();
    const key = `tidePred:${STATION_ID}:${TODAY}`;
    expect(
      dbCalls.some(
        (c) =>
          c.text.startsWith("INSERT INTO ebird_cache") && c.params[0] === key,
      ),
    ).toBe(false);
  });

  it("HTTP 400 with an {error} body → null", async () => {
    const { fetcher } = makeFetcher({
      predictions: async () =>
        new Response(
          JSON.stringify({ error: { message: "Wrong Type Datum" } }),
          { status: 400 },
        ),
    });
    const result = await tidesNear(FORT_DE_SOTO.lat, FORT_DE_SOTO.lon, {
      fetcher,
      now: NOW,
    });
    expect(result).toBeNull();
  });

  it("a non-JSON (HTML) 500 body with a stale row falls back to stale:true", async () => {
    queryHandler = defaultHandler({
      predRows: {
        [`tidePred:${STATION_ID}:${TODAY}`]: staleRow({
          extremes: REAL_EXTREMES,
        }),
      },
    });
    const { fetcher } = makeFetcher({
      predictions: async () =>
        new Response("<html>Internal Server Error</html>", { status: 500 }),
    });
    const result = await tidesNear(FORT_DE_SOTO.lat, FORT_DE_SOTO.lon, {
      fetcher,
      now: NOW,
    });
    expect(result?.stale).toBe(true);
  });

  it("a non-JSON (HTML) 500 body with no cached row → null", async () => {
    const { fetcher } = makeFetcher({
      predictions: async () =>
        new Response("<html>Internal Server Error</html>", { status: 500 }),
    });
    const result = await tidesNear(FORT_DE_SOTO.lat, FORT_DE_SOTO.lon, {
      fetcher,
      now: NOW,
    });
    expect(result).toBeNull();
  });

  it("a coordinate with no station in range → null, only the station-list fetch is issued", async () => {
    queryHandler = defaultHandler({ stationsRow: null }); // force a live station fetch
    const { fetcher, calls } = makeFetcher({
      stations: async () =>
        new Response(JSON.stringify(rawStationsJsonWithPadding()), {
          status: 200,
        }),
      predictions: async () => {
        throw new Error("must not be called");
      },
    });
    const KANSAS = { lat: 38.5, lon: -98.0 };
    const result = await tidesNear(KANSAS.lat, KANSAS.lon, {
      fetcher,
      now: NOW,
    });
    expect(result).toBeNull();
    expect(calls.stations).toBe(1);
    expect(calls.predictions).toBe(0);
  });

  it("the predictions URL carries every fixed param, begin_date = target-1, application param, and the UA header", async () => {
    let seenUrl = "";
    let seenHeaders: Record<string, string> = {};
    const { fetcher } = makeFetcher({
      predictions: async (url, init) => {
        seenUrl = url;
        seenHeaders = init.headers as Record<string, string>;
        return new Response(JSON.stringify(predictionsFixtureRaw), {
          status: 200,
        });
      },
    });
    const result = await tidesNear(FORT_DE_SOTO.lat, FORT_DE_SOTO.lon, {
      fetcher,
      now: NOW,
    });
    expect(result).not.toBeNull();
    const u = new URL(seenUrl);
    expect(u.searchParams.get("station")).toBe(STATION_ID);
    expect(u.searchParams.get("product")).toBe("predictions");
    expect(u.searchParams.get("datum")).toBe("MLLW");
    expect(u.searchParams.get("time_zone")).toBe("gmt");
    expect(u.searchParams.get("interval")).toBe("hilo");
    expect(u.searchParams.get("units")).toBe("english");
    expect(u.searchParams.get("format")).toBe("json");
    expect(u.searchParams.get("range")).toBe("72");
    expect(u.searchParams.get("application")).toBe("birds.gaylon.photos");
    expect(u.searchParams.get("begin_date")).toBe("20260823"); // TODAY(08-24) - 1 day
    expect(seenHeaders["User-Agent"]).toBe(
      "birds.gaylon.photos trip planner (gaylon@vorwaller.net)",
    );
  });

  it("an already-aborted caller signal aborts the fetch and fails soft (never throws)", async () => {
    const controller = new AbortController();
    controller.abort();
    const { fetcher } = makeFetcher({
      predictions: async (_url, init) => {
        if ((init.signal as AbortSignal)?.aborted)
          throw new DOMException("aborted", "AbortError");
        return new Response(JSON.stringify(predictionsFixtureRaw), {
          status: 200,
        });
      },
    });
    const result = await tidesNear(FORT_DE_SOTO.lat, FORT_DE_SOTO.lon, {
      fetcher,
      now: NOW,
      signal: controller.signal,
    });
    expect(result).toBeNull();
  });

  it("the fetch signal composes the caller signal with an internal timeout", async () => {
    let seenSignal: AbortSignal | undefined;
    const { fetcher } = makeFetcher({
      predictions: async (_url, init) => {
        seenSignal = init.signal as AbortSignal;
        return new Response(JSON.stringify(predictionsFixtureRaw), {
          status: 200,
        });
      },
    });
    const controller = new AbortController();
    await tidesNear(FORT_DE_SOTO.lat, FORT_DE_SOTO.lon, {
      fetcher,
      now: NOW,
      signal: controller.signal,
    });
    expect(seenSignal).toBeInstanceOf(AbortSignal);
    expect(seenSignal?.aborted).toBe(false);
  });

  it("malformed coordinates return null without any DB or fetch call", async () => {
    const { fetcher, calls } = makeFetcher({});
    const result = await tidesNear(999, -82, { fetcher, now: NOW });
    expect(result).toBeNull();
    expect(dbCalls.length).toBe(0);
    expect(calls.stations + calls.predictions).toBe(0);
  });

  it("a malformed targetDate returns null without any DB or fetch call", async () => {
    const { fetcher, calls } = makeFetcher({});
    const result = await tidesNear(FORT_DE_SOTO.lat, FORT_DE_SOTO.lon, {
      fetcher,
      now: NOW,
      targetDate: "not-a-date",
    });
    expect(result).toBeNull();
    expect(dbCalls.length).toBe(0);
    expect(calls.stations + calls.predictions).toBe(0);
  });

  it("a malformed FRESH predictions row is a cache miss — falls through to a live fetch", async () => {
    queryHandler = defaultHandler({
      predRows: {
        [`tidePred:${STATION_ID}:${TODAY}`]: row({ extremes: "not-an-array" }),
      },
    });
    const { fetcher, calls } = makeFetcher({
      predictions: async () =>
        new Response(JSON.stringify(predictionsFixtureRaw), { status: 200 }),
    });
    const result = await tidesNear(FORT_DE_SOTO.lat, FORT_DE_SOTO.lon, {
      fetcher,
      now: NOW,
    });
    expect(result).not.toBeNull();
    expect(calls.predictions).toBe(1);
  });

  it("a malformed STALE predictions row is never used as a fallback", async () => {
    queryHandler = defaultHandler({
      predRows: {
        [`tidePred:${STATION_ID}:${TODAY}`]: staleRow({
          extremes: [{ type: "X", at: "nope" }],
        }),
      },
    });
    const { fetcher } = makeFetcher({
      predictions: () => {
        throw new Error("down");
      },
    });
    const result = await tidesNear(FORT_DE_SOTO.lat, FORT_DE_SOTO.lon, {
      fetcher,
      now: NOW,
    });
    expect(result).toBeNull();
  });

  it("a target date with no matching extremes derives nothing → null (day mode)", async () => {
    const future = "2026-09-01";
    queryHandler = defaultHandler({
      predRows: {
        [`tidePred:${STATION_ID}:${future}`]: row({ extremes: REAL_EXTREMES }),
      },
    });
    const { fetcher, calls } = makeFetcher({});
    const result = await tidesNear(FORT_DE_SOTO.lat, FORT_DE_SOTO.lon, {
      fetcher,
      now: NOW,
      targetDate: future,
    });
    expect(result).toBeNull();
    expect(calls.predictions).toBe(0); // cache hit; nothing derivable from it
  });
});

// ---------------------------------------------------------------------------
// tidesForStops
// ---------------------------------------------------------------------------

describe("tidesForStops", () => {
  it("dedupes same-station stops onto ONE predictions fetch, with three correct per-stop distances", async () => {
    const { fetcher, calls } = makeFetcher({
      predictions: async () =>
        new Response(JSON.stringify(predictionsFixtureRaw), { status: 200 }),
    });
    const stops = [
      { id: 1, lat: FORT_DE_SOTO.lat, lon: FORT_DE_SOTO.lon },
      { id: 2, lat: FORT_DE_SOTO.lat + 0.001, lon: FORT_DE_SOTO.lon },
      { id: 3, lat: FORT_DE_SOTO.lat + 0.002, lon: FORT_DE_SOTO.lon },
    ];
    const result = await tidesForStops(stops, { fetcher, now: NOW });
    expect(Object.keys(result).sort()).toEqual(["1", "2", "3"]);
    expect(calls.predictions).toBe(1);
    const stationLat = 27.615;
    const stationLng = -82.7267;
    expect(result["1"].station.distanceKm).toBeCloseTo(
      haversineKm(FORT_DE_SOTO.lat, FORT_DE_SOTO.lon, stationLat, stationLng),
      6,
    );
    expect(result["2"].station.distanceKm).toBeCloseTo(
      haversineKm(
        FORT_DE_SOTO.lat + 0.001,
        FORT_DE_SOTO.lon,
        stationLat,
        stationLng,
      ),
      6,
    );
    expect(result["3"].station.distanceKm).toBeCloseTo(
      haversineKm(
        FORT_DE_SOTO.lat + 0.002,
        FORT_DE_SOTO.lon,
        stationLat,
        stationLng,
      ),
      6,
    );
    // Distinct per-stop distances — one stop's distance never leaks into a sibling.
    expect(result["1"].station.distanceKm).not.toBe(
      result["2"].station.distanceKm,
    );
    expect(result["2"].station.distanceKm).not.toBe(
      result["3"].station.distanceKm,
    );
  });

  it("a null-lat stop is skipped", async () => {
    const { fetcher } = makeFetcher({
      predictions: async () =>
        new Response(JSON.stringify(predictionsFixtureRaw), { status: 200 }),
    });
    const stops = [
      { id: 1, lat: FORT_DE_SOTO.lat, lon: FORT_DE_SOTO.lon },
      { id: 2, lat: null, lon: null },
    ];
    const result = await tidesForStops(stops, { fetcher, now: NOW });
    expect(Object.keys(result)).toEqual(["1"]);
  });

  it("a finished trip (station-local today past end_date) → {} and zero prediction fetches", async () => {
    const { fetcher, calls } = makeFetcher({});
    const stops = [{ id: 1, lat: FORT_DE_SOTO.lat, lon: FORT_DE_SOTO.lon }];
    const result = await tidesForStops(stops, {
      fetcher,
      now: NOW, // station-local today = 2026-08-24
      startDate: "2026-08-10",
      endDate: "2026-08-20",
    });
    expect(result).toEqual({});
    expect(calls.predictions).toBe(0);
  });
});
