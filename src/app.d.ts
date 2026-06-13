// See https://svelte.dev/docs/kit/types#app
declare global {
	namespace App {
		interface Locals {
			user?: {
				id: number;
				username: string;
				role: 'admin';
				display_name: string;
			};
		}
	}

	// Injected by Vite `define` at build time (commit SHA, or 'dev' locally).
	const __GIT_SHA__: string;
}

export {};
