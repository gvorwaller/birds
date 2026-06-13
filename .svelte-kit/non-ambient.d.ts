
// this file is generated — do not edit it


declare module "svelte/elements" {
	export interface HTMLAttributes<T> {
		'data-sveltekit-keepfocus'?: true | '' | 'off' | undefined | null;
		'data-sveltekit-noscroll'?: true | '' | 'off' | undefined | null;
		'data-sveltekit-preload-code'?:
			| true
			| ''
			| 'eager'
			| 'viewport'
			| 'hover'
			| 'tap'
			| 'off'
			| undefined
			| null;
		'data-sveltekit-preload-data'?: true | '' | 'hover' | 'tap' | 'off' | undefined | null;
		'data-sveltekit-reload'?: true | '' | 'off' | undefined | null;
		'data-sveltekit-replacestate'?: true | '' | 'off' | undefined | null;
	}
}

export {};


declare module "$app/types" {
	type MatcherParam<M> = M extends (param : string) => param is (infer U extends string) ? U : string;

	export interface AppTypes {
		RouteId(): "/" | "/api" | "/api/health" | "/login" | "/photos" | "/settings" | "/species" | "/species/[code]" | "/targets" | "/trips";
		RouteParams(): {
			"/species/[code]": { code: string }
		};
		LayoutParams(): {
			"/": { code?: string | undefined };
			"/api": Record<string, never>;
			"/api/health": Record<string, never>;
			"/login": Record<string, never>;
			"/photos": Record<string, never>;
			"/settings": Record<string, never>;
			"/species": { code?: string | undefined };
			"/species/[code]": { code: string };
			"/targets": Record<string, never>;
			"/trips": Record<string, never>
		};
		Pathname(): "/" | "/api/health" | "/login" | "/photos" | "/settings" | `/species/${string}` & {} | "/targets" | "/trips";
		ResolvedPathname(): `${"" | `/${string}`}${ReturnType<AppTypes['Pathname']>}`;
		Asset(): string & {};
	}
}