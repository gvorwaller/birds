/**
 * Field Guide sections share the primary navigation highlight. Species
 * detail pages remain separate from the browse/study sections.
 */
export function isFieldGuideActive(path: string): boolean {
	return path === '/taxonomy' || path === '/taxonomy/' || path === '/species' || path === '/species/' || path === '/viewed' || path === '/viewed/';
}
