// Bundle the agent tool scripts/tag-propose.ts (td-894144 B5) into
// .local/tag-propose.mjs with the SvelteKit aliases resolved — the same
// pattern as build-family-quality-operator.mjs.
import { build } from "esbuild";
import path from "node:path";
const root = process.cwd();
await build({
  entryPoints: ["scripts/tag-propose.ts"],
  outfile: ".local/tag-propose.mjs",
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
  define: { __GIT_SHA__: JSON.stringify("tag-propose") },
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});
console.log("[build-tag-propose] .local/tag-propose.mjs written");
