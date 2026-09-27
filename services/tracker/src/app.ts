import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import type { FetchLike } from '@ao3track/core';
import { MetaCache } from './cache.ts';
import { Gateway } from './gateway.ts';
import { Refresher } from './refresher.ts';
import { UpdateChecker } from './updates.ts';
import type { Config } from './config.ts';

const same = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export type TrackerApp = FastifyInstance & { gateway: Gateway; refresher: Refresher; updates: UpdateChecker };

export async function buildApp(config: Config, fetchImpl?: FetchLike, githubFetch?: typeof fetch): Promise<TrackerApp> {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
  const cache = new MetaCache(config.dbPath);
  const gw = new Gateway(cache, config, fetchImpl);
  const refresher = new Refresher(gw, config, app.log);
  const updates = new UpdateChecker(config, githubFetch);

  gw.limiter.onStatus((s) => {
    if (s.pausedUntil && s.consecutiveRateLimits) app.log.warn({ until: new Date(s.pausedUntil).toISOString() }, 'AO3 rate limit reached — pausing all requests');
  });

  app.addHook('onRequest', async (req, reply) => {
    const o = req.headers.origin;
    if (o && (/^(chrome|moz)-extension:\/\//.test(o) || config.corsOrigins.includes(o) || config.corsOrigins.includes('*'))) {
      reply.header('Access-Control-Allow-Origin', o).header('Vary', 'Origin')
        .header('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key, Authorization').header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    }
    if (req.method === 'OPTIONS') return reply.code(204).send();
    // Optional API key: keeps strangers from using your tracker (and your AO3 request budget).
    if (config.apiKey && req.url.startsWith('/api/')) {
      const auth = req.headers.authorization;
      const given = String(req.headers['x-api-key'] ?? (auth?.startsWith('Bearer ') ? auth.slice(7) : ''));
      const internal = String(req.headers['x-internal-token'] ?? '');
      if (!same(given, config.apiKey) && !(config.internalToken && same(internal, config.internalToken))) {
        return reply.code(401).send({ error: 'API key required' });
      }
    }
  });

  const q = (req: { query: unknown }) => req.query as Record<string, string | undefined>;
  const ids = (s?: string) => (s ?? '').split(',').map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n > 0);

  /**
   * GET /api/works?ids=1,2,3[&priority=high][&wait=10][&maxAge=hours][&cacheOnly=1]
   * Returns cached metadata immediately; stale/unknown ids are queued and listed in `pending`.
   * cacheOnly=1 returns only what's cached and never contacts AO3.
   */
  app.get('/api/works', async (req) => {
    const p = q(req);
    return gw.works(ids(p.ids), {
      priority: p.priority === 'high' ? 'high' : 'low',
      waitMs: Math.min(Number(p.wait ?? 0), 60) * 1000,
      maxAgeMs: p.maxAge !== undefined ? Number(p.maxAge) * 3600_000 : undefined,
      cacheOnly: p.cacheOnly === '1' || p.cacheOnly === 'true',
    });
  });

  app.post('/api/works', async (req) => {
    const b = (req.body ?? {}) as { ids?: number[]; priority?: string; wait?: number; maxAge?: number; cacheOnly?: boolean };
    return gw.works(b.ids ?? [], {
      priority: b.priority === 'high' ? 'high' : 'low',
      waitMs: Math.min(Number(b.wait ?? 0), 60) * 1000,
      maxAgeMs: b.maxAge !== undefined ? b.maxAge * 3600_000 : undefined,
      cacheOnly: b.cacheOnly === true,
    });
  });

  app.get<{ Params: { id: string } }>('/api/series/:id', async (req, reply) => {
    const p = q(req);
    const s = await gw.series(Number(req.params.id), p.priority === 'high' ? 'high' : 'low', undefined, p.cacheOnly === '1' || p.cacheOnly === 'true');
    return s ?? reply.code(404).send({ error: 'Series not found or not yet fetched' });
  });

  app.get('/api/status', async () => ({
    limiter: gw.limiter.status(),
    lastError: gw.lastError,
    cache: cache.stats(),
    refresher: { enabled: !!(config.tracksyncUrl && config.internalToken && config.refreshIntervalMs), running: refresher.running, lastRun: refresher.lastRun, lastResult: refresher.lastResult, intervalHours: config.refreshIntervalMs / 3600_000 },
  }));

  app.post('/api/refresh', async () => {
    void refresher.runOnce();
    return { started: true };
  });

  /** Newest desktop-reader release, for the reader's update check (needs GITHUB_TOKEN in .env). */
  app.get('/api/app-update', async (req) => {
    if (!updates.configured) return { configured: false };
    const { release, error } = await updates.latest(q(req).force === '1');
    return { configured: true, error, ...(release ? { version: release.version, name: release.name, notes: release.notes, url: release.url, publishedAt: release.publishedAt, files: release.assets.map(({ name, size }) => ({ name, size })) } : {}) };
  });

  app.get<{ Params: { name: string } }>('/api/app-update/download/:name', async (req, reply) => {
    if (!updates.configured) return reply.code(404).send({ error: 'Updates are not configured (GITHUB_TOKEN)' });
    const r = await updates.download(req.params.name).catch(() => null);
    if (!r) return reply.code(404).send({ error: 'No such file in the latest release' });
    reply.header('Content-Type', 'application/octet-stream').header('Content-Disposition', `attachment; filename="${req.params.name.replace(/"/g, '')}"`);
    const len = r.headers.get('content-length');
    if (len) reply.header('Content-Length', len);
    const { Readable } = await import('node:stream');
    return reply.send(Readable.fromWeb(r.body as import('node:stream/web').ReadableStream));
  });

  app.get('/healthz', async () => ({ ok: true }));

  if (config.downloadsDir && existsSync(config.downloadsDir)) {
    await app.register(fastifyStatic, { root: config.downloadsDir, prefix: '/downloads/', list: true });
  }

  app.addHook('onReady', async () => refresher.start());
  app.addHook('onClose', async () => { refresher.stop(); cache.close(); });
  return Object.assign(app, { gateway: gw, refresher, updates }) as unknown as TrackerApp;
}
