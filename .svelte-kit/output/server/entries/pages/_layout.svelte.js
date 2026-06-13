import { g as getContext, a as ensure_array_like, b as attr, c as attr_class, d as store_get, e as escape_html, u as unsubscribe_stores } from "../../chunks/index.js";
import "clsx";
import "@sveltejs/kit/internal";
import "../../chunks/exports.js";
import "../../chunks/utils2.js";
import "@sveltejs/kit/internal/server";
import "../../chunks/root.js";
import "../../chunks/state.svelte.js";
const getStores = () => {
  const stores$1 = getContext("__svelte__");
  return {
    /** @type {typeof page} */
    page: {
      subscribe: stores$1.page.subscribe
    },
    /** @type {typeof navigating} */
    navigating: {
      subscribe: stores$1.navigating.subscribe
    },
    /** @type {typeof updated} */
    updated: stores$1.updated
  };
};
const page = {
  subscribe(fn) {
    const store = getStores().page;
    return store.subscribe(fn);
  }
};
function _layout($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    var $$store_subs;
    let { data, children } = $$props;
    const items = [
      { href: "/", label: "Home", ico: "🏠" },
      { href: "/targets", label: "Targets", ico: "🔭" },
      { href: "/trips", label: "Trips", ico: "🗺️" },
      { href: "/photos", label: "Photos", ico: "📷" }
    ];
    function isActive(href, path) {
      return href === "/" ? path === "/" : path.startsWith(href);
    }
    if (data.user) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<nav class="top-nav svelte-12qhfyh"><a class="brand svelte-12qhfyh" href="/"><span>🪶</span> birds</a> <div class="links svelte-12qhfyh"><!--[-->`);
      const each_array = ensure_array_like(items);
      for (let $$index = 0, $$length = each_array.length; $$index < $$length; $$index++) {
        let item = each_array[$$index];
        $$renderer2.push(`<a${attr("href", item.href)}${attr_class("svelte-12qhfyh", void 0, {
          "active": isActive(item.href, store_get($$store_subs ??= {}, "$page", page).url.pathname)
        })}>${escape_html(item.label)}</a>`);
      }
      $$renderer2.push(`<!--]--></div> <div class="spacer svelte-12qhfyh"></div> <a${attr_class("settings svelte-12qhfyh", void 0, {
        "active": store_get($$store_subs ??= {}, "$page", page).url.pathname.startsWith("/settings")
      })} href="/settings">⚙ Settings</a></nav>`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--> <main${attr_class("svelte-12qhfyh", void 0, { "with-nav": !!data.user })}>`);
    children($$renderer2);
    $$renderer2.push(`<!----></main> `);
    if (data.user) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<nav class="bottom-nav svelte-12qhfyh"><!--[-->`);
      const each_array_1 = ensure_array_like(items);
      for (let $$index_1 = 0, $$length = each_array_1.length; $$index_1 < $$length; $$index_1++) {
        let item = each_array_1[$$index_1];
        $$renderer2.push(`<a${attr("href", item.href)}${attr_class("svelte-12qhfyh", void 0, {
          "active": isActive(item.href, store_get($$store_subs ??= {}, "$page", page).url.pathname)
        })}><span class="ico svelte-12qhfyh">${escape_html(item.ico)}</span>${escape_html(item.label)}</a>`);
      }
      $$renderer2.push(`<!--]--></nav>`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]-->`);
    if ($$store_subs) unsubscribe_stores($$store_subs);
  });
}
export {
  _layout as default
};
