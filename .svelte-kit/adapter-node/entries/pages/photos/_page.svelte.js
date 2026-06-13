import { h as head, e as escape_html, b as attr, a as ensure_array_like, f as derived } from "../../../chunks/index.js";
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
    let syncing = false;
    const unmatchedCount = derived(() => data.unmatched.reduce((n, u) => n + u.photos.length, 0));
    head("1pgek9m", $$renderer2, ($$renderer3) => {
      $$renderer3.title(($$renderer4) => {
        $$renderer4.push(`<title>My Photos — birds</title>`);
      });
    });
    $$renderer2.push(`<div class="page svelte-1pgek9m"><header class="page-head svelte-1pgek9m"><h1 class="svelte-1pgek9m">My Photos</h1> <p class="sub svelte-1pgek9m">${escape_html(data.total)} photos synced from <a href="https://gaylon.photos/birds" target="_blank" rel="noopener">gaylon.photos/birds</a> `);
    if (data.fetchedAt) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`· refreshed ${escape_html(new Date(data.fetchedAt).toLocaleString())}`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--></p></header> <section class="card toolbar svelte-1pgek9m"><form method="POST" action="?/refresh"><button type="submit"${attr("disabled", syncing, true)} class="svelte-1pgek9m">${escape_html("⟳ Refresh from gaylon.photos")}</button></form> <a class="btn svelte-1pgek9m" href="https://gaylon.photos/birds" target="_blank" rel="noopener">View full collection ↗</a> `);
    if (unmatchedCount() > 0) {
      $$renderer2.push("<!--[0-->");
      Badge($$renderer2, { kind: "unmatched", label: `${unmatchedCount()} unmatched` });
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--> <span class="muted note svelte-1pgek9m">No uploads here — photos live on gaylon.photos. New shots appear after the next sync.</span></section> `);
    if (form && "message" in form && form.message) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<section class="card svelte-1pgek9m"><p class="ok svelte-1pgek9m">${escape_html(form.message)}</p></section>`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--> `);
    if (form && "error" in form && form.error) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<section class="card svelte-1pgek9m"><p class="err svelte-1pgek9m" role="alert">${escape_html(form.error)}</p></section>`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--> `);
    if (data.total === 0) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<section class="card svelte-1pgek9m"><p class="muted svelte-1pgek9m">Nothing synced yet. Hit “Refresh from gaylon.photos” — and make sure the taxonomy is synced
				in <a href="/settings">Settings</a> so species names can be matched.</p></section>`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--> <!--[-->`);
    const each_array = ensure_array_like(data.groups);
    for (let $$index_1 = 0, $$length = each_array.length; $$index_1 < $$length; $$index_1++) {
      let g = each_array[$$index_1];
      $$renderer2.push(`<section class="card group svelte-1pgek9m"><div class="group-head svelte-1pgek9m"><h3 class="svelte-1pgek9m"><a${attr("href", `/species/${g.speciesCode}`)} class="svelte-1pgek9m">${escape_html(g.comName)}</a></h3> `);
      if (g.sciName) {
        $$renderer2.push("<!--[0-->");
        $$renderer2.push(`<span class="sci svelte-1pgek9m">${escape_html(g.sciName)}</span>`);
      } else {
        $$renderer2.push("<!--[-1-->");
      }
      $$renderer2.push(`<!--]--> <span class="count svelte-1pgek9m">${escape_html(g.photos.length)} ${escape_html(g.photos.length === 1 ? "photo" : "photos")}</span></div> <div class="grid svelte-1pgek9m"><!--[-->`);
      const each_array_1 = ensure_array_like(g.photos);
      for (let $$index = 0, $$length2 = each_array_1.length; $$index < $$length2; $$index++) {
        let p = each_array_1[$$index];
        $$renderer2.push(`<a${attr("href", p.page_url)} target="_blank" rel="noopener" class="svelte-1pgek9m"><img loading="lazy"${attr("src", p.thumbnail)}${attr("alt", g.comName)} class="svelte-1pgek9m"/></a>`);
      }
      $$renderer2.push(`<!--]--></div></section>`);
    }
    $$renderer2.push(`<!--]--> `);
    if (data.unmatched.length > 0) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<section class="card svelte-1pgek9m"><h2 class="svelte-1pgek9m">Unmatched photos `);
      Badge($$renderer2, { kind: "unmatched", label: "needs your help" });
      $$renderer2.push(`<!----></h2> <p class="muted intro svelte-1pgek9m">These names from gaylon.photos didn't match the eBird taxonomy. Pick the right species once
				— the override is remembered for future syncs.</p> <!--[-->`);
      const each_array_2 = ensure_array_like(data.unmatched);
      for (let $$index_3 = 0, $$length = each_array_2.length; $$index_3 < $$length; $$index_3++) {
        let u = each_array_2[$$index_3];
        $$renderer2.push(`<div class="group svelte-1pgek9m"><div class="group-head svelte-1pgek9m"><h3 class="svelte-1pgek9m">“${escape_html(u.name)}”</h3> <span class="count svelte-1pgek9m">${escape_html(u.photos.length)} ${escape_html(u.photos.length === 1 ? "photo" : "photos")}</span></div> <div class="grid small svelte-1pgek9m"><!--[-->`);
        const each_array_3 = ensure_array_like(u.photos);
        for (let $$index_2 = 0, $$length2 = each_array_3.length; $$index_2 < $$length2; $$index_2++) {
          let p = each_array_3[$$index_2];
          $$renderer2.push(`<a${attr("href", p.page_url)} target="_blank" rel="noopener" class="svelte-1pgek9m"><img loading="lazy"${attr("src", p.thumbnail)}${attr("alt", `Unmatched: ${u.name}`)} class="svelte-1pgek9m"/></a>`);
        }
        $$renderer2.push(`<!--]--></div> `);
        if (u.name !== "(no species set)") {
          $$renderer2.push("<!--[0-->");
          $$renderer2.push(`<form method="POST" action="?/override" class="override svelte-1pgek9m"><input type="hidden" name="source_name"${attr("value", u.name)}/> <input type="text" name="species" placeholder="Exact eBird common name, scientific name, or code…" required="" class="svelte-1pgek9m"/> <button type="submit" class="svelte-1pgek9m">Match species</button></form>`);
        } else {
          $$renderer2.push("<!--[-1-->");
          $$renderer2.push(`<p class="muted svelte-1pgek9m">Best fixed at the source — <a href="https://gaylon.photos/birds" target="_blank" rel="noopener">tag them on gaylon.photos ↗</a> and re-sync.</p>`);
        }
        $$renderer2.push(`<!--]--></div>`);
      }
      $$renderer2.push(`<!--]--></section>`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--> <p class="attribution svelte-1pgek9m">Photos hosted on <a href="https://gaylon.photos/birds" target="_blank" rel="noopener" class="svelte-1pgek9m">gaylon.photos</a> · species
		data from <a href="https://ebird.org" target="_blank" rel="noopener" class="svelte-1pgek9m">eBird.org</a></p></div>`);
  });
}
export {
  _page as default
};
