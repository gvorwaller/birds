#!/usr/bin/env node
// Bundle the birds-worker entry with the SvelteKit aliases resolved and
// $env/dynamic/private shimmed to process.env (PM2 runs it with --env-file).
// Runs AFTER `vite build` (adapter-node cleans build/ first).
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

await build({
	entryPoints: [path.join(root, 'src/worker/index.ts')],
	outfile: path.join(root, 'build/worker.js'),
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'node22',
	sourcemap: true,
	// Native-dep / heavy packages stay external (present in node_modules on
	// the droplet via npm install at deploy).
	external: ['pg', 'argon2', 'web-push'],
	alias: {
		'$env/dynamic/private': path.join(root, 'src/worker/env-shim.ts'),
		'$lib': path.join(root, 'src/lib'),
		'$server': path.join(root, 'src/lib/server'),
		'$components': path.join(root, 'src/lib/components')
	},
	define: {
		__GIT_SHA__: JSON.stringify(process.env.GIT_SHA ?? 'dev')
	},
	// ESM bundle needs require() for pg's CJS interop in some import paths.
	banner: {
		js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"
	}
});

console.log('[build-worker] build/worker.js written');
