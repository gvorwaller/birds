/**
 * Bounded-concurrency helpers shared by the server's fan-out paths.
 *
 * Lifted verbatim out of `needs.ts` when the nearest ladder (td-73e6f9)
 * became a second caller — it has no needs-specific dependencies, and two
 * copies of a worker pool is one copy too many.
 */

/**
 * Run `fn` over `items` with at most `limit` in flight, preserving input
 * order in the result array.
 *
 * A worker pool rather than chunked `Promise.all` batches: chunking makes
 * every worker wait for the slowest member of its batch, which for a fan-out
 * of network calls is most of the time.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workerCount = Math.min(limit, items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await fn(items[index]);
      }
    }),
  );
  return results;
}
