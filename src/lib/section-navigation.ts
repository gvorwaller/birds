/**
 * Builds a same-page fragment URL without touching the path or its query.
 * Section controls use SvelteKit's replaceState with this value so the
 * navigation context stored in page.state remains the current history entry.
 */
export function sectionHref(
  pathname: string,
  search: string,
  sectionId: string,
): string {
  return `${pathname}${search}#${encodeURIComponent(sectionId)}`;
}

/** A normal primary-button click is safe to enhance; modifier clicks retain the native link. */
export function shouldEnhanceSectionLink(event: {
  button: number;
  defaultPrevented: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}): boolean {
  return (
    !event.defaultPrevented &&
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}
