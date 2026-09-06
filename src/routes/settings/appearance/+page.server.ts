import { fail } from "@sveltejs/kit";
import type { Actions, PageServerLoad } from "./$types";
import { query } from "$lib/db";
import { isThemeId } from "$lib/themes";

export const load: PageServerLoad = ({ locals }) => ({
  theme: locals.user!.theme,
});
export const actions: Actions = {
  save_theme: async ({ locals, request }) => {
    const theme = (await request.formData()).get("theme");
    if (!isThemeId(theme))
      return fail(400, { error: "Choose one of the available themes." });
    await query("UPDATE users SET theme = $1 WHERE id = $2", [
      theme,
      locals.user!.id,
    ]);
    // The current response and its parent layout must see the new setting too.
    locals.user!.theme = theme;
    return { message: "Theme saved for your account." };
  },
};
