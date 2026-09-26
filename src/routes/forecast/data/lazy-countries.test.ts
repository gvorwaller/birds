/**
 * td-b6be76: Hotspots & data ships each country's SUMMARY and loads its
 * state/region groups when the country is opened. Reads the prod-sized
 * birds_test snapshot (no writes).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { query } from "$lib/db";
import { _hubData, load } from "./+page.server";
import { GET } from "../../api/hub-country/+server";

const dbUp = await query("SELECT 1")
  .then(() => true)
  .catch(() => false);
const page = readFileSync(new URL("./+page.svelte", import.meta.url), "utf8");
const server = readFileSync(new URL("./+page.server.ts", import.meta.url), "utf8");
const endpoint = readFileSync(new URL("../../api/hub-country/+server.ts", import.meta.url), "utf8");

type Section = { countryCode: string; groups: { stateCode: string }[]; groupCount: number };

async function owner(): Promise<number> {
  return (await query<{ id: number }>("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1")).rows[0].id;
}
const event = (id: number, path: string) =>
  ({ locals: { scopeId: id, user: { id, role: "admin" } }, depends: () => {}, url: new URL(`http://localhost${path}`) }) as never;

describe.runIf(dbUp)("country groups ship on demand", () => {
  it("a plain visit ships no nested groups, only counts, and is far smaller", async () => {
    const id = await owner();
    const data = (await load(event(id, "/forecast/data"))) as { countrySections: Section[] };
    const withGroups = data.countrySections.filter((s) => s.groups.length > 0);
    expect(withGroups).toEqual([]);
    expect(data.countrySections.some((s) => s.groupCount > 0)).toBe(true);
    expect(JSON.stringify(data.countrySections).length).toBeLessThan(300_000);
  });

  it("the endpoint returns exactly the groups the full loader builds for that country", async () => {
    const id = await owner();
    const plain = (await load(event(id, "/forecast/data"))) as { countrySections: Section[] };
    const target = plain.countrySections.find((s) => s.groupCount > 1)!;
    const full = (await _hubData(event(id, "/forecast/data"), { expand: target.countryCode })) as {
      countrySections: Section[];
    };
    const expanded = full.countrySections.find((s) => s.countryCode === target.countryCode)!;
    expect(expanded.groups).toHaveLength(target.groupCount);
    const res = await (GET as unknown as (e: unknown) => Promise<Response>)({
      locals: { scopeId: id, user: { id, role: "admin" } },
      url: new URL(`http://localhost/api/hub-country?country=${target.countryCode.toLowerCase()}`),
    });
    const body = (await res.json()) as { groups: { stateCode: string }[] };
    expect(body.groups.map((g) => g.stateCode)).toEqual(expanded.groups.map((g) => g.stateCode));
  });

  it("a ?show= landing still ships its own country's groups so the chain renders", async () => {
    const id = await owner();
    const plain = (await load(event(id, "/forecast/data"))) as { countrySections: Section[] };
    const target = plain.countrySections.find((s) => s.groupCount > 0)!;
    const landing = (await load(event(id, `/forecast/data?show=${target.countryCode}`))) as {
      countrySections: Section[];
    };
    const sec = landing.countrySections.find((s) => s.countryCode === target.countryCode)!;
    expect(sec.groups).toHaveLength(target.groupCount);
    expect(landing.countrySections.filter((s) => s.countryCode !== target.countryCode && s.groups.length > 0)).toEqual([]);
  });

  it("rejects a bad or repeated country and requires a session", async () => {
    const id = await owner();
    const call = async (q: string, locals: unknown = { scopeId: id, user: { id, role: "admin" } }) => {
      try {
        const r = await (GET as unknown as (e: unknown) => Promise<Response>)({ locals, url: new URL(`http://localhost/api/hub-country?${q}`) });
        return r.status;
      } catch (err) {
        return (err as { status?: number }).status ?? 500;
      }
    };
    expect(await call("country=US", {})).toBe(401);
    expect(await call("country=US-FL")).toBe(400);
    expect(await call("country=NO&country=SE")).toBe(400);
    expect(await call("")).toBe(400);
  });
});

describe("page wiring", () => {
  it("summaries use groupCount, and opening a country fetches its groups", () => {
    expect(page).toContain("parts.push(`${s.groupCount} state${s.groupCount === 1 ? \"\" : \"s\"}`);");
    expect(page).toContain("(sum, country) => sum + country.groupCount,");
    expect(page).toContain("fetch(`/api/hub-country?country=${encodeURIComponent(code)}`)");
    expect(page).toContain("{#each groupsOf(s) as g (g.stateCode)}");
    expect(page).toMatch(/Couldn't load \{s\.countryName\}'s regions\./);
    expect(page).not.toMatch(/sec\.groups\.map|x\.groups\)\.find/);
  });

  it("does not start page-only species aggregation for a country request", () => {
    expect(endpoint).toContain('import { _hubCountryGroups } from "../../forecast/data/+page.server";');
    expect(endpoint).not.toContain("_hubData(");
    // One shared build of every country's groups, not one per request (the
    // parallel per-country builds pushed production past 600 MB, 2026-09-26).
    expect(server).toMatch(/export async function _hubCountryGroups[\s\S]*?hubInventoryData\(event, \{ expand: "\*" \}\)/);
    expect(server).toContain("if (countryGroupsCache?.revision !== revision) {");
    expect(server).toMatch(/export async function _hubData[\s\S]*?streamed\(loadedSpeciesCounts\(\)/);
  });

  it("invalidates fetched country groups with same-route server data", () => {
    expect(page).toContain("if (data === countryGroupsData) return;");
    expect(page).toContain("countryGroupsFetched.clear();");
    expect(page).toContain("const source = data;");
    expect(page).toContain("if (data !== source) return;");
  });
});
