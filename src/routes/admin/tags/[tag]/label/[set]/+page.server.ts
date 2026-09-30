import { error, fail } from "@sveltejs/kit";
import type { Actions, PageServerLoad } from "./$types";
import { ALL_TAGS } from "$lib/species-tags";
import { query } from "$lib/db";
import { nextLabelItem, revealItem } from "$server/tag-admin";
import { cueRanges } from "$server/tag-engine/eval-text";

/**
 * Blind labelling (td-894144 Release B4, plan rev 26 §B4h). One page at a
 * time: the masked article (fixed reading aid only), one fixed question,
 * three answers. No system output — no species name, stratum, rules result or
 * legacy value — until the answer is saved; then the bird is revealed for
 * context. Answers are write-once (the definer refuses a second answer).
 */
const ID = /^[1-9][0-9]{0,18}$/;

export const load: PageServerLoad = async ({ locals, params }) => {
  if (locals.user?.role !== "admin") throw error(404, "Not found");
  if (!ALL_TAGS.has(params.tag) || !ID.test(params.set))
    throw error(404, "Not found");
  const item = await nextLabelItem(params.tag, params.set);
  if (!item) {
    const exists = await query(
      "SELECT status FROM tag_eval_set WHERE id = $1 AND tag = $2",
      [params.set, params.tag],
    );
    if (!exists.rows[0]) throw error(404, "Not found");
    return {
      tag: params.tag,
      setId: params.set,
      closed: exists.rows[0].status as string,
      item: null,
      question: "",
    };
  }
  // Split text into plain / underlined runs server-side (the cue list is fixed per design).
  const toRuns = (text: string) => {
    const runs: { text: string; cue: boolean }[] = [];
    let at = 0;
    for (const [a, b] of cueRanges(text, item.cueWords)) {
      if (a > at) runs.push({ text: text.slice(at, a), cue: false });
      runs.push({ text: text.slice(a, b), cue: true });
      at = b;
    }
    if (at < text.length) runs.push({ text: text.slice(at), cue: false });
    return runs;
  };
  const sections = item.sections.map((s) => ({
    title: s.title,
    runs: toRuns(s.text),
  }));
  // The frozen family reference (td-894144 B5, plan §4 option b).
  const family = item.familyReference
    ? { title: item.familyReference.title, runs: toRuns(item.familyReference.displayLead) }
    : null;
  return {
    tag: params.tag,
    setId: params.set,
    closed: null,
    question: item.question,
    item: {
      itemId: item.itemId,
      total: item.total,
      labelled: item.labelled,
      sections,
      family,
      done: item.itemId === "",
    },
  };
};

export const actions: Actions = {
  answer: async ({ locals, params, request }) => {
    if (locals.user?.role !== "admin" || !locals.user)
      return fail(403, { ok: false as const, message: "Admins only." });
    if (!ALL_TAGS.has(params.tag) || !ID.test(params.set))
      return fail(404, { ok: false as const, message: "Unknown set." });
    const form = await request.formData();
    const itemId = String(form.get("itemId") ?? "");
    const label = String(form.get("label") ?? "");
    if (!ID.test(itemId) || !["yes", "no", "unsure"].includes(label))
      return fail(400, {
        ok: false as const,
        message: "Choose Yes, No or Unsure.",
      });
    const owns = await query(
      "SELECT 1 FROM tag_eval_set WHERE id = $1 AND tag = $2",
      [params.set, params.tag],
    );
    if (!owns.rows[0])
      return fail(404, { ok: false as const, message: "Unknown set." });
    try {
      await query("SELECT public.record_tag_eval_label($1, $2, $3, $4)", [
        params.set,
        itemId,
        locals.user.id,
        label,
      ]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      return fail(409, {
        ok: false as const,
        message: /write-once/.test(msg)
          ? "That page already has an answer (answers can't be changed)."
          : /not labelling/.test(msg)
            ? "This blind test is closed."
            : "The answer was not saved.",
      });
    }
    const bird = await revealItem(params.set, itemId);
    return { ok: true as const, revealed: bird?.name ?? null, answered: label };
  },
};
