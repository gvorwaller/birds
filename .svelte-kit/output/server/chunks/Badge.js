import { c as attr_class, e as escape_html, ab as stringify } from "./index.js";
function Badge($$renderer, $$props) {
  let { kind, label } = $$props;
  $$renderer.push(`<span${attr_class(`badge ${stringify(kind)}`, "svelte-dtbgkf")}>${escape_html(label)}</span>`);
}
export {
  Badge as B
};
