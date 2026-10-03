// tests/rate-limiter.test.js
import { AdaptiveRateLimiter } from '../src/content/rate-limiter.ts';
import { RATE_LIMIT } from '../src/config.ts';

describe('AdaptiveRateLimiter', () => {
  test('throws on missing config', () => {
    expect(() => new AdaptiveRateLimiter()).toThrow();
    expect(() => new AdaptiveRateLimiter(null)).toThrow();
  });

  test('starts at initial values from config', () => {
    const lim = new AdaptiveRateLimiter(RATE_LIMIT);
    expect(lim.getConcurrency()).toBe(RATE_LIMIT.initialConcurrency);
    expect(lim.getDelayMs()).toBe(RATE_LIMIT.initialDelayMs);
  });

  test('does NOT speed up before minSuccesses streak', () => {
    const lim = new AdaptiveRateLimiter(RATE_LIMIT);
    for (let i = 0; i < RATE_LIMIT.speedUpMinSuccesses - 1; i++) {
      lim.recordResult({ status: 200, latencyMs: 100 });
    }
    expect(lim.getConcurrency()).toBe(RATE_LIMIT.initialConcurrency);
    expect(lim.getDelayMs()).toBe(RATE_LIMIT.initialDelayMs);
  });

  test('speeds up after minSuccesses successes with low latency', () => {
    const lim = new AdaptiveRateLimiter(RATE_LIMIT);
    const startC = lim.getConcurrency();
    const startD = lim.getDelayMs();
    for (let i = 0; i < RATE_LIMIT.speedUpMinSuccesses; i++) {
      lim.recordResult({ status: 200, latencyMs: 100 });
    }
    expect(lim.getConcurrency()).toBeGreaterThan(startC);
    expect(lim.getDelayMs()).toBeLessThan(startD);
  });

  test('does NOT speed up when latency is too high', () => {
    const lim = new AdaptiveRateLimiter(RATE_LIMIT);
    for (let i = 0; i < RATE_LIMIT.speedUpMinSuccesses; i++) {
      lim.recordResult({ status: 200, latencyMs: 2000 });
    }
    expect(lim.getConcurrency()).toBe(RATE_LIMIT.initialConcurrency);
  });

  test('does NOT recover while latency stays high, however long the streak', () => {
    const lim = new AdaptiveRateLimiter(RATE_LIMIT);
    // Slow down first so there is room to recover.
    lim.recordResult({ status: 429, latencyMs: 100 });
    const slowC = lim.getConcurrency();
    const slowD = lim.getDelayMs();
    expect(slowC).toBeLessThan(RATE_LIMIT.initialConcurrency);
    // Latency stays above speedUpMaxLatencyMs the whole time. There is
    // deliberately no persistence escape hatch any more: a long success
    // streak must not ramp the queue up while the API is clearly struggling.
    for (let i = 0; i < RATE_LIMIT.speedUpMinSuccesses * 4; i++) {
      lim.recordResult({ status: 200, latencyMs: RATE_LIMIT.speedUpMaxLatencyMs + 500 });
    }
    expect(lim.getConcurrency()).toBe(slowC);
    expect(lim.getDelayMs()).toBe(slowD);
  });

  test('recovers once latency comes back under the threshold', () => {
    const lim = new AdaptiveRateLimiter(RATE_LIMIT);
    lim.recordResult({ status: 429, latencyMs: 100 });
    const slowC = lim.getConcurrency();
    for (let i = 0; i < RATE_LIMIT.speedUpMinSuccesses; i++) {
      lim.recordResult({ status: 200, latencyMs: 100 });
    }
    expect(lim.getConcurrency()).toBeGreaterThan(slowC);
  });

  test('failures do not poison the latency EMA', () => {
    const lim = new AdaptiveRateLimiter(RATE_LIMIT);
    for (let i = 0; i < 10; i++) {
      lim.recordResult({ status: 200, latencyMs: 100 });
    }
    const before = lim.snapshot().latencyEMA;
    // A throttled request with a huge latency must not raise the EMA.
    lim.recordResult({ status: 429, latencyMs: 30000 });
    expect(lim.snapshot().latencyEMA).toBe(before);
    for (let i = 0; i < RATE_LIMIT.speedUpMinSuccesses; i++) {
      lim.recordResult({ status: 200, latencyMs: 100 });
    }
    expect(lim.getConcurrency()).toBeGreaterThan(RATE_LIMIT.minConcurrency);
  });

  test('status 0 (no HTTP status) resets the streak without slowing down', () => {
    const lim = new AdaptiveRateLimiter(RATE_LIMIT);
    for (let i = 0; i < RATE_LIMIT.speedUpMinSuccesses - 1; i++) {
      lim.recordResult({ status: 200, latencyMs: 100 });
    }
    lim.recordResult({ status: 0, latencyMs: 100 });
    expect(lim.snapshot().successStreak).toBe(0);
    // Not throttling: concurrency must not drop.
    expect(lim.getConcurrency()).toBe(RATE_LIMIT.initialConcurrency);
  });

  test('nextDelayMs stays within ±20% of the configured delay', () => {
    const lim = new AdaptiveRateLimiter(RATE_LIMIT);
    const base = lim.getDelayMs();
    for (let i = 0; i < 200; i++) {
      const d = lim.nextDelayMs();
      expect(d).toBeGreaterThanOrEqual(Math.round(base * 0.8));
      expect(d).toBeLessThanOrEqual(Math.round(base * 1.2));
    }
  });

  test('caps concurrency at maxConcurrency', () => {
    const lim = new AdaptiveRateLimiter(RATE_LIMIT);
    for (let i = 0; i < 200; i++) {
      lim.recordResult({ status: 200, latencyMs: 50 });
    }
    expect(lim.getConcurrency()).toBeLessThanOrEqual(RATE_LIMIT.maxConcurrency);
    expect(lim.getDelayMs()).toBeGreaterThanOrEqual(RATE_LIMIT.minDelayMs);
  });

  test('slows down hard on 429', () => {
    const lim = new AdaptiveRateLimiter(RATE_LIMIT);
    const startC = lim.getConcurrency();
    const startD = lim.getDelayMs();
    lim.recordResult({ status: 429, latencyMs: 100 });
    expect(lim.getConcurrency()).toBeLessThan(startC);
    expect(lim.getDelayMs()).toBeGreaterThan(startD);
    // 18 * 0.7 = 12.6 → floor = 12
    expect(lim.getConcurrency()).toBe(12);
  });

  test('slows down hard on 5xx (503, 502, 500)', () => {
    const lim = new AdaptiveRateLimiter(RATE_LIMIT);
    lim.recordResult({ status: 503, latencyMs: 200 });
    expect(lim.getConcurrency()).toBe(12);
    lim.recordResult({ status: 502, latencyMs: 200 });
    // 12 * 0.7 = 8.4 → floor = 8
    expect(lim.getConcurrency()).toBe(8);
  });

  test('does NOT slow down on 4xx (auth/validation errors are not throttling)', () => {
    const lim = new AdaptiveRateLimiter(RATE_LIMIT);
    lim.recordResult({ status: 401, latencyMs: 100 });
    expect(lim.getConcurrency()).toBe(RATE_LIMIT.initialConcurrency);
    lim.recordResult({ status: 404, latencyMs: 100 });
    expect(lim.getConcurrency()).toBe(RATE_LIMIT.initialConcurrency);
  });

  test('success streak resets after a slow-down event', () => {
    const lim = new AdaptiveRateLimiter(RATE_LIMIT);
    // build a partial streak
    for (let i = 0; i < 5; i++) {
      lim.recordResult({ status: 200, latencyMs: 100 });
    }
    // slow down
    lim.recordResult({ status: 429, latencyMs: 100 });
    // need full minSuccesses again to speed up
    for (let i = 0; i < RATE_LIMIT.speedUpMinSuccesses - 1; i++) {
      lim.recordResult({ status: 200, latencyMs: 100 });
    }
    expect(lim.getConcurrency()).toBe(12); // not yet back up
    lim.recordResult({ status: 200, latencyMs: 100 });
    expect(lim.getConcurrency()).toBeGreaterThan(12);
  });

  test('floors concurrency at minConcurrency even after repeated 429s', () => {
    const lim = new AdaptiveRateLimiter(RATE_LIMIT);
    for (let i = 0; i < 20; i++) {
      lim.recordResult({ status: 429, latencyMs: 100 });
    }
    expect(lim.getConcurrency()).toBe(RATE_LIMIT.minConcurrency);
    expect(lim.getDelayMs()).toBe(RATE_LIMIT.maxDelayMs);
  });

  test('updates latencyEMA on each result with latencyMs', () => {
    const lim = new AdaptiveRateLimiter(RATE_LIMIT);
    lim.recordResult({ status: 200, latencyMs: 100 });
    lim.recordResult({ status: 200, latencyMs: 200 });
    const snap = lim.snapshot();
    expect(snap.latencyEMA).toBeGreaterThan(100);
    expect(snap.latencyEMA).toBeLessThan(200);
  });

  test('ignores results without latencyMs', () => {
    const lim = new AdaptiveRateLimiter(RATE_LIMIT);
    expect(() => lim.recordResult({ status: 200 })).not.toThrow();
    expect(lim.snapshot().latencyEMA).toBeNull();
  });

  test('snapshot returns readable state', () => {
    const lim = new AdaptiveRateLimiter(RATE_LIMIT);
    lim.recordResult({ status: 200, latencyMs: 100 });
    const s = lim.snapshot();
    expect(s).toEqual(
      expect.objectContaining({
        concurrency: expect.any(Number),
        delayMs: expect.any(Number),
        successStreak: expect.any(Number)
      })
    );
  });
});