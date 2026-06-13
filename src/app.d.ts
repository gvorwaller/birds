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
}

export {};
