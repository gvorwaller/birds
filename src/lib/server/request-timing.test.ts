import { describe, expect, it } from 'vitest';
import {
	newTimingBag,
	perfLogLine,
	recordTiming,
	runWithTiming,
	serverTimingHeader,
	timed
} from './request-timing';

describe('request-timing', () => {
	it('accumulates counts and durations per bucket inside a context', async () => {
		const bag = newTimingBag(1000);
		await runWithTiming(bag, async () => {
			recordTiming('db', 5);
			recordTiming('db', 7);
			recordTiming('ebird', 300);
		});
		expect(bag.buckets.db).toEqual({ n: 2, ms: 12 });
		expect(bag.buckets.ebird).toEqual({ n: 1, ms: 300 });
		expect(bag.buckets.google.n).toBe(0);
	});

	it('is a no-op outside a request context (the worker path)', () => {
		// Must not throw and must not leak into any bag.
		expect(() => recordTiming('db', 5)).not.toThrow();
	});

	it('timed() records into the bucket and re-throws failures', async () => {
		const bag = newTimingBag();
		await runWithTiming(bag, async () => {
			await expect(
				timed('google', async () => {
					throw new Error('boom');
				})
			).rejects.toThrow('boom');
		});
		// Failure still counted — a slow failing call is still slow.
		expect(bag.buckets.google.n).toBe(1);
	});

	it('the async context follows concurrent awaits (no cross-request bleed)', async () => {
		const a = newTimingBag();
		const b = newTimingBag();
		await Promise.all([
			runWithTiming(a, async () => {
				await new Promise((r) => setTimeout(r, 5));
				recordTiming('db', 1);
			}),
			runWithTiming(b, async () => {
				recordTiming('db', 10);
			})
		]);
		expect(a.buckets.db).toEqual({ n: 1, ms: 1 });
		expect(b.buckets.db).toEqual({ n: 1, ms: 10 });
	});

	it('serverTimingHeader includes only non-empty buckets, shell always', () => {
		const bag = newTimingBag();
		bag.buckets.db = { n: 3, ms: 41.6 };
		expect(serverTimingHeader(bag, 120)).toBe('shell;dur=120, db;dur=42;desc="3 calls"');
		expect(serverTimingHeader(newTimingBag(), 5)).toBe('shell;dur=5');
	});

	it('perfLogLine carries path, status, shell/total, and buckets — never a query string', () => {
		const bag = newTimingBag();
		bag.buckets.ebird = { n: 2, ms: 900 };
		const line = perfLogLine('/species/gbbgul', 200, 310, 2140, bag);
		expect(line).toBe('perf path=/species/gbbgul status=200 shell=310ms total=2140ms ebird=2/900ms');
		expect(line).not.toContain('?');
	});
});
