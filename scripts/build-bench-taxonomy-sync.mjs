// Bundle the agent tool scripts/bench-taxonomy-sync.ts (td-861855) into
// .local/bench-taxonomy-sync.mjs with the SvelteKit aliases resolved — the same
// pattern as build-family-quality-operator.mjs.
import { build } from "esbuild";
import path from "node:path";
const root = process.cwd();
await build({
  entryPoints: ["scripts/bench-taxonomy-sync.ts"],
  outfile: ".local/bench-taxonomy-sync.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["pg", "argon2", "web-push"],
  alias: {
    "$env/dynamic/private": path.join(root, "src/worker/env-shim.ts"),
    $lib: path.join(root, "src/lib"),
    $server: path.join(root, "src/lib/server"),
  },
  define: { __GIT_SHA__: JSON.stringify("bench-taxonomy-sync") },
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});
console.log("[build-bench-taxonomy-sync] .local/bench-taxonomy-sync.mjs written");
