/**
 * Polite, AO3-aware request scheduler.
 *
 * AO3 rate-limits per IP address over a one-minute window and doesn't publish
 * the numbers. When you trip it you get HTTP 429 with a "Retry later" page,
 * and *every* request from your IP (including normal browsing) is blocked
 * until it clears. So this scheduler:
 *
 *   - runs requests one at a time (no parallel bursts),
 *   - uses a token bucket (default: burst of 3, then one request per 6s = 10/min),
 *   - enforces a minimum gap between request starts,
 *   - on 429 / "Retry later" pauses the whole queue for Retry-After
 *     (or an exponential backoff starting at 5 minutes, capped at 1 hour),
 *   - lets user-initiated work jump ahead of background refreshes.
 */

export type Priority = 'high' | 'low';

export interface RateLimiterOptions {
  /** Maximum tokens held (requests allowed back-to-back after idling). */
  burst: number;
  /** One token is regained every refillMs. */
  refillMs: number;
  /** Minimum time between request starts, regardless of tokens. */
  minIntervalMs: number;
  /** Pause used on 429 when AO3 sends no Retry-After. Doubles on repeats. */
  defaultPauseMs: number;
  maxPauseMs: number;
  /** Max queued low-priority jobs; older ones beyond this are rejected. */
  maxQueue: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export const defaultLimiterOptions = (): RateLimiterOptions => ({
  burst: 3,
  refillMs: 6_000,
  minIntervalMs: 2_000,
  defaultPauseMs: 5 * 60_000,
  maxPauseMs: 60 * 60_000,
  maxQueue: 5_000,
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
});

export class RateLimitedError extends Error {
  constructor(public readonly retryAt: number) {
    super(`AO3 rate limit hit; paused until ${new Date(retryAt).toISOString()}`);
    this.name = 'RateLimitedError';
  }
}

export class QueueFullError extends Error {
  constructor() {
    super('AO3 request queue is full');
    this.name = 'QueueFullError';
  }
}

interface Job {
  run: () => Promise<unknown>;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  priority: Priority;
}

export interface LimiterStatus {
  pausedUntil: number | null;
  queuedHigh: number;
  queuedLow: number;
  tokens: number;
  consecutiveRateLimits: number;
  totalRequests: number;
  totalRateLimited: number;
}

export class Ao3RateLimiter {
  readonly opts: RateLimiterOptions;
  private tokens: number;
  private lastRefill: number;
  private lastStart = 0;
  private pausedUntil = 0;
  private consecutive429 = 0;
  private high: Job[] = [];
  private low: Job[] = [];
  private running = false;
  private totalRequests = 0;
  private totalRateLimited = 0;
  private listeners = new Set<(s: LimiterStatus) => void>();

  constructor(opts: Partial<RateLimiterOptions> = {}) {
    this.opts = { ...defaultLimiterOptions(), ...opts };
    this.tokens = this.opts.burst;
    this.lastRefill = this.opts.now();
  }

  onStatus(fn: (s: LimiterStatus) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  status(): LimiterStatus {
    this.refill();
    const now = this.opts.now();
    return {
      pausedUntil: this.pausedUntil > now ? this.pausedUntil : null,
      queuedHigh: this.high.length,
      queuedLow: this.low.length,
      tokens: Math.floor(this.tokens),
      consecutiveRateLimits: this.consecutive429,
      totalRequests: this.totalRequests,
      totalRateLimited: this.totalRateLimited,
    };
  }

  private emit() {
    const s = this.status();
    for (const l of this.listeners) {
      try { l(s); } catch { /* listener errors are not our problem */ }
    }
  }

  /** Queue a request. It runs when the limiter allows. */
  schedule<T>(run: () => Promise<T>, priority: Priority = 'low'): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const job: Job = { run, resolve: resolve as (v: unknown) => void, reject, priority };
      if (priority === 'high') this.high.push(job);
      else {
        if (this.low.length >= this.opts.maxQueue) return reject(new QueueFullError());
        this.low.push(job);
      }
      this.emit();
      void this.pump();
    });
  }

  /** Called by the fetch layer when AO3 says "Retry later". */
  reportRateLimited(retryAfterMs?: number | null): number {
    this.totalRateLimited++;
    this.consecutive429++;
    const backoff = Math.min(this.opts.defaultPauseMs * 2 ** (this.consecutive429 - 1), this.opts.maxPauseMs);
    // Honour the server's Retry-After, but never retry sooner than 30s and add a little slack.
    const wait = retryAfterMs != null && retryAfterMs > 0 ? Math.max(retryAfterMs + 5_000, 30_000) : backoff;
    this.pausedUntil = Math.max(this.pausedUntil, this.opts.now() + Math.min(wait, this.opts.maxPauseMs));
    this.tokens = 0;
    this.emit();
    return this.pausedUntil;
  }

  /** Pause for transient server trouble (5xx) without counting it as a rate limit. */
  reportServerTrouble(ms: number) {
    this.pausedUntil = Math.max(this.pausedUntil, this.opts.now() + ms);
    this.emit();
  }

  reportSuccess() {
    if (this.consecutive429) {
      this.consecutive429 = 0;
      this.emit();
    }
  }

  /** Drop all queued background work (e.g. user cancelled a refresh). */
  clearLow(reason = 'cancelled') {
    const jobs = this.low;
    this.low = [];
    for (const j of jobs) j.reject(new Error(reason));
    this.emit();
  }

  private refill() {
    const now = this.opts.now();
    const gained = (now - this.lastRefill) / this.opts.refillMs;
    if (gained > 0) {
      this.tokens = Math.min(this.opts.burst, this.tokens + gained);
      this.lastRefill = now;
    }
  }

  private async pump() {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        const job = this.high.shift() ?? this.low.shift();
        if (!job) break;
        await this.waitForSlot();
        this.tokens -= 1;
        this.lastStart = this.opts.now();
        this.totalRequests++;
        this.emit();
        try {
          job.resolve(await job.run());
        } catch (e) {
          job.reject(e);
        }
      }
    } finally {
      this.running = false;
      this.emit();
    }
  }

  private async waitForSlot() {
    for (;;) {
      const now = this.opts.now();
      if (this.pausedUntil > now) {
        await this.opts.sleep(Math.min(this.pausedUntil - now, 60_000));
        continue;
      }
      const gap = this.lastStart + this.opts.minIntervalMs - now;
      if (gap > 0) {
        await this.opts.sleep(gap);
        continue;
      }
      this.refill();
      if (this.tokens >= 1) return;
      await this.opts.sleep(Math.ceil((1 - this.tokens) * this.opts.refillMs));
    }
  }
}

/** Parse a Retry-After header (seconds or HTTP-date) into milliseconds. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | null {
  if (!value) return null;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : Math.max(0, t - now);
}
