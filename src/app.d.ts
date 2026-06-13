// See https://svelte.dev/docs/kit/types#app
declare global {
	namespace App {
		interface Locals {
			user?: {
				id: number;
				username: string;
				role: 'admin' | 'viewer';
				display_name: string;
			};
			// The owner (admin) whose data every page reads. For the admin this is
			// their own id; for a viewer it points at the admin so they see the
			// owner's birds read-only.
			ownerId?: number;
		}
	}

	// Injected by Vite `define` at build time (commit SHA, or 'dev' locally).
	const __GIT_SHA__: string;
}

export {};
