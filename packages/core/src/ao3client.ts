import { Ao3RateLimiter, RateLimitedError, parseRetryAfter, type Priority } from './ratelimit.ts';
import { AO3_ORIGIN } from './ao3url.ts';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface Ao3ClientOptions {
  limiter: Ao3RateLimiter;
  fetch?: FetchLike;
  userAgent?: string;
  /** Automatic retries after a rate-limit pause before giving up. */
  maxRateLimitRetries?: number;
  /** Extra headers (e.g. Cookie for a logged-in session). */
  headers?: Record<string, string>;
  /** Override the AO3 origin (testing only). */
  origin?: string;
}

export class Ao3HttpError extends Error {
  constructor(public readonly status: number, url: string) {
    super(`AO3 returned HTTP ${status} for ${url}`);
    this.name = 'Ao3HttpError';
  }
}

/** Heuristic for AO3's rate-limit page, which is sometimes served with odd status codes. */
export function looksRateLimited(status: number, body: string): boolean {
  if (status === 429) return true;
  if (status >= 400 && body.length < 5000 && /retry later/i.test(body)) return true;
  return false;
}

/**
 * Rate-limited HTML fetcher for AO3. All traffic to archiveofourown.org from
 * a process should go through one instance so the limit is shared.
 */
export class Ao3Client {
  readonly limiter: Ao3RateLimiter;
  private readonly fetchImpl: FetchLike;
  private readonly ua: string;
  private readonly maxRetries: number;
  private readonly headers: Record<string, string>;
  private inflight = new Map<string, Promise<string>>();
  private readonly origin: string;

  constructor(opts: Ao3ClientOptions) {
    this.limiter = opts.limiter;
    this.fetchImpl = opts.fetch ?? ((u, i) => fetch(u, i));
    this.ua = opts.userAgent ?? 'Ao3Track/2.0 (self-hosted reading tracker; https://github.com/wench/Ao3-Tracker)';
    this.maxRetries = opts.maxRateLimitRetries ?? 2;
    this.headers = opts.headers ?? {};
    this.origin = opts.origin ?? AO3_ORIGIN;
  }

  /** GET a page as text. Identical concurrent requests are de-duplicated. */
  getHtml(pathOrUrl: string, priority: Priority = 'low'): Promise<string> {
    const url = new URL(pathOrUrl, this.origin).href;
    const existing = this.inflight.get(url);
    if (existing) return existing;
    const p = this.attempt(url, priority, 0).finally(() => this.inflight.delete(url));
    this.inflight.set(url, p);
    return p;
  }

  private async attempt(url: string, priority: Priority, retry: number): Promise<string> {
    try {
      return await this.limiter.schedule(() => this.once(url), priority);
    } catch (e) {
      if (e instanceof RateLimitedError && retry < this.maxRetries) {
        // The limiter is now paused; re-queue and we'll run once it lifts.
        return this.attempt(url, priority, retry + 1);
      }
      if (e instanceof Ao3HttpError && e.status >= 500 && retry < this.maxRetries) {
        return this.attempt(url, priority, retry + 1);
      }
      throw e;
    }
  }

  private async once(url: string): Promise<string> {
    const res = await this.fetchImpl(url, {
      headers: { 'User-Agent': this.ua, Accept: 'text/html,application/xhtml+xml', ...this.headers },
      redirect: 'follow',
    });
    const body = await res.text();
    if (looksRateLimited(res.status, body)) {
      const until = this.limiter.reportRateLimited(parseRetryAfter(res.headers.get('retry-after')));
      throw new RateLimitedError(until);
    }
    if (res.status >= 500) {
      // AO3 serves 502/503/525 under load; give it a minute.
      this.limiter.reportServerTrouble(60_000);
      throw new Ao3HttpError(res.status, url);
    }
    if (!res.ok) throw new Ao3HttpError(res.status, url);
    this.limiter.reportSuccess();
    return body;
  }
}
