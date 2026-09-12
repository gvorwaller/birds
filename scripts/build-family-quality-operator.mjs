import { build } from "esbuild";
import path from "node:path";
const root = process.cwd();
await build({
  entryPoints: ["scripts/apply-family-quality.ts"],
  outfile: ".local/apply-family-quality.mjs",
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
  define: { __GIT_SHA__: JSON.stringify("family-quality-operator") },
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});
