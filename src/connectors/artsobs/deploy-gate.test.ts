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
const app = (name: string, status: string, upSeconds: number) => ({
	name,
	pm2_env: { status, pm_uptime: Date.now() - upSeconds * 1000 }
});
const no = (status: string, up: number) => app('birds-connector-artsobs', status, up);
const se = (status: string, up: number) => app('birds-connector-artportalen', status, up);
const web = { name: 'birds', pm2_env: { status: 'online', pm_uptime: 1 } };

describe('deploy gate: connector state from pm2 jlist (td-99eebf: both connectors)', () => {
	it('finds the program in the deploy script, naming both connectors', () => {
		expect(program).toMatch(/birds-connector-artsobs/);
		expect(program).toMatch(/birds-connector-artportalen/);
	});

	it('is online with the smaller uptime only when both are online', () => {
		expect(state(JSON.stringify([web, no('online', 60), se('online', 40)]))).toMatch(/^online 4\d artsobs=online:6\d,artportalen=online:4\d$/);
	});

	it('fails when either one is missing, restarting or stopped, whatever the other does', () => {
		expect(state(JSON.stringify([web, no('online', 60)]))).toMatch(/^missing 0 /);
		expect(state(JSON.stringify([web, se('online', 60)]))).toMatch(/^missing 0 /);
		expect(state(JSON.stringify([no('online', 60), se('waiting restart', 40)]))).toMatch(/^waiting_restart 0 .*artportalen=waiting_restart:0/);
		expect(state(JSON.stringify([no('stopped', 0), se('online', 60)]))).toMatch(/^stopped 0 /);
	});

	it('never reads a missing, zero, string or future start time as uptime (CODEX1 R10)', () => {
		const odd = (pm_uptime: unknown) => ({ name: 'birds-connector-artportalen', pm2_env: { status: 'online', pm_uptime } });
		for (const t of [null, 0, -5, '1700000000000', Date.now() + 60_000, undefined]) {
			expect(state(JSON.stringify([no('online', 60), odd(t)]))).toMatch(/^bad_uptime 0 /);
		}
	});

	it('reports a young connector by the smaller uptime, so the gate keeps waiting', () => {
		expect(state(JSON.stringify([no('online', 300), se('online', 5)]))).toMatch(/^online [4-6] /);
	});

	it('reads the list past pm2 warnings that start with brackets (CODEX1 re-review finding 3)', () => {
		const list = JSON.stringify([no('online', 40), se('online', 40)]);
		expect(state(`[PM2][WARN] Current process list is not synchronized with saved list.\n${list}\n`)).toMatch(/^online 4\d /);
		expect(state('[PM2][ERROR] nothing useful\n')).toBe('unreadable 0 -');
		expect(state('[{"name": 1}, null]')).toMatch(/^missing 0 /);
	});
});
