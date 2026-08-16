/**
 * esbuild alias target for `$env/dynamic/private` in the worker bundle.
 * PM2 launches the worker with `--env-file=.env`, so process.env carries the
 * same values SvelteKit's dynamic env would in prod.
 */
export const env = process.env as Record<string, string | undefined>;
