export async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
  onFirstError?: (error: unknown) => void,
) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("invalid_concurrency_limit");
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let failed = false;
  let firstError: unknown;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!failed) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      try {
        results[index] = await worker(items[index]);
      } catch (error) {
        if (!failed) {
          failed = true;
          firstError = error;
          onFirstError?.(error);
        }
        return;
      }
    }
  });
  await Promise.allSettled(runners);
  if (failed) throw firstError;
  return results;
}
