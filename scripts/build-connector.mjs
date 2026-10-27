#!/usr/bin/env node
// Bundle the Norway connector (td-eec7db Phase 2 rev B) into build/connector-artsobs.js.
// It shares only the pure ingest contract module with the app ($server alias)
// and never the database layer. Runs AFTER `vite build` (adapter-node cleans
// build/ first).
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const result = await build({
	entryPoints: [path.join(root, 'src/connectors/artsobs/main.ts')],
	outfile: path.join(root, 'build/connector-artsobs.js'),
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'node22',
	sourcemap: true,
	metafile: true,
	alias: {
		'$server': path.join(root, 'src/lib/server')
	},
	define: {
		__GIT_SHA__: JSON.stringify(process.env.GIT_SHA ?? 'dev')
	}
});

// The connector must never pull in the app's database or env modules.
const inputs = Object.keys(result.metafile.inputs);
const forbidden = inputs.filter((f) => /src\/lib\/(db|server\/(?!external-sources\/contract\.ts))/.test(f));
if (forbidden.length > 0) {
	console.error(`[build-connector] the connector bundle includes app server modules: ${forbidden.join(', ')}`);
	process.exit(1);
}
console.log('[build-connector] build/connector-artsobs.js written');
