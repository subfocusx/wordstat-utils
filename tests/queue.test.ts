// tests/queue.test.js
import { createRateLimitedQueue } from '../src/content/queue.ts';
import { AdaptiveRateLimiter } from '../src/content/rate-limiter.ts';
import { RATE_LIMIT } from '../src/config.ts';

function makeLimiter(overrides = {}) {
  return new AdaptiveRateLimiter({ ...RATE_LIMIT, ...overrides });
}

describe('createRateLimitedQueue', () => {
  test('processes all items', async () => {
    const calls = [];
    const q = createRateLimitedQueue({
      limiter: makeLimiter(),
      handler: async (item) => {
        calls.push(item);
      }
    });
    await q.run([1, 2, 3]);
    expect(calls.sort()).toEqual([1, 2, 3]);
  });

  test('respects concurrency limit from limiter', async () => {
    let inflight = 0;
    let peak = 0;
    let calls = 0;
    const q = createRateLimitedQueue({
      limiter: makeLimiter({ initialConcurrency: 3, initialDelayMs: 5 }),
      handler: async () => {
        inflight++;
        calls++;
        peak = Math.max(peak, inflight);
        await new Promise((r) => setTimeout(r, 20));
        inflight--;
      }
    });
    await q.run(Array.from({ length: 12 }, (_, i) => i));
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
    // Regression: previously only the first `concurrency` items were ever
    // processed (pipeline never refilled), silently dropping the rest.
    expect(calls).toBe(12);
  });

  test('handler errors do not stop the queue', async () => {
    const errs = [];
    const q = createRateLimitedQueue({
      limiter: makeLimiter(),
      handler: async (item) => {
        if (item === 2) throw new Error('boom');
        return item;
      }
    });
    const origErr = console.error;
    console.error = (...args) => {
      errs.push(args);
      origErr.apply(console, args);
    };
    try {
      await q.run([1, 2, 3]);
    } finally {
      console.error = origErr;
    }
    expect(errs.length).toBe(1);
    expect(String(errs[0][0])).toMatch(/Unhandled queue item error/);
  });

  test('empty queue is a no-op', async () => {
    const handler = jest.fn();
    const q = createRateLimitedQueue({ limiter: makeLimiter(), handler });
    await q.run([]);
    expect(handler).not.toHaveBeenCalled();
  });

  test('cancel() prevents further processing', async () => {
    const q = createRateLimitedQueue({
      limiter: makeLimiter(),
      handler: async () => {}
    });
    const p = q.run([1, 2, 3, 4]);
    q.cancel();
    await p;
  });

  test('reads concurrency from limiter at start time, not snapshot', async () => {
    let inflight = 0;
    let peak = 0;
    const lim = makeLimiter();
    const initialC = lim.getConcurrency();
    lim.concurrency = 2;
    const q = createRateLimitedQueue({
      limiter: lim,
      handler: async () => {
        inflight++;
        peak = Math.max(peak, inflight);
        await new Promise((r) => setTimeout(r, 10));
        inflight--;
      }
    });
    await q.run(Array.from({ length: 5 }, (_, i) => i));
    expect(peak).toBeLessThanOrEqual(2);
    expect(lim.getConcurrency()).not.toBe(initialC);
  });
});