import { beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({ page: { url: new URL("https://birds.test/trips/9"), state: {} as Record<string, unknown> }, goto: vi.fn(), replaceState: vi.fn(), type: "navigate" }));
const store = new Map<string, string>();
vi.mock("$app/environment", () => ({ browser: true }));
vi.mock("$app/state", () => ({ page: f.page }));
vi.mock("$app/navigation", () => ({ goto: f.goto, replaceState: f.replaceState }));
async function adapter() { return import("./navigation-context.svelte"); }
const click = () => ({ button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false, currentTarget: { target: "", hasAttribute: () => false }, preventDefault: vi.fn() } as unknown as MouseEvent);

beforeEach(() => {
	vi.resetModules(); store.clear(); f.type = "navigate"; f.page.url = new URL("https://birds.test/trips/9"); f.page.state = {};
	vi.stubGlobal("window", { sessionStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) }, scrollY: 0 });
	vi.stubGlobal("performance", { getEntriesByType: () => [{ type: f.type }] });
	f.replaceState.mockReset().mockImplementation((_url: unknown, state: Record<string, unknown>) => { f.page.state = state; });
	f.goto.mockReset().mockImplementation(async (href: string, options: { state: Record<string, unknown> }) => { f.page.url = new URL(href, "https://birds.test"); f.page.state = options.state; });
});

describe("navigation reload bridge", () => {
	it("reattaches the last successful node only on a document reload", async () => {
		let nav = await adapter();
		nav.ensureCurrentNode({ accountId: 1, label: "Trip" });
		nav.navigateWithContext({ event: click(), href: "/hotspots/L1?returnTo=%2Ftrips%2F9", label: "Park", accountId: 1 });
		await Promise.resolve(); await Promise.resolve();
		f.page.url = new URL("https://birds.test/hotspots/L1"); f.page.state = {}; f.type = "reload";
		vi.resetModules(); nav = await adapter();
		const restored = nav.ensureCurrentNode({ accountId: 1, label: "Park" });
		expect(nav.trailFor(1, restored?.id).nodes.map((n) => n.label)).toEqual(["Trip", "Park"]);
	});
	it("does not revive the bridge on ordinary navigation", async () => {
		let nav = await adapter();
		nav.ensureCurrentNode({ accountId: 1, label: "Trip" });
		nav.navigateWithContext({ event: click(), href: "/hotspots/L1?returnTo=%2Ftrips%2F9", label: "Park", accountId: 1 });
		await Promise.resolve(); await Promise.resolve();
		f.page.url = new URL("https://birds.test/hotspots/L1"); f.page.state = {}; f.type = "navigate";
		vi.resetModules(); nav = await adapter();
		const fresh = nav.ensureCurrentNode({ accountId: 1, label: "Park" });
		expect(nav.trailFor(1, fresh?.id).nodes.map((n) => n.label)).toEqual(["Park"]);
	});
});
