const LEGACY_TARGET_NOTE =
  /^\d+ of your needs reported here \(last seen ([^)]+)\): (.+?)\.?$/;

export function plannerTargetNote(
  names: string[],
  lastSeenDate: string,
  extraCount = 0,
): string {
  const list =
    names.join(", ") + (extraCount > 0 ? `, +${extraCount} more` : "");
  return `Planner-selected targets (last seen ${lastSeenDate}): ${list}.`;
}

export function normalizeTripStopNote(note: string): string {
  const trimmed = note.trim();
  const legacy = trimmed.match(LEGACY_TARGET_NOTE);
  if (!legacy) return trimmed;
  return plannerTargetNote([legacy[2]], legacy[1]);
}
