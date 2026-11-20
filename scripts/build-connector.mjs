#!/usr/bin/env node
// Bundle each sightings connector into build/connector-<id>.js: Norway
// (td-eec7db Phase 2 rev B) and Sweden (td-99eebf). Each shares only the pure
// ingest contract module with the app ($server alias) and never the database
// layer. Runs AFTER `vite build` (adapter-node cleans build/ first).
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const CONNECTORS = ['artsobs', 'artportalen'];

for (const id of CONNECTORS) {
	const result = await build({
		entryPoints: [path.join(root, `src/connectors/${id}/main.ts`)],
		outfile: path.join(root, `build/connector-${id}.js`),
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

	// A connector must never pull in the app's database or env modules.
	const inputs = Object.keys(result.metafile.inputs);
	const forbidden = inputs.filter((f) => /src\/lib\/(db|server\/(?!external-sources\/contract\.ts))/.test(f));
	if (forbidden.length > 0) {
		console.error(`[build-connector] the ${id} connector bundle includes app server modules: ${forbidden.join(', ')}`);
		process.exit(1);
	}
	console.log(`[build-connector] build/connector-${id}.js written`);
}
