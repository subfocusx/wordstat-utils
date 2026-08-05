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
  let cancelled = false;

  async function run(items: T[]): Promise<void> {
    const total = items.length;
    if (total === 0) return;

    let inFlight = 0;
    let i = 0;
    let completed = 0;

    await new Promise<void>((resolve) => {
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

          if (shouldSkip && shouldSkip(item, idx)) {
            inFlight--;
            completed++;
            maybeFinish();
            continue;
          }

          await new Promise((r) => setTimeout(r, limiter.getDelayMs()));
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
    });
  }

  function cancel(): void {
    cancelled = true;
  }

  return { run, cancel };
}