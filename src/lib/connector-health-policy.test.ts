import { describe, expect, it } from 'vitest';
import {
	connectorAlertTag,
	connectorPush,
	connectorState,
	isConnectorVersion,
	parseConnectorStarted,
	spanWords,
	versionDiffers
} from './connector-health-policy';
import { alertRetryDelayMs, CONNECTOR_ALIVE_MINUTES, REFRESH_TICK_MS } from './external-refresh-policy';

const NOW = new Date('2026-11-27T21:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);

describe('connector health policy (td-afba28)', () => {
	it('reads a check-in as online up to 2 min, quiet up to 5, then offline', () => {
		expect(connectorState(null, NOW)).toBe('never');
		expect(connectorState(ago(10_000), NOW)).toBe('online');
		expect(connectorState(ago(120_000), NOW)).toBe('online');
		expect(connectorState(ago(120_001), NOW)).toBe('quiet');
		expect(connectorState(ago(300_000), NOW)).toBe('quiet');
		expect(connectorState(ago(300_001), NOW)).toBe('offline');
		expect(connectorState(ago(60_000).toISOString(), NOW.toISOString())).toBe('online');
		// The refresh job's liveness gate is the same 5 minutes.
		expect(CONNECTOR_ALIVE_MINUTES).toBe(5);
	});

	it('words a span in the largest units that fit', () => {
		expect(spanWords(40_000)).toBe('40 s');
		expect(spanWords(18 * 60_000)).toBe('18 min');
		expect(spanWords(3 * 3_600_000)).toBe('3 h');
		expect(spanWords(3 * 3_600_000 + 10 * 60_000)).toBe('3 h 10 min');
		expect(spanWords(2 * 86_400_000 + 4 * 3_600_000)).toBe('2 d 4 h');
		expect(spanWords(-5)).toBe('0 s');
	});

	it('words the two pushes, the back-online one from the recorded recovery', () => {
		expect(connectorPush({ kind: 'connector_offline', countryName: 'Sweden', lastSeenAt: ago(18 * 60_000), now: NOW })).toEqual({
			title: 'Sweden connector offline',
			body: "Last heard from 18 min ago. Loads wait until it's back."
		});
		expect(
			connectorPush({ kind: 'connector_online', countryName: 'Sweden', lastSeenAt: ago(3 * 3_600_000), closedAt: ago(3 * 3_600_000 - 42 * 60_000) })
		).toEqual({ title: 'Sweden connector back online', body: 'It was offline for 42 min.' });
		expect(connectorAlertTag('artportalen')).toBe('ext-artportalen-connector');
	});

	it('accepts only believable reported versions and start times', () => {
		expect(isConnectorVersion('19e8845')).toBe(true);
		expect(isConnectorVersion('dev')).toBe(true);
		expect(isConnectorVersion('19E8845')).toBe(false);
		expect(isConnectorVersion('abc')).toBe(false);
		expect(isConnectorVersion(null)).toBe(false);
		expect(parseConnectorStarted('2026-11-27T20:00:00Z', NOW)).toEqual(new Date('2026-11-27T20:00:00Z'));
		expect(parseConnectorStarted('2026-11-27T21:10:00Z', NOW)).toBeNull();
		expect(parseConnectorStarted('2024-01-01T00:00:00Z', NOW)).toBeNull();
		expect(parseConnectorStarted('yesterday', NOW)).toBeNull();
		expect(parseConnectorStarted(null, NOW)).toBeNull();
	});

	it('flags only a known, different version', () => {
		expect(versionDiffers('19e8845', '19e8845')).toBe(false);
		expect(versionDiffers('19e8845abcdef', '19e8845')).toBe(false);
		expect(versionDiffers('03f5c7f', '19e8845')).toBe(true);
		expect(versionDiffers(null, '19e8845')).toBe(false);
		expect(versionDiffers('dev', '19e8845')).toBe(false);
	});

	it('keeps the alert retries hourly while the job ticks every 5 minutes', () => {
		expect(REFRESH_TICK_MS).toBe(5 * 60_000);
		expect([1, 2, 3, 4].map((n) => alertRetryDelayMs(n) / 60_000)).toEqual([55, 115, 235, 475]);
	});
});
