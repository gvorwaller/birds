import { h as head, b as attr, a as ensure_array_like, e as escape_html, f as derived } from "../../../chunks/index.js";
import { B as Badge } from "../../../chunks/Badge.js";
import { f as formatKm } from "../../../chunks/geo.js";
function _page($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    let { data } = $$props;
    const NEEDS_PREVIEW = 25;
    let needsShown = derived(() => data.view ? data.view.needs.slice(0, NEEDS_PREVIEW) : []);
    head("105xjnh", $$renderer2, ($$renderer3) => {
      $$renderer3.title(($$renderer4) => {
        $$renderer4.push(`<title>Targets — birds</title>`);
      });
    });
    $$renderer2.push(`<div class="page svelte-105xjnh"><header class="page-head svelte-105xjnh"><h1 class="svelte-105xjnh">Targets</h1> <p class="sub svelte-105xjnh">Your needs for a region, with live recent activity</p></header> <section class="card svelte-105xjnh"><form method="GET" class="filters svelte-105xjnh"><label class="svelte-105xjnh"><span>Region code</span> <input type="text" name="region"${attr("value", data.region)} list="region-presets" autocapitalize="characters" autocorrect="off" spellcheck="false" class="svelte-105xjnh"/> <datalist id="region-presets"><!--[-->`);
    const each_array = ensure_array_like(data.presets);
    for (let $$index = 0, $$length = each_array.length; $$index < $$length; $$index++) {
      let p = each_array[$$index];
      $$renderer2.option({ value: p.code }, ($$renderer3) => {
        $$renderer3.push(`${escape_html(p.label)}`);
      });
    }
    $$renderer2.push(`<!--]--></datalist></label> <label class="svelte-105xjnh"><span>Window</span> <select name="back" class="svelte-105xjnh"><!--[-->`);
    const each_array_1 = ensure_array_like([7, 14, 30]);
    for (let $$index_1 = 0, $$length = each_array_1.length; $$index_1 < $$length; $$index_1++) {
      let d = each_array_1[$$index_1];
      $$renderer2.option({ value: d, selected: data.back === d }, ($$renderer3) => {
        $$renderer3.push(`Last ${escape_html(d)} days`);
      });
    }
    $$renderer2.push(`<!--]--></select></label> <button type="submit" class="svelte-105xjnh">Load</button></form></section> `);
    if (data.error) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<section class="card svelte-105xjnh"><p class="muted svelte-105xjnh">${escape_html(data.error)} <a href="/settings">Settings</a></p></section>`);
    } else if (data.view) {
      $$renderer2.push("<!--[1-->");
      $$renderer2.push(`<section class="card svelte-105xjnh"><h2 class="svelte-105xjnh">Rare this week `);
      Badge($$renderer2, { kind: "notable", label: "Notable" });
      $$renderer2.push(`<!----> `);
      if (data.view.stale) {
        $$renderer2.push("<!--[0-->");
        Badge($$renderer2, { kind: "stale", label: "cached" });
      } else {
        $$renderer2.push("<!--[-1-->");
      }
      $$renderer2.push(`<!--]--></h2> <p class="muted intro svelte-105xjnh">eBird notable reports in ${escape_html(data.region)} — last ${escape_html(data.back)} days, whether or not they're on
				your needs list.</p> `);
      if (data.view.notable.length === 0) {
        $$renderer2.push("<!--[0-->");
        $$renderer2.push(`<p class="muted svelte-105xjnh">No notable reports in this window.</p>`);
      } else {
        $$renderer2.push("<!--[-1-->");
      }
      $$renderer2.push(`<!--]--> <!--[-->`);
      const each_array_2 = ensure_array_like(data.view.notable);
      for (let $$index_2 = 0, $$length = each_array_2.length; $$index_2 < $$length; $$index_2++) {
        let n = each_array_2[$$index_2];
        $$renderer2.push(`<div class="obs svelte-105xjnh"><div class="grow svelte-105xjnh"><div class="name svelte-105xjnh"><a${attr("href", `/species/${n.speciesCode}`)} class="svelte-105xjnh">${escape_html(n.comName)}</a> `);
        Badge($$renderer2, { kind: "notable", label: "Notable" });
        $$renderer2.push(`<!----> `);
        if (n.seen) {
          $$renderer2.push("<!--[0-->");
          Badge($$renderer2, { kind: "seen", label: "Seen" });
        } else {
          $$renderer2.push("<!--[-1-->");
          Badge($$renderer2, { kind: "need", label: "Need" });
        }
        $$renderer2.push(`<!--]--></div> <div class="meta svelte-105xjnh">${escape_html(n.locations.join(" · "))} `);
        if (n.photoCount > 0) {
          $$renderer2.push("<!--[0-->");
          $$renderer2.push(`· 📷 you have ${escape_html(n.photoCount)}
								${escape_html(n.photoCount === 1 ? "photo" : "photos")}`);
        } else {
          $$renderer2.push("<!--[-1-->");
        }
        $$renderer2.push(`<!--]--></div></div> <div class="right svelte-105xjnh"><div class="dist svelte-105xjnh">${escape_html(n.nReports)} ×</div> <div class="when svelte-105xjnh">${escape_html(n.lastObsDt)}</div></div></div>`);
      }
      $$renderer2.push(`<!--]--></section> <section class="card svelte-105xjnh"><h2 class="svelte-105xjnh">${escape_html(data.view.needs.length)} needs reported in ${escape_html(data.region)} — last ${escape_html(data.back)} days</h2> `);
      if (data.view.seenCount === 0) {
        $$renderer2.push("<!--[0-->");
        $$renderer2.push(`<p class="muted svelte-105xjnh">Your life list is empty, so every species counts as a need. Sync it in <a href="/settings">Settings</a>.</p>`);
      } else {
        $$renderer2.push("<!--[-1-->");
      }
      $$renderer2.push(`<!--]--> <!--[-->`);
      const each_array_3 = ensure_array_like(needsShown());
      for (let $$index_3 = 0, $$length = each_array_3.length; $$index_3 < $$length; $$index_3++) {
        let n = each_array_3[$$index_3];
        $$renderer2.push(`<div class="obs svelte-105xjnh"><div class="grow svelte-105xjnh"><div class="name svelte-105xjnh"><a${attr("href", `/species/${n.speciesCode}`)} class="svelte-105xjnh">${escape_html(n.comName)}</a> `);
        Badge($$renderer2, { kind: "need", label: "Need" });
        $$renderer2.push(`<!----></div> <div class="meta svelte-105xjnh">${escape_html(n.nReports)}
							${escape_html(n.nReports === 1 ? "report" : "reports")} · ${escape_html(n.locations.join(" · "))} `);
        if (n.distanceKm != null) {
          $$renderer2.push("<!--[0-->");
          $$renderer2.push(`· ${escape_html(formatKm(n.distanceKm))} from home`);
        } else {
          $$renderer2.push("<!--[-1-->");
        }
        $$renderer2.push(`<!--]--> `);
        if (n.photoCount === 0) {
          $$renderer2.push("<!--[0-->");
          $$renderer2.push(`· 📷 no photo yet`);
        } else {
          $$renderer2.push("<!--[-1-->");
        }
        $$renderer2.push(`<!--]--></div></div> <div class="right svelte-105xjnh"><div class="dist svelte-105xjnh">${escape_html(n.nReports)} ×</div> <div class="when svelte-105xjnh">${escape_html(n.lastObsDt)}</div></div></div>`);
      }
      $$renderer2.push(`<!--]--> `);
      if (data.view.needs.length > NEEDS_PREVIEW) {
        $$renderer2.push("<!--[0-->");
        $$renderer2.push(`<button class="more svelte-105xjnh">${escape_html(`Show all ${data.view.needs.length} needs`)}</button>`);
      } else {
        $$renderer2.push("<!--[-1-->");
      }
      $$renderer2.push(`<!--]--></section>`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--> <p class="attribution svelte-105xjnh">Data from <a href="https://ebird.org" target="_blank" rel="noopener" class="svelte-105xjnh">eBird.org</a></p></div>`);
  });
}
export {
  _page as default
};
