import { type AdaptiveRateLimiter } from './rate-limiter.ts';
import { logger } from './logger.ts';

interface CreateRateLimitedQueueOpts<T> {
  limiter: AdaptiveRateLimiter;
  handler: (item: T, index: number) => Promise<void>;
  shouldSkip?: (item: T, index: number) => boolean;
}

interface RateLimitedQueue<T> {
  run: (items: T[]) => Promise<void>;
  cancel: () => void;
}

export function createRateLimitedQueue<T>({ limiter, handler, shouldSkip }: CreateRateLimitedQueueOpts<T>): RateLimitedQueue<T> {
  // Cancellation is per-run: a queue instance is reused across runs (the
  // fetcher creates one queue and calls run() for every batch). A cancel()
  // from run #1 must not poison run #2.
  let cancelCurrentRun: (() => void) | null = null;

  async function run(items: T[]): Promise<void> {
    const total = items.length;
    if (total === 0) {
      cancelCurrentRun = null;
      return;
    }

    let cancelled = false;
    cancelCurrentRun = (): void => {
      cancelled = true;
    };

    let inFlight = 0;
    let i = 0;
    let completed = 0;

    try {
      const { promise: finished, resolve } = Promise.withResolvers<void>();

      const maybeFinish = (): void => {
        // If cancelled, stop scheduling but let in-flight work settle so
        // run() never hangs (cancel() semantics = "stop starting new work").
        if (cancelled || completed >= total) resolve();
      };

      const processNext = async (): Promise<void> => {
        if (cancelled) return;
        while (inFlight < limiter.getConcurrency() && i < total) {
          const idx = i++;
          const item = items[idx];
          inFlight++;

          let skip = false;
          try {
            skip = shouldSkip ? shouldSkip(item, idx) : false;
          } catch (err: unknown) {
            // A throwing predicate must not strand the slot or hang run().
            logger.error('Queue shouldSkip() error:', err);
            skip = true;
          }
          if (skip) {
            inFlight--;
            completed++;
            maybeFinish();
            continue;
          }

          const { promise: paced, resolve: releaseSlot } = Promise.withResolvers<void>();
          setTimeout(releaseSlot, limiter.nextDelayMs());
          await paced;
          if (cancelled) {
            inFlight--;
            completed++;
            maybeFinish();
            return;
          }

          Promise.resolve()
            .then(() => handler(item, idx))
            .catch((err: unknown) => logger.error('Unhandled queue item error:', err))
            .finally(() => {
              inFlight--;
              completed++;
              maybeFinish();
              // Keep the pipeline topped up: as soon as a slot frees,
              // start the next item. Without this, only the first
              // `concurrency` items would ever be processed.
              void processNext();
            });
        }
      };

      void processNext();
      await finished;
    } finally {
      cancelCurrentRun = null;
    }
  }

  function cancel(): void {
    cancelCurrentRun?.();
  }

  return { run, cancel };
}
