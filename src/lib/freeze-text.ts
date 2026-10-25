/**
 * Admin → Metrics, Server freezes (td-b07462): one sentence per freeze from
 * what was recorded. Requests already running when it began may have caused
 * it or paused through it; the record cannot tell which, so neither does this.
 */
export interface FreezeText {
  runningList: { route: string; method: string }[];
  runningBefore: number;
  arrivedDuring: number;
  busy: string[];
}

export function describeFreeze(f: FreezeText): string {
  const parts: string[] = [];
  if (f.busy.length) parts.push(`Running: ${f.busy.join(", ")}.`);
  if (f.runningBefore > 0) {
    const names = [...new Set(f.runningList.map((r) => `${r.method === "GET" ? "" : `${r.method} `}${r.route}`))];
    const more = f.runningBefore - f.runningList.length;
    parts.push(
      `${f.runningBefore === 1 ? "1 request was" : `${f.runningBefore.toLocaleString("en-US")} requests were`} already running when it began: ${names.join(", ")}${more > 0 ? ` and ${more.toLocaleString("en-US")} more` : ""}.`,
    );
  } else {
    parts.push("No request was running when it began.");
  }
  if (f.arrivedDuring > 0) parts.push(`${f.arrivedDuring.toLocaleString("en-US")} more started while it lasted.`);
  return parts.join(" ");
}
