// Bundle the agent tool scripts/verify-species-presence.ts (td-7162f6) into
// .local/verify-species-presence.mjs with the SvelteKit aliases resolved — the same
// pattern as build-family-quality-operator.mjs.
import { build } from "esbuild";
import path from "node:path";
const root = process.cwd();
await build({
  entryPoints: ["scripts/verify-species-presence.ts"],
  outfile: ".local/verify-species-presence.mjs",
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
  define: { __GIT_SHA__: JSON.stringify("verify-species-presence") },
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});
console.log("[build-verify-species-presence] .local/verify-species-presence.mjs written");
