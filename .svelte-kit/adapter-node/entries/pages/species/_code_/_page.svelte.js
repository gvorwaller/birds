import { h as head, e as escape_html, a as ensure_array_like, b as attr, f as derived } from "../../../../chunks/index.js";
import { B as Badge } from "../../../../chunks/Badge.js";
import { f as formatKm } from "../../../../chunks/geo.js";
function _page($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    let { data } = $$props;
    const links = derived(() => [
      {
        label: "eBird species page ↗",
        sub: "range maps, bar charts, photos",
        href: `https://ebird.org/species/${data.taxon.species_code}`
      },
      {
        label: "All About Birds ↗",
        sub: "ID tips, life history",
        href: `https://www.allaboutbirds.org/guide/${data.taxon.com_name.replace(/\s+/g, "_")}`
      },
      {
        label: "Macaulay Library ↗",
        sub: "photos, audio, video",
        href: `https://search.macaulaylibrary.org/catalog?taxonCode=${data.taxon.species_code}`
      },
      {
        label: "xeno-canto ↗",
        sub: "sound recordings",
        href: `https://xeno-canto.org/explore?query=${encodeURIComponent(data.taxon.sci_name)}`
      }
    ]);
    head("1w64n7l", $$renderer2, ($$renderer3) => {
      $$renderer3.title(($$renderer4) => {
        $$renderer4.push(`<title>${escape_html(data.taxon.com_name)} — birds</title>`);
      });
    });
    $$renderer2.push(`<div class="page svelte-1w64n7l"><header class="page-head svelte-1w64n7l"><p class="sub svelte-1w64n7l"><a href="/targets">← Targets</a></p> <h1 class="svelte-1w64n7l">${escape_html(data.taxon.com_name)} `);
    if (data.seen) {
      $$renderer2.push("<!--[0-->");
      Badge($$renderer2, { kind: "seen", label: "Seen" });
    } else {
      $$renderer2.push("<!--[-1-->");
      Badge($$renderer2, { kind: "need", label: "Need" });
    }
    $$renderer2.push(`<!--]--></h1> <p class="sub svelte-1w64n7l"><em>${escape_html(data.taxon.sci_name)}</em> · eBird code <code class="svelte-1w64n7l">${escape_html(data.taxon.species_code)}</code> `);
    if (data.taxon.family) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`· ${escape_html(data.taxon.family)}`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--> `);
    if (data.seen?.first_seen) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`· first seen ${escape_html(data.seen.first_seen)}`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--></p></header> <section class="card svelte-1w64n7l"><h2 class="svelte-1w64n7l">Your photos <span class="muted svelte-1w64n7l">${escape_html(data.photos.length)} on gaylon.photos</span></h2> `);
    if (data.photos.length === 0) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<p class="muted svelte-1w64n7l">No photos of this species yet — new uploads to gaylon.photos appear after the next <a href="/photos">gallery sync</a>.</p>`);
    } else {
      $$renderer2.push("<!--[-1-->");
      $$renderer2.push(`<div class="strip svelte-1w64n7l"><!--[-->`);
      const each_array = ensure_array_like(data.photos);
      for (let $$index = 0, $$length = each_array.length; $$index < $$length; $$index++) {
        let p = each_array[$$index];
        $$renderer2.push(`<a${attr("href", p.page_url)} target="_blank" rel="noopener" class="svelte-1w64n7l"><img loading="lazy"${attr("src", p.thumbnail)}${attr("alt", data.taxon.com_name)} class="svelte-1w64n7l"/></a>`);
      }
      $$renderer2.push(`<!--]--></div>`);
    }
    $$renderer2.push(`<!--]--></section> <section class="card svelte-1w64n7l"><h2 class="svelte-1w64n7l">Recent reports near home — last ${escape_html(data.backDays)} days `);
    if (data.stale) {
      $$renderer2.push("<!--[0-->");
      Badge($$renderer2, { kind: "stale", label: "cached" });
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--></h2> `);
    if (!data.hasApiKey || !data.hasHome) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<p class="muted svelte-1w64n7l">Set your eBird API key and home location in <a href="/settings">Settings</a> to see nearby reports.</p>`);
    } else if (data.nearbyError) {
      $$renderer2.push("<!--[1-->");
      $$renderer2.push(`<p class="muted svelte-1w64n7l">${escape_html(data.nearbyError)}</p>`);
    } else if (data.nearby.length === 0) {
      $$renderer2.push("<!--[2-->");
      $$renderer2.push(`<p class="muted svelte-1w64n7l">No reports within ${escape_html(data.distKm)} km in this window.</p>`);
    } else {
      $$renderer2.push("<!--[-1-->");
      $$renderer2.push(`<!--[-->`);
      const each_array_1 = ensure_array_like(data.nearby);
      for (let $$index_1 = 0, $$length = each_array_1.length; $$index_1 < $$length; $$index_1++) {
        let o = each_array_1[$$index_1];
        $$renderer2.push(`<div class="obs svelte-1w64n7l"><div class="grow svelte-1w64n7l"><div class="name svelte-1w64n7l">${escape_html(o.locName)}</div> <div class="meta svelte-1w64n7l">${escape_html(o.howMany ?? 1)} ${escape_html((o.howMany ?? 1) === 1 ? "bird" : "birds")}</div></div> <div class="right svelte-1w64n7l">`);
        if (o.distanceKm != null) {
          $$renderer2.push("<!--[0-->");
          $$renderer2.push(`<div class="dist svelte-1w64n7l">${escape_html(formatKm(o.distanceKm))}</div>`);
        } else {
          $$renderer2.push("<!--[-1-->");
        }
        $$renderer2.push(`<!--]--> <div class="when svelte-1w64n7l">${escape_html(o.obsDt)}</div></div></div>`);
      }
      $$renderer2.push(`<!--]-->`);
    }
    $$renderer2.push(`<!--]--></section> <section class="card svelte-1w64n7l"><h2 class="svelte-1w64n7l">Learn more</h2> <!--[-->`);
    const each_array_2 = ensure_array_like(links());
    for (let $$index_2 = 0, $$length = each_array_2.length; $$index_2 < $$length; $$index_2++) {
      let l = each_array_2[$$index_2];
      $$renderer2.push(`<div class="obs svelte-1w64n7l"><div class="grow svelte-1w64n7l"><div class="name svelte-1w64n7l"><a${attr("href", l.href)} target="_blank" rel="noopener">${escape_html(l.label)}</a></div> <div class="meta svelte-1w64n7l">${escape_html(l.sub)}</div></div></div>`);
    }
    $$renderer2.push(`<!--]--></section> <p class="attribution svelte-1w64n7l">Data from <a href="https://ebird.org" target="_blank" rel="noopener" class="svelte-1w64n7l">eBird.org</a> · photos on <a href="https://gaylon.photos/birds" target="_blank" rel="noopener" class="svelte-1w64n7l">gaylon.photos</a></p></div>`);
  });
}
export {
  _page as default
};
