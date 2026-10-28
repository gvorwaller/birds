/**
 * The deploy gate's reading of `pm2 jlist` for the Norway connector
 * (scripts/deploy-to-DO.sh → connector_state). Runs the script's own node
 * program on sample pm2 output.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const script = readFileSync(new URL('../../../scripts/deploy-to-DO.sh', import.meta.url), 'utf8');
const program = /connector_state\(\) \{\n {2}pm2 jlist \| node -e '([\s\S]*?)'\n\}/.exec(script)?.[1];

const state = (stdout: string) => execFileSync(process.execPath, ['-e', program!], { input: stdout, encoding: 'utf8' }).trim();
const app = (status: string, upSeconds: number) => ({
	name: 'birds-connector-gbif-artsobs',
	pm2_env: { status, pm_uptime: Date.now() - upSeconds * 1000 }
});

describe('deploy gate: connector state from pm2 jlist', () => {
	it('finds the program in the deploy script', () => {
		expect(program).toMatch(/birds-connector-gbif-artsobs/);
	});

	it('reads status and uptime, with the status as one word', () => {
		expect(state(JSON.stringify([{ name: 'birds', pm2_env: { status: 'online', pm_uptime: 1 } }, app('online', 40)]))).toMatch(/^online 4\d$/);
		expect(state(JSON.stringify([app('waiting restart', 40)]))).toBe('waiting_restart 0');
		expect(state(JSON.stringify([{ name: 'birds', pm2_env: { status: 'online', pm_uptime: 1 } }]))).toBe('missing 0');
	});

	it('reads the list past pm2 warnings that start with brackets (CODEX1 re-review finding 3)', () => {
		const list = JSON.stringify([app('online', 40)]);
		expect(state(`[PM2][WARN] Current process list is not synchronized with saved list.\n${list}\n`)).toMatch(/^online 4\d$/);
		expect(state('[PM2][ERROR] nothing useful\n')).toBe('unreadable 0');
	});
});
