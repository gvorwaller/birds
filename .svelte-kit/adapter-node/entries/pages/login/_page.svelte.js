import { h as head, b as attr, e as escape_html } from "../../../chunks/index.js";
import "@sveltejs/kit/internal";
import "../../../chunks/exports.js";
import "../../../chunks/utils2.js";
import "@sveltejs/kit/internal/server";
import "../../../chunks/root.js";
import "../../../chunks/state.svelte.js";
function _page($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    let { form } = $$props;
    let submitting = false;
    head("1x05zx6", $$renderer2, ($$renderer3) => {
      $$renderer3.title(($$renderer4) => {
        $$renderer4.push(`<title>Sign in — birds</title>`);
      });
    });
    $$renderer2.push(`<div class="login svelte-1x05zx6"><div class="card svelte-1x05zx6"><h1 class="svelte-1x05zx6">🪶 birds</h1> <p class="subtitle svelte-1x05zx6">Sign in to continue.</p> <form method="POST" action="?/login" novalidate="" class="svelte-1x05zx6"><label class="svelte-1x05zx6"><span class="svelte-1x05zx6">Username</span> <input type="text" name="username" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" required=""${attr("value", form?.username ?? "")} class="svelte-1x05zx6"/></label> <label class="svelte-1x05zx6"><span class="svelte-1x05zx6">Password</span> <input type="password" name="password" autocomplete="current-password" required="" class="svelte-1x05zx6"/></label> `);
    if (form?.error) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<p class="error svelte-1x05zx6" role="alert">${escape_html(form.error)}</p>`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--> <button type="submit"${attr("disabled", submitting, true)} class="svelte-1x05zx6">${escape_html("Sign in")}</button></form></div></div>`);
  });
}
export {
  _page as default
};
