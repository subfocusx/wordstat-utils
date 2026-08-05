import { type RateLimitConfig } from '../config.ts';

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

    if (typeof latencyMs === 'number' && Number.isFinite(latencyMs)) {
      this._latencyEMA =
        this._latencyEMA == null
          ? latencyMs
          : this._alpha * latencyMs + (1 - this._alpha) * this._latencyEMA;
    }

    if (status === 429 || (typeof status === 'number' && status >= 500 && status < 600)) {
      this.concurrency = Math.max(this._minC, Math.floor(this.concurrency * this._downC));
      this.delayMs = Math.min(this._maxD, Math.ceil(this.delayMs * this._downD));
      this._successStreak = 0;
      return;
    }

    if (typeof status === 'number' && status >= 200 && status < 300) {
      this._successStreak += 1;
      // Normal speed-up: enough successes AND latency below threshold.
      const fastEnough = this._latencyEMA == null || this._latencyEMA < this._maxLat;
      // Recovery-by-persistence: once throttling stops, latency may hover
      // slightly above the threshold forever, leaving the limiter stuck at
      // its slowest settings. A long unbroken success streak overrides the
      // latency gate so the queue speeds back up.
      const persistentEnough =
        this._latencyEMA != null &&
        this._latencyEMA >= this._maxLat &&
        this._successStreak >= this._minOk * 2;
      if (this._successStreak >= this._minOk && (fastEnough || persistentEnough)) {
        this.concurrency = Math.min(this._maxC, Math.ceil(this.concurrency * this._upC));
        this.delayMs = Math.max(this._minD, Math.floor(this.delayMs * this._upD));
        this._successStreak = 0;
      }
    }
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