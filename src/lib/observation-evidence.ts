export interface ObservationEvidence {
  speciesCode: string;
  locId?: string | null;
  lat: number;
  lng: number;
  obsDt: string;
  subId?: string | null;
  obsValid?: boolean;
  source?: string;
  sources?: string[];
}

export type ReportStatus = "accepted" | "unconfirmed" | "review-unavailable";

export function observationIdentity(o: ObservationEvidence): string {
  const loc = o.locId || `${o.lat},${o.lng}`;
  return `${o.speciesCode}|${loc}|${o.obsDt}|${o.subId ?? "anonymous"}`;
}

export function reportStatus(o: Pick<ObservationEvidence, "obsValid">): ReportStatus {
  if (o.obsValid === false) return "unconfirmed";
  if (o.obsValid === true) return "accepted";
  return "review-unavailable";
}
