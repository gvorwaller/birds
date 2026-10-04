import { error, fail } from "@sveltejs/kit";
import type { Actions, PageServerLoad } from "./$types";
import { ALL_TAGS } from "$lib/species-tags";
import { query } from "$lib/db";
import { nextLabelItem, revealItem } from "$server/tag-admin";
import { cueRanges } from "$server/tag-engine/eval-text";
import {
  OUTDATED_SET_MESSAGE,
  evalTextOutdated,
} from "$server/tag-engine/eval-design";

/**
 * Blind labelling (td-894144 Release B4, plan rev 26 §B4h). One page at a
 * time: the bird's names, its article and its family's article (fixed reading
 * aid only), one fixed question, three answers. Blind means NO system output:
 * no rules result, legacy value, matched rule, evidence or stratum. It does
 * not hide which bird is being judged (owner 2026-10-03). Answers are
 * write-once (the definer refuses a second answer). A set whose pages an
 * older text version rendered is never shown and takes no answers.
 */
const ID = /^[1-9][0-9]{0,18}$/;

/** The set's status, and whether a labelling set is outdated (older page text). */
async function setState(tag: string, setId: string) {
  const row = (
    await query<{ status: string; text_version: string | null }>(
      "SELECT status, design->>'evalTextVersion' AS text_version FROM tag_eval_set WHERE id = $1 AND tag = $2",
      [setId, tag],
    )
  ).rows[0];
  return row
    ? {
        status: row.status,
        outdated: row.status === "labelling" && evalTextOutdated(row.text_version),
      }
    : null;
}

export const load: PageServerLoad = async ({ locals, params }) => {
  if (locals.user?.role !== "admin") throw error(404, "Not found");
  if (!ALL_TAGS.has(params.tag) || !ID.test(params.set))
    throw error(404, "Not found");
  const item = await nextLabelItem(params.tag, params.set);
  if (!item) {
    // Closed, or outdated: nextLabelItem never returns an outdated set's pages.
    const set = await setState(params.tag, params.set);
    if (!set) throw error(404, "Not found");
    return {
      tag: params.tag,
      setId: params.set,
      closed: set.outdated ? null : set.status,
      outdated: set.outdated ? OUTDATED_SET_MESSAGE : null,
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
    outdated: null,
    question: item.question,
    item: {
      itemId: item.itemId,
      total: item.total,
      labelled: item.labelled,
      sections,
      family,
      bird: item.species,
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
    const set = await setState(params.tag, params.set);
    if (!set)
      return fail(404, { ok: false as const, message: "Unknown set." });
    // Its pages were rendered differently (before v3 they hid the bird's
    // name): an answer now would mix two page protocols in one set. The
    // design is immutable, so this cannot change before the definer runs.
    if (set.outdated)
      return fail(409, { ok: false as const, message: OUTDATED_SET_MESSAGE });
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
