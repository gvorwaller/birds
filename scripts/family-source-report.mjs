/** Read-only source discovery: input is a taxonomy snapshot, no DB or AI calls.
 * node scripts/family-source-report.mjs .local/family-remediation-baseline.json
 * Redirect stdout to a local JSON report; progress goes to stderr.
 */
import { readFile } from "node:fs/promises";
import { createServer } from "vite";
const input = JSON.parse(await readFile(process.argv[2], "utf8"));
if (!Array.isArray(input.targets))
  throw Error("Expected targets from the read-only taxonomy snapshot");
const server = await createServer({
  mode: "test",
  logLevel: "silent",
  server: { middlewareMode: true },
  appType: "custom",
});
try {
  const { discoverFamilySources } = await server.ssrLoadModule(
    "/src/lib/server/family-source-discovery.ts",
  );
  const report = [];
  for (const family of input.targets) {
    const diagnostics = [];
    let source = null,
      error = null;
    try {
      source = await discoverFamilySources(
        family,
        family.members,
        undefined,
        diagnostics,
      );
    } catch (e) {
      error = e instanceof Error ? e.message : "Source retrieval failed";
    }
    report.push({
      code: family.code,
      name: family.name,
      source,
      error,
      diagnostics,
    });
    process.stderr.write(
      `${family.code}: ${source ? "source found" : (error ?? "no usable source")}\n`,
    );
  }
  process.stdout.write(
    JSON.stringify({ at: new Date(), report }, null, 2) + "\n",
  );
} finally {
  await server.close();
}
