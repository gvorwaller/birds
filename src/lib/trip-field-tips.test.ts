import { describe, expect, it } from "vitest";
import {
  fieldTipInputsForStops,
  missingFieldTipStopNames,
} from "./trip-field-tips";

describe("trip field tip refresh helpers", () => {
  it("includes every stop, including stops that already have persisted tips", () => {
    const stops = [
      {
        id: 10,
        custom_name: "Sweetwater Wetlands Park",
        notes: "Planner-selected targets: King Rail.",
        field_tip: "Old saved tip",
      },
      {
        id: 11,
        custom_name: "Paynes Prairie",
        notes: null,
        field_tip: null,
      },
    ];

    expect(fieldTipInputsForStops(stops)).toEqual([
      {
        id: 10,
        name: "Sweetwater Wetlands Park",
        notes: "Planner-selected targets: King Rail.",
      },
      {
        id: 11,
        name: "Paynes Prairie",
        notes: null,
      },
    ]);
  });

  it("reports stops that did not receive a generated tip", () => {
    expect(
      missingFieldTipStopNames(
        [
          { id: 1, name: "Alpha", notes: null },
          { id: 2, name: "Beta", notes: null },
        ],
        { 1: "Try the marsh edge." },
      ),
    ).toEqual(["Beta"]);
  });
});
