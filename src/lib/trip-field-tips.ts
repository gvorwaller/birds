export interface FieldTipStopSource {
  id: number;
  custom_name: string | null;
  notes: string | null;
}

export interface FieldTipStopInput {
  id: number;
  name: string;
  notes: string | null;
}

export function fieldTipInputsForStops(
  stops: FieldTipStopSource[],
): FieldTipStopInput[] {
  return stops.map((s) => ({
    id: s.id,
    name: s.custom_name ?? "Stop",
    notes: s.notes,
  }));
}

export function missingFieldTipStopNames(
  requested: FieldTipStopInput[],
  tips: Record<number, string>,
): string[] {
  return requested
    .filter((s) => !tips[s.id]?.trim())
    .map((s) => s.name);
}
