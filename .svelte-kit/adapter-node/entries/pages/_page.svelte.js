import { h as head, e as escape_html, a as ensure_array_like, b as attr } from "../../chunks/index.js";
import { B as Badge } from "../../chunks/Badge.js";
import { f as formatKm } from "../../chunks/geo.js";
function _page($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    let { data } = $$props;
    head("1uha8ag", $$renderer2, ($$renderer3) => {
      $$renderer3.title(($$renderer4) => {
        $$renderer4.push(`<title>Near Me — birds</title>`);
      });
    });
    $$renderer2.push(`<div class="page svelte-1uha8ag"><header class="page-head svelte-1uha8ag"><h1 class="svelte-1uha8ag">Near Me</h1> <p class="sub svelte-1uha8ag">`);
    if (data.home) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`Home: ${escape_html(data.home.lat.toFixed(3))}, ${escape_html(data.home.lon.toFixed(3))} · radius ${escape_html(data.distKm)} km · <a href="/settings">change</a>`);
    } else {
      $$renderer2.push("<!--[-1-->");
      $$renderer2.push(`No home location saved — <a href="/settings">set it in Settings</a>`);
    }
    $$renderer2.push(`<!--]--></p></header> `);
    if (!data.hasApiKey) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<section class="card svelte-1uha8ag"><h2 class="svelte-1uha8ag">Get set up</h2> <p class="muted svelte-1uha8ag">Add your eBird API key in <a href="/settings">Settings</a> to see your needs reported nearby.</p></section>`);
    } else if (data.needsError) {
      $$renderer2.push("<!--[1-->");
      $$renderer2.push(`<section class="card svelte-1uha8ag"><h2 class="svelte-1uha8ag">Your needs reported nearby</h2> <p class="muted svelte-1uha8ag">${escape_html(data.needsError)}</p></section>`);
    } else if (data.home) {
      $$renderer2.push("<!--[2-->");
      $$renderer2.push(`<section class="card svelte-1uha8ag"><h2 class="svelte-1uha8ag">Your needs reported nearby — last ${escape_html(data.backDays)} days `);
      if (data.stale) {
        $$renderer2.push("<!--[0-->");
        Badge($$renderer2, { kind: "stale", label: "cached" });
      } else {
        $$renderer2.push("<!--[-1-->");
      }
      $$renderer2.push(`<!--]--></h2> `);
      if (data.needs.length === 0) {
        $$renderer2.push("<!--[0-->");
        $$renderer2.push(`<p class="muted svelte-1uha8ag">No unseen species reported within ${escape_html(data.distKm)} km this week. `);
        if (data.seenCount === 0) {
          $$renderer2.push("<!--[0-->");
          $$renderer2.push(`Import your life list in <a href="/settings">Settings</a> first —
						otherwise everything counts as a need.`);
        } else {
          $$renderer2.push("<!--[-1-->");
        }
        $$renderer2.push(`<!--]--></p>`);
      } else {
        $$renderer2.push("<!--[-1-->");
      }
      $$renderer2.push(`<!--]--> <!--[-->`);
      const each_array = ensure_array_like(data.needs);
      for (let $$index = 0, $$length = each_array.length; $$index < $$length; $$index++) {
        let n = each_array[$$index];
        $$renderer2.push(`<div class="obs svelte-1uha8ag"><div class="grow svelte-1uha8ag"><div class="name svelte-1uha8ag"><a${attr("href", `/species/${n.speciesCode}`)} class="svelte-1uha8ag">${escape_html(n.comName)}</a> `);
        Badge($$renderer2, { kind: "need", label: "Need" });
        $$renderer2.push(`<!----></div> <div class="meta svelte-1uha8ag">${escape_html(n.locations.join(" · "))} · ${escape_html(n.nReports)}
							${escape_html(n.nReports === 1 ? "report" : "reports")} · ${escape_html(n.totalCount)} birds</div></div> <div class="right svelte-1uha8ag">`);
        if (n.distanceKm != null) {
          $$renderer2.push("<!--[0-->");
          $$renderer2.push(`<div class="dist svelte-1uha8ag">${escape_html(formatKm(n.distanceKm))}</div>`);
        } else {
          $$renderer2.push("<!--[-1-->");
        }
        $$renderer2.push(`<!--]--> <div class="when svelte-1uha8ag">${escape_html(n.lastObsDt)}</div></div></div>`);
      }
      $$renderer2.push(`<!--]--></section>`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--> <section class="card svelte-1uha8ag"><h2 class="svelte-1uha8ag">At a glance</h2> <div class="obs svelte-1uha8ag"><div class="grow svelte-1uha8ag"><div class="name svelte-1uha8ag">Life list</div> <div class="meta svelte-1uha8ag">`);
    if (data.lifeListSyncedAt) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`synced from eBird ${escape_html(new Date(data.lifeListSyncedAt).toLocaleString())} `);
      if (data.lifeListStatus === "error") {
        $$renderer2.push("<!--[0-->");
        Badge($$renderer2, { kind: "notable", label: "sync error" });
      } else {
        $$renderer2.push("<!--[-1-->");
      }
      $$renderer2.push(`<!--]-->`);
    } else {
      $$renderer2.push("<!--[-1-->");
      $$renderer2.push(`not synced yet — <a href="/settings">Settings</a>`);
    }
    $$renderer2.push(`<!--]--></div></div> <div class="right svelte-1uha8ag"><div class="dist svelte-1uha8ag">${escape_html(data.seenCount)}</div></div></div> <div class="obs svelte-1uha8ag"><div class="grow svelte-1uha8ag"><div class="name svelte-1uha8ag">Photos on gaylon.photos</div> <div class="meta svelte-1uha8ag"><a href="/photos">My Photos</a></div></div> <div class="right svelte-1uha8ag"><div class="dist svelte-1uha8ag">${escape_html(data.photoCount)}</div></div></div></section> <p class="attribution svelte-1uha8ag">Data from <a href="https://ebird.org" target="_blank" rel="noopener" class="svelte-1uha8ag">eBird.org</a></p></div>`);
  });
}
export {
  _page as default
};
