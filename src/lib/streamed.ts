/**
 * Streamed-section contract (refactor plan Phase 9).
 *
 * SvelteKit routes a REJECTED streamed promise through handleError, so in
 * production a `{:catch}` block receives the sanitized `Internal Error` —
 * never the domain message (verified against Kit 2.65's data_serializer).
 * Therefore streamed promises RESOLVE to this discriminated result and never
 * reject: the loader attaches its own catch and maps errors with the same
 * `err instanceof EbirdError ? err.message : generic` ladder the awaited
 * error channels (nearbyError, countyError, …) have always used. `{:catch}`
 * remains only as a last-resort generic.
 *
 * Only TOP-LEVEL properties of a load result stream (a design convention
 * here — devalue can detect nested promises, but a flat contract is legible)
 * and streamed data is NOT available during SSR: nothing in <svelte:head>
 * may depend on one.
 */
export type Streamed<T> = { ok: true; data: T } | { ok: false; error: string };

export function streamed<T>(work: Promise<T>, describeError: (err: unknown) => string): Promise<Streamed<T>> {
	return work.then(
		(data): Streamed<T> => ({ ok: true, data }),
		(err): Streamed<T> => ({ ok: false, error: describeError(err) })
	);
}
