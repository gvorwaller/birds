export type TaxonomySort = "name" | "taxonomic";
export function taxonomyHref(
  family?: string | null,
  focus?: string,
  order?: string | null,
): string {
  const p = new URLSearchParams();
  if (family) p.set("family", family);
  if (focus) p.set("focus", focus);
  if (order) p.set("order", order);
  return "/taxonomy" + (p.size ? "?" + p : "");
}
