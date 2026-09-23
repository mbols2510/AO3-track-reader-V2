import { Ao3Client, Ao3RateLimiter, RateLimitedError, type Priority, type WorkMeta, type SeriesMeta, type FetchLike } from '@ao3track/core';
import { lookupWorks, parseSeriesPage, WORKS_PER_SEARCH } from '@ao3track/core/parse';
import type { MetaCache } from './cache.ts';
import type { Config } from './config.ts';

/**
 * Collects work ids that need fetching and resolves them in batches of 20
 * (one AO3 search request each), de-duplicating across callers.
 */
export class Gateway {
  readonly limiter: Ao3RateLimiter;
  readonly client: Ao3Client;
  private pending = new Map<number, Priority>();
  private waiters = new Map<number, Array<() => void>>();
  private draining = false;
  private timer: NodeJS.Timeout | null = null;
  lastError: string | null = null;

  constructor(private cache: MetaCache, private config: Config, fetchImpl?: FetchLike) {
    this.limiter = new Ao3RateLimiter(config.limiter);
    this.client = new Ao3Client({
      limiter: this.limiter,
      fetch: fetchImpl,
      userAgent: config.userAgent,
      headers: config.ao3Cookie ? { Cookie: config.ao3Cookie } : {},
      origin: config.ao3Origin,
    });
  }

  isFresh(fetchedAt: number, maxAgeMs = this.config.cacheTtlMs) {
    return Date.now() - fetchedAt < maxAgeMs;
  }

  /** Queue ids for fetching; resolves when they've been attempted. */
  request(ids: number[], priority: Priority = 'low'): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const id of ids) {
      const cur = this.pending.get(id);
      if (cur !== 'high') this.pending.set(id, priority === 'high' ? 'high' : (cur ?? 'low'));
      promises.push(new Promise((r) => {
        const list = this.waiters.get(id) ?? [];
        list.push(r);
        this.waiters.set(id, list);
      }));
    }
    // Short debounce so ids arriving together share a search request.
    if (!this.timer) this.timer = setTimeout(() => { this.timer = null; void this.drain(); }, 250);
    return Promise.all(promises).then(() => undefined);
  }

  private settle(id: number) {
    for (const r of this.waiters.get(id) ?? []) r();
    this.waiters.delete(id);
  }

  private async drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.pending.size) {
        // High priority first, then fill the batch with low priority ids.
        const entries = [...this.pending.entries()].sort((a, b) => (a[1] === b[1] ? 0 : a[1] === 'high' ? -1 : 1));
        const batch = entries.slice(0, WORKS_PER_SEARCH);
        const priority: Priority = batch.some(([, p]) => p === 'high') ? 'high' : 'low';
        const ids = batch.map(([id]) => id);
        for (const id of ids) this.pending.delete(id);
        try {
          const { found, missing } = await lookupWorks(this.client, ids, {
            priority,
            onResult: (w) => this.cache.putWork(w),
          });
          for (const id of missing) this.cache.putMissing(id);
          void found;
          this.lastError = null;
        } catch (e) {
          this.lastError = (e as Error).message;
          if (e instanceof RateLimitedError) {
            // Put them back; the limiter is paused and will pace the retry.
            for (const [id, p] of batch) if (!this.pending.has(id)) this.pending.set(id, p);
            continue;
          }
        }
        for (const id of ids) this.settle(id);
      }
    } finally {
      this.draining = false;
    }
  }

  /** Cached metadata, queuing anything stale. With waitMs, waits (bounded) for fresh data. */
  async works(ids: number[], opts: { priority?: Priority; waitMs?: number; maxAgeMs?: number } = {}) {
    const unique = [...new Set(ids)].filter((n) => Number.isInteger(n) && n > 0).slice(0, 500);
    const cached = this.cache.getWorks(unique);
    const stale = unique.filter((id) => {
      const c = cached.get(id);
      return !c || !this.isFresh(c.fetchedAt, opts.maxAgeMs);
    });
    if (stale.length) {
      const done = this.request(stale, opts.priority ?? 'low');
      if (opts.waitMs) await Promise.race([done, new Promise((r) => setTimeout(r, opts.waitMs))]);
    }
    const now = this.cache.getWorks(unique);
    const works: WorkMeta[] = [], missing: number[] = [], pending: number[] = [];
    for (const id of unique) {
      const c = now.get(id);
      if (c?.meta) works.push(c.meta);
      else if (c?.status === 'missing') missing.push(id);
      else pending.push(id);
      if (c && !this.isFresh(c.fetchedAt, opts.maxAgeMs) && !pending.includes(id)) pending.push(id);
    }
    return { works, missing, pending, limiter: this.limiter.status() };
  }

  async series(id: number, priority: Priority = 'low', maxAgeMs = this.config.cacheTtlMs): Promise<SeriesMeta | null> {
    const c = this.cache.getSeries(id);
    if (c && this.isFresh(c.fetchedAt, maxAgeMs)) return c.meta;
    try {
      const html = await this.client.getHtml(`/series/${id}`, priority);
      const { series, works } = parseSeriesPage(html, id);
      for (const w of works) this.cache.putWork(w);
      if (series) this.cache.putSeries(series);
      return series ?? c?.meta ?? null;
    } catch (e) {
      this.lastError = (e as Error).message;
      return c?.meta ?? null;
    }
  }
}
