import { describe, expect, it } from "vitest";
import { parsePin, parsePlacePin } from "./pin-params";

describe("parsePin", () => {
  it("REGRESSION: absent params are NOT the Gulf of Guinea", () => {
    // Number(null) === 0 — the bug that pinned every plain /forecast visit
    // to (0,0) and stomped the saved home. Absent params must mean no pin.
    expect(parsePin(null, null, null)).toBeNull();
    expect(parsePin("", "", null)).toBeNull();
    expect(parsePin("  ", "  ", null)).toBeNull();
    expect(parsePin("27.5", null, null)).toBeNull();
    expect(parsePin(null, "-82.6", null)).toBeNull();
  });

  it("parses a valid pin with label", () => {
    expect(parsePin("26.75484", "-81.43757", "Dinner Island Ranch WMA")).toEqual(
      { lat: 26.75484, lng: -81.43757, label: "Dinner Island Ranch WMA" },
    );
  });

  it("labels a bare pin with its coordinates", () => {
    expect(parsePin("44.413", "-68.588", null)?.label).toBe("44.413, -68.588");
  });

  it("explicit (0,0) IS a valid pin — only absence is not", () => {
    expect(parsePin("0", "0", "Null Island")).toEqual({
      lat: 0,
      lng: 0,
      label: "Null Island",
    });
  });

  it("rejects junk and out-of-range values", () => {
    expect(parsePin("abc", "-81", null)).toBeNull();
    expect(parsePin("91", "0", null)).toBeNull();
    expect(parsePin("0", "181", null)).toBeNull();
  });

  it("truncates absurdly long labels", () => {
    expect(parsePin("1", "1", "x".repeat(500))?.label).toHaveLength(120);
  });
});

describe("parsePlacePin", () => {
  it("uses the point while the place box still holds the picked label", () => {
    expect(
      parsePlacePin(
        "Bar Harbor, ME",
        "44.38770",
        "-68.20390",
        "Bar Harbor, ME",
      ),
    ).toEqual({ lat: 44.3877, lng: -68.2039, label: "Bar Harbor, ME" });
  });

  it("ignores surrounding whitespace on both sides", () => {
    expect(
      parsePlacePin(
        "  Bar Harbor, ME ",
        "44.3877",
        "-68.2039",
        " Bar Harbor, ME",
      )?.label,
    ).toBe("Bar Harbor, ME");
  });

  it("drops the point once a different place is typed", () => {
    expect(
      parsePlacePin(
        "Jacksonville, FL",
        "44.3877",
        "-68.2039",
        "Bar Harbor, ME",
      ),
    ).toBeNull();
  });

  it("needs a place and a pin label — coordinates alone never apply", () => {
    expect(parsePlacePin("", "44.3877", "-68.2039", "")).toBeNull();
    expect(parsePlacePin("", "44.3877", "-68.2039", null)).toBeNull();
    expect(
      parsePlacePin("Bar Harbor, ME", "44.3877", "-68.2039", null),
    ).toBeNull();
  });

  it("keeps a long picked name whole, unlike a bare pin label", () => {
    const long = `${"Long Road ".repeat(15)}Bar Harbor, ME`;
    expect(parsePlacePin(long, "44.3877", "-68.2039", long)?.label).toBe(long);
  });

  it("still rejects missing or junk coordinates", () => {
    expect(
      parsePlacePin("Bar Harbor, ME", null, null, "Bar Harbor, ME"),
    ).toBeNull();
    expect(
      parsePlacePin("Bar Harbor, ME", "", "", "Bar Harbor, ME"),
    ).toBeNull();
    expect(
      parsePlacePin("Bar Harbor, ME", "abc", "-68", "Bar Harbor, ME"),
    ).toBeNull();
    expect(
      parsePlacePin("Bar Harbor, ME", "91", "0", "Bar Harbor, ME"),
    ).toBeNull();
  });
});
