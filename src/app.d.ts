// See https://svelte.dev/docs/kit/types#app
declare global {
	namespace App {
		interface Locals {
			user?: {
				id: number;
				username: string;
				role: 'admin' | 'user' | 'viewer';
				display_name: string;
				views_user_id: number | null;
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
