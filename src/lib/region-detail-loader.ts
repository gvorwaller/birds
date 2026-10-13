/**
 * Hotspots & data: the county blocks and hotspot rows of each open region
 * group, fetched on open (td-3bf3a2) and kept across navigations (td-fb6948).
 *
 * - Many groups load at once (a remembered open set can be ~20): each answer
 *   merges into the CURRENT state after its body is read, never into a copy
 *   taken before the await (that lost update left groups "Loading …" forever).
 * - Rows are kept until the loaded data changes (`setVersion`): then the
 *   cache, failures and fetched marks reset, and an answer to a request made
 *   before the change is dropped, success or failure (CODEX1).
 * - A failure (HTTP error, network, timeout) is recorded so the page shows it
 *   with Retry; the group may be asked for again.
 *
 * Reads and writes the page's reactive state through `get`/`set`, so it is
 * testable without Svelte.
 */
export interface RegionDetailState<T> {
  details: Record<string, T>;
  failed: string[];
}

export type RegionDetailFetcher<T> = (code: string, name: string, signal: AbortSignal) => Promise<T>;

export class RegionDetailLoader<T> {
  private readonly fetched = new Set<string>();

  constructor(
    private version: string,
    private readonly get: () => RegionDetailState<T>,
    private readonly set: (patch: Partial<RegionDetailState<T>>) => void,
    private readonly fetchDetail: RegionDetailFetcher<T>,
    private readonly timeoutMs = 30_000,
  ) {}

  /** The loaded data changed: forget every group's rows and failures. */
  setVersion(version: string): void {
    if (version === this.version) return;
    this.version = version;
    this.fetched.clear();
    this.set({ details: {}, failed: [] });
  }

  /** Loads one group unless it is loaded or loading (`Retry` calls it too). */
  async load(code: string, name: string): Promise<void> {
    if (this.fetched.has(code)) return;
    this.fetched.add(code);
    this.set({ failed: this.get().failed.filter((c) => c !== code) });
    const version = this.version;
    try {
      const detail = await this.fetchDetail(code, name, AbortSignal.timeout(this.timeoutMs));
      if (version !== this.version) return; // the data changed meanwhile
      this.set({ details: { ...this.get().details, [code]: detail } });
    } catch {
      if (version !== this.version) return;
      this.fetched.delete(code); // transient: Retry (or reopening) asks again
      this.set({ failed: [...this.get().failed, code] });
    }
  }
}
