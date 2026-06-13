import { h as head, e as escape_html, b as attr, a as ensure_array_like } from "../../../chunks/index.js";
import "@sveltejs/kit/internal";
import "../../../chunks/exports.js";
import "../../../chunks/utils2.js";
import "@sveltejs/kit/internal/server";
import "../../../chunks/root.js";
import "../../../chunks/state.svelte.js";
import { B as Badge } from "../../../chunks/Badge.js";
function _page($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    let { data, form } = $$props;
    let busy = "";
    head("1i19ct2", $$renderer2, ($$renderer3) => {
      $$renderer3.title(($$renderer4) => {
        $$renderer4.push(`<title>Settings — birds</title>`);
      });
    });
    $$renderer2.push(`<div class="page svelte-1i19ct2"><header class="page-head svelte-1i19ct2"><h1 class="svelte-1i19ct2">Settings</h1> <p class="sub svelte-1i19ct2">eBird credentials, home location, and syncs</p></header> `);
    if (form && "message" in form && form.message) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<section class="card svelte-1i19ct2"><p class="ok svelte-1i19ct2">${escape_html(form.message)}</p></section>`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--> `);
    if (form && "error" in form && form.error) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<section class="card svelte-1i19ct2"><p class="err svelte-1i19ct2" role="alert">${escape_html(form.error)}</p></section>`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--> <section class="card svelte-1i19ct2"><h2 class="svelte-1i19ct2">eBird API key `);
    if (data.ebird.api_key_set) {
      $$renderer2.push("<!--[0-->");
      Badge($$renderer2, { kind: "seen", label: "saved" });
    } else {
      $$renderer2.push("<!--[-1-->");
      Badge($$renderer2, { kind: "need", label: "missing" });
    }
    $$renderer2.push(`<!--]--></h2> <p class="muted svelte-1i19ct2">Free personal key from <a href="https://ebird.org/api/keygen" target="_blank" rel="noopener">ebird.org/api/keygen</a>.
			Stored encrypted; used for taxonomy, recent observations, and notables.</p> <form method="POST" action="?/save_api_key" class="svelte-1i19ct2"><input type="password" name="api_key"${attr("placeholder", data.ebird.api_key_set ? "•••••••• (saved — enter to replace)" : "eBird API key")} autocomplete="off" class="svelte-1i19ct2"/> <button type="submit"${attr("disabled", busy === "key", true)} class="svelte-1i19ct2">Save key</button></form></section> <section class="card svelte-1i19ct2"><h2 class="svelte-1i19ct2">eBird account (life-list sync) `);
    if (data.ebird.login_set) {
      $$renderer2.push("<!--[0-->");
      Badge($$renderer2, { kind: "seen", label: "saved" });
    } else {
      $$renderer2.push("<!--[-1-->");
      Badge($$renderer2, { kind: "need", label: "missing" });
    }
    $$renderer2.push(`<!--]--></h2> <p class="muted svelte-1i19ct2">Your eBird sign-in, stored encrypted, used only to fetch your life list (the public API has no
			life-list endpoint). This rides eBird's website login — if Cornell changes it, the sync fails
			soft and your last synced list keeps working.</p> <form method="POST" action="?/save_login" class="svelte-1i19ct2"><input type="text" name="ebird_username" placeholder="eBird username" autocomplete="off" autocapitalize="none" class="svelte-1i19ct2"/> <input type="password" name="ebird_password" placeholder="eBird password" autocomplete="off" class="svelte-1i19ct2"/> <button type="submit"${attr("disabled", busy === "login", true)} class="svelte-1i19ct2">Save credentials</button></form> <div class="syncrow svelte-1i19ct2"><form method="POST" action="?/sync_lifelist" class="svelte-1i19ct2"><button type="submit"${attr("disabled", !data.ebird.login_set, true)} class="svelte-1i19ct2">${escape_html("⟳ Sync life list now")}</button></form> <span class="muted svelte-1i19ct2">`);
    if (data.ebird.life_list_synced_at) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`last sync ${escape_html(new Date(data.ebird.life_list_synced_at).toLocaleString())} `);
      if (data.ebird.life_list_status === "error") {
        $$renderer2.push("<!--[0-->");
        Badge($$renderer2, { kind: "notable", label: "error" });
        $$renderer2.push(`<!----> ${escape_html(data.ebird.life_list_error)}`);
      } else {
        $$renderer2.push("<!--[-1-->");
      }
      $$renderer2.push(`<!--]-->`);
    } else {
      $$renderer2.push("<!--[-1-->");
      $$renderer2.push(`never synced`);
    }
    $$renderer2.push(`<!--]--></span></div> <details class="svelte-1i19ct2"><summary class="svelte-1i19ct2">Fallback: import a CSV instead</summary> <p class="muted svelte-1i19ct2">eBird → My eBird → Download my data, or a life-list export. Replaces the synced list.</p> <form method="POST" action="?/import_csv" enctype="multipart/form-data" class="svelte-1i19ct2"><input type="file" name="csv" accept=".csv,text/csv" class="svelte-1i19ct2"/> <button type="submit"${attr("disabled", busy === "csv", true)} class="svelte-1i19ct2">Import CSV</button></form></details></section> <section class="card svelte-1i19ct2"><h2 class="svelte-1i19ct2">Home location</h2> <p class="muted svelte-1i19ct2">Used for distances and the Near Me view.</p> <form method="POST" action="?/save_home" class="svelte-1i19ct2"><input type="text" name="home_lat" inputmode="decimal" placeholder="Latitude"${attr("value", data.home.home_lat ?? "")} class="svelte-1i19ct2"/> <input type="text" name="home_lon" inputmode="decimal" placeholder="Longitude"${attr("value", data.home.home_lon ?? "")} class="svelte-1i19ct2"/> <button type="submit"${attr("disabled", busy === "home", true)} class="svelte-1i19ct2">Save home</button></form></section> <section class="card svelte-1i19ct2"><h2 class="svelte-1i19ct2">Data &amp; syncs</h2> <div class="obs svelte-1i19ct2"><div class="grow svelte-1i19ct2"><div class="name svelte-1i19ct2">eBird taxonomy</div> <div class="meta svelte-1i19ct2">${escape_html(data.taxonomyCount)} taxa cached — needed for species matching. Re-sync quarterly.</div></div> <form method="POST" action="?/sync_taxonomy" class="svelte-1i19ct2"><button type="submit"${attr("disabled", !data.ebird.api_key_set, true)} class="svelte-1i19ct2">${escape_html("⟳ Sync")}</button></form></div> <div class="obs svelte-1i19ct2"><div class="grow svelte-1i19ct2"><div class="name svelte-1i19ct2">Life list</div> <div class="meta svelte-1i19ct2">`);
    const each_array = ensure_array_like(data.seenBySource);
    if (each_array.length !== 0) {
      $$renderer2.push("<!--[-->");
      for (let $$index = 0, $$length = each_array.length; $$index < $$length; $$index++) {
        let s = each_array[$$index];
        $$renderer2.push(`<!---->${escape_html(s.n)} via ${escape_html(s.source)} `);
      }
    } else {
      $$renderer2.push("<!--[!-->");
      $$renderer2.push(`<!---->empty`);
    }
    $$renderer2.push(`<!--]--></div></div></div> <div class="obs svelte-1i19ct2"><div class="grow svelte-1i19ct2"><div class="name svelte-1i19ct2">Gallery links (gaylon.photos)</div> <div class="meta svelte-1i19ct2">${escape_html(data.photoTotal)} photos, ${escape_html(data.photoMatched)} matched to species</div></div> <form method="POST" action="?/sync_gallery" class="svelte-1i19ct2"><button type="submit"${attr("disabled", busy === "gallery", true)} class="svelte-1i19ct2">${escape_html("⟳ Sync")}</button></form></div></section> <section class="card svelte-1i19ct2"><h2 class="svelte-1i19ct2">Session</h2> <form method="POST" action="/login?/logout" class="svelte-1i19ct2"><button type="submit" class="danger svelte-1i19ct2">Sign out</button></form></section></div>`);
  });
}
export {
  _page as default
};
