import type { FastifyBaseLogger } from 'fastify';
import type { Gateway } from './gateway.ts';
import type { Config } from './config.ts';

/**
 * Periodically refreshes every work and series in anyone's reading list, at
 * low priority, so the apps can read unread-chapter counts from the cache
 * instead of each scraping AO3 themselves.
 */
export class Refresher {
  running = false;
  lastRun: number | null = null;
  lastResult: { works: number; series: number; error?: string } | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private gw: Gateway, private config: Config, private log: FastifyBaseLogger) {}

  start() {
    if (!this.config.refreshIntervalMs || !this.config.tracksyncUrl || !this.config.internalToken) {
      this.log.info('reading-list refresher disabled (needs TRACKSYNC_URL, INTERNAL_TOKEN and REFRESH_INTERVAL_HOURS > 0)');
      return;
    }
    // First run shortly after start, then on the interval.
    this.timer = setTimeout(() => void this.loop(), 30_000);
  }

  stop() { if (this.timer) clearTimeout(this.timer); }

  private async loop() {
    await this.runOnce().catch(() => {});
    this.timer = setTimeout(() => void this.loop(), this.config.refreshIntervalMs);
  }

  async runOnce() {
    if (this.running) return this.lastResult;
    this.running = true;
    try {
      const r = await fetch(`${this.config.tracksyncUrl}/internal/reading-list-targets`, {
        headers: { 'x-internal-token': this.config.internalToken ?? '' },
      });
      if (!r.ok) throw new Error(`tracksync returned HTTP ${r.status}`);
      const { works, series } = (await r.json()) as { works: number[]; series: number[] };
      this.log.info({ works: works.length, series: series.length }, 'refreshing reading-list targets');
      for (const s of series) await this.gw.series(s, 'low');
      await this.gw.works(works, { priority: 'low' });
      this.lastResult = { works: works.length, series: series.length };
    } catch (e) {
      this.lastResult = { works: 0, series: 0, error: (e as Error).message };
      this.log.warn({ err: e }, 'refresh failed');
    } finally {
      this.running = false;
      this.lastRun = Date.now();
    }
    return this.lastResult;
  }
}
