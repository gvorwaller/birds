import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [sveltekit()],
	// Bake the commit SHA into the bundle at build time (deploy runs
	// `GIT_SHA=... npm run build`); falls back to 'dev' locally.
	define: {
		__GIT_SHA__: JSON.stringify(process.env.GIT_SHA ?? "dev"),
	},
	server: {
		port: 5178,
		strictPort: true,
	},
	ssr: {
		external: ["pg", "argon2"],
	},
	// Server-side unit tests (engine logic). The sveltekit() plugin resolves
	// $lib/$server/$env so the real modules import cleanly under Node.
	test: {
		environment: "node",
		include: ["src/**/*.{test,spec}.ts"],
	},
});
