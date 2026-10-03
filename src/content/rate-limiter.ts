import { type RateLimitConfig } from '../config.ts';

// Fraction of the current delay used as ± jitter when pacing request starts.
const JITTER_RATIO = 0.2;

export class AdaptiveRateLimiter {
  private _minC: number;
  private _maxC: number;
  private _minD: number;
  private _maxD: number;
  private _upC: number;
  private _upD: number;
  private _downC: number;
  private _downD: number;
  private _minOk: number;
  private _maxLat: number;
  private _window: number;
  private _alpha: number;
  private _successStreak: number;
  private _latencyEMA: number | null;

  concurrency: number;
  delayMs: number;

  constructor(cfg: RateLimitConfig) {
    if (!cfg || typeof cfg !== 'object') {
      throw new Error('AdaptiveRateLimiter requires a config object');
    }
    this._minC = cfg.minConcurrency;
    this._maxC = cfg.maxConcurrency;
    this._minD = cfg.minDelayMs;
    this._maxD = cfg.maxDelayMs;
    this._upC = cfg.speedUpFactor;
    this._upD = cfg.speedUpDelayFactor;
    this._downC = cfg.slowDownFactor;
    this._downD = cfg.slowDownDelayFactor;
    this._minOk = cfg.speedUpMinSuccesses;
    this._maxLat = cfg.speedUpMaxLatencyMs;
    this._window = cfg.windowSize;
    this._alpha = 2 / (this._window + 1);

    this.concurrency = cfg.initialConcurrency;
    this.delayMs = cfg.initialDelayMs;
    this._successStreak = 0;
    this._latencyEMA = null;
  }

  recordResult(result: { latencyMs?: number; status?: number }): void {
    const { latencyMs, status } = result || {};
    const hasStatus = typeof status === 'number' && status > 0;
    const isSuccess = hasStatus && status >= 200 && status < 300;
    const isThrottled = status === 429 || (hasStatus && status >= 500 && status < 600);

    if (isThrottled) {
      this.concurrency = Math.max(this._minC, Math.floor(this.concurrency * this._downC));
      this.delayMs = Math.min(this._maxD, Math.ceil(this.delayMs * this._downD));
      this._successStreak = 0;
      return;
    }

    // Anything that is not a clean success (network error with no status,
    // 4xx validation/auth failure, malformed response) breaks the streak.
    // Failures never touch the latency EMA: a 429 or a dead socket must not
    // make every later success look "too slow" and freeze the queue at its
    // floor settings.
    if (!isSuccess) {
      this._successStreak = 0;
      return;
    }

    if (typeof latencyMs === 'number' && Number.isFinite(latencyMs)) {
      this._latencyEMA =
        this._latencyEMA == null
          ? latencyMs
          : this._alpha * latencyMs + (1 - this._alpha) * this._latencyEMA;
    }

    this._successStreak += 1;
    // Speed up only on sustained successes that are also genuinely fast.
    // There is deliberately no "persistent streak overrides latency" escape
    // hatch: it used to let the limiter ramp up while the API was clearly
    // struggling.
    const fastEnough = this._latencyEMA == null || this._latencyEMA < this._maxLat;
    if (this._successStreak >= this._minOk && fastEnough) {
      this.concurrency = Math.min(this._maxC, Math.ceil(this.concurrency * this._upC));
      this.delayMs = Math.max(this._minD, Math.floor(this.delayMs * this._upD));
      this._successStreak = 0;
    }
  }

  /**
   * Delay until the next request start, with ±20% jitter. Without jitter a
   * whole burst leaves the gate in lockstep and re-hits the API as a spike
   * every time a queue slot frees up.
   */
  nextDelayMs(): number {
    const base = Math.max(0, this.delayMs);
    const jitter = base * JITTER_RATIO * (Math.random() * 2 - 1);
    return Math.max(0, Math.round(base + jitter));
  }

  getConcurrency(): number {
    return this.concurrency;
  }

  getDelayMs(): number {
    return this.delayMs;
  }

  snapshot(): { concurrency: number; delayMs: number; latencyEMA: number | null; successStreak: number } {
    return {
      concurrency: this.concurrency,
      delayMs: this.delayMs,
      latencyEMA: this._latencyEMA,
      successStreak: this._successStreak
    };
  }
}