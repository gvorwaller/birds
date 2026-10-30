// See https://svelte.dev/docs/kit/types#app
declare global {
	namespace App {
		interface PageState {
			birdsNavigation?: { accountId: number; nodeId: string };
			/** Hotspots & data: the address of live search results (td-a6f8a1). */
			hubHref?: string;
			/** The page.url those live results were shown over: a restore only
			 * applies to that entry, never to state a fresh navigation inherits. */
			hubBase?: string;
		}
		interface Locals {
			user?: {
				id: number;
				username: string;
				role: 'admin' | 'user' | 'viewer';
				display_name: string;
				views_user_id: number | null;
				theme: import('$lib/themes').ThemeId;
			};
			// The owner whose data this request READS. Self for normal users
			// (strict isolation); for the `family` viewer it points at the owner
			// they were linked to. Writes always use locals.user.id. See
			// $server/access → scopeOwnerId.
			scopeId?: number;
		}
	}

	// Injected by Vite `define` at build time (commit SHA, or 'dev' locally).
	const __GIT_SHA__: string;
}

export {};
