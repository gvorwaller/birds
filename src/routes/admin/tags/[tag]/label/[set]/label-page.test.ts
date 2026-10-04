/**
 * Blind labelling page (plan rev 26 §B4h): admin only, the bird named but no
 * system output in the loaded page (owner 2026-10-03), write-once answers
 * surfaced plainly. A set made before the pages named the bird (no recorded
 * text version) shows no page and takes no answer.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EVAL_TEXT_VERSION } from "$server/tag-engine/eval-design";

const sqlCalls: { text: string; params: unknown[] }[] = [];
let labelError: Error | null = null;
let setRow: Record<string, unknown> | null = null;
vi.mock("$lib/db", () => ({
  query: async (text: string, params: unknown[] = []) => {
    sqlCalls.push({ text, params });
    if (text.includes("record_tag_eval_label") && labelError) throw labelError;
    if (text.includes("FROM tag_eval_set"))
      return { rows: setRow ? [setRow] : [] };
    return { rows: [] };
  },
}));
const m = vi.hoisted(() => ({ nextLabelItem: vi.fn(), revealItem: vi.fn() }));
vi.mock("$server/tag-admin", () => m);

import { actions, load } from "./+page.server";

const TAG = "habitat:open-ocean";
const ADMIN = {
  locals: { user: { id: 1, role: "admin" } },
  params: { tag: TAG, set: "5" },
};
const req = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return new Request("http://localhost/x", { method: "POST", body: fd });
};

beforeEach(() => {
  m.nextLabelItem.mockReset();
  m.revealItem.mockReset();
  labelError = null;
  setRow = { status: "labelling", text_version: EVAL_TEXT_VERSION };
  sqlCalls.length = 0;
});

describe("label page", () => {
  it("404s for non-admins and bad ids", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const l = load as any;
    await expect(
      l({
        locals: { user: { id: 2, role: "viewer" } },
        params: { tag: TAG, set: "5" },
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      l({ ...ADMIN, params: { tag: TAG, set: "x" } }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("the loaded page names the bird and carries text, question and progress — no stratum, rules, legacy value or evidence", async () => {
    m.nextLabelItem.mockResolvedValue({
      setId: "5",
      itemId: "77",
      position: 3,
      total: 10,
      labelled: 2,
      sections: [{ title: "", text: "It feeds far out at sea." }], question: "Q?",
      cueWords: ["sea"],
      familyReference: null,
      species: { comName: "Northern Fulmar", sciName: "Fulmarus glacialis" },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d = await (load as any)(ADMIN);
    expect(d.item.bird).toEqual({ comName: "Northern Fulmar", sciName: "Fulmarus glacialis" });
    expect(JSON.stringify(d)).not.toMatch(
      /stratum|rules|legacy|evidence|assigned|matched/i,
    );
    expect(d.item.sections[0].runs).toEqual([
      { text: "It feeds far out at ", cue: false },
      { text: "sea", cue: true },
      { text: ".", cue: false },
    ]);
    expect(d.question).toBe("Q?");
  });

  it("an answer is saved through the definer, then the bird is revealed", async () => {
    m.revealItem.mockResolvedValue({ name: "Northern Fulmar", code: "norful" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await (actions as any).answer({
      ...ADMIN,
      request: req({ itemId: "77", label: "yes" }),
    });
    expect(r).toEqual({
      ok: true,
      revealed: "Northern Fulmar",
      answered: "yes",
    });
    expect(
      sqlCalls.find((c) => c.text.includes("record_tag_eval_label"))?.params,
    ).toEqual(["5", "77", 1, "yes"]);
  });

  it("a second answer to the same page is refused plainly; bad input is refused", async () => {
    labelError = new Error(
      "label: this page is already labelled (labels are write-once)",
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = (await (actions as any).answer({
      ...ADMIN,
      request: req({ itemId: "77", label: "no" }),
    })) as { status: number; data: { message: string } };
    expect(r.status).toBe(409);
    expect(r.data.message).toMatch(/can't be changed/);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b = (await (actions as any).answer({
      ...ADMIN,
      request: req({ itemId: "77", label: "maybe" }),
    })) as { status: number };
    expect(b.status).toBe(400);
  });

  it("a set made before the pages named the bird shows no page and says to start a new one", async () => {
    // nextLabelItem never returns such a set's pages.
    m.nextLabelItem.mockResolvedValue(null);
    for (const text_version of [null, "evaltext-v2"]) {
      setRow = { status: "labelling", text_version };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const d = await (load as any)(ADMIN);
      expect(d).toMatchObject({ item: null, closed: null });
      expect(d.outdated).toMatch(/before its pages named the bird.*start a new blind test/);
    }
    // A closed set keeps its plain "closed" page.
    setRow = { status: "abandoned", text_version: null };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c = await (load as any)(ADMIN);
    expect(c).toMatchObject({ item: null, closed: "abandoned", outdated: null });
    setRow = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect((load as any)(ADMIN)).rejects.toMatchObject({ status: 404 });
  });

  it("a set made before the pages named the bird refuses an answer before the definer", async () => {
    setRow = { status: "labelling", text_version: null };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = (await (actions as any).answer({
      ...ADMIN,
      request: req({ itemId: "77", label: "yes" }),
    })) as { status: number; data: { message: string } };
    expect(r.status).toBe(409);
    expect(r.data.message).toMatch(/before its pages named the bird/);
    expect(sqlCalls.some((c) => c.text.includes("record_tag_eval_label"))).toBe(false);
    expect(m.revealItem).not.toHaveBeenCalled();
  });
});
