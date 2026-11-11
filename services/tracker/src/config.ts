import { resolve } from 'node:path';

const num = (v: string | undefined, d: number) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

export function loadConfig(env = process.env) {
  return {
    port: num(env.PORT, 8081),
    host: env.HOST ?? '0.0.0.0',
    dbPath: env.DB_PATH ?? './data/tracker.db',
    tracksyncUrl: env.TRACKSYNC_URL?.replace(/\/+$/, '') || null,
    internalToken: env.INTERNAL_TOKEN || null,
    /** Metadata younger than this is served from cache without asking AO3. */
    cacheTtlMs: num(env.CACHE_TTL_HOURS, 6) * 3600_000,
    /** How often the reading-list refresher runs (0 disables it). */
    refreshIntervalMs: num(env.REFRESH_INTERVAL_HOURS, 6) * 3600_000,
    limiter: {
      burst: num(env.RATE_BURST, 2),
      refillMs: num(env.RATE_REFILL_SECONDS, 12) * 1000,
      minIntervalMs: num(env.RATE_MIN_INTERVAL_SECONDS, 2) * 1000,
      defaultPauseMs: num(env.RATE_PAUSE_MINUTES, 5) * 60_000,
    },
    /** Optional AO3 session cookie so restricted (logged-in only) works resolve. */
    ao3Cookie: env.AO3_COOKIE || null,
    /** Testing only: point at a fake AO3. */
    ao3Origin: env.AO3_ORIGIN || undefined,
    userAgent: env.USER_AGENT || 'Ao3Track/2.0 (self-hosted personal reading tracker)',
    downloadsDir: env.DOWNLOADS_DIR ? resolve(env.DOWNLOADS_DIR) : null,
    /** When set, /api/* requires this key (X-Api-Key header or Bearer token). Set it before exposing the tracker to the internet. */
    apiKey: env.API_KEY || null,
    /** Optional read-only GitHub token, only needed while the repository is private. */
    githubToken: env.GITHUB_TOKEN || null,
    /** owner/name of the repository; set GITHUB_REPO to an empty value to turn update checks off. */
    githubRepo: env.GITHUB_REPO ?? 'mbols2510/AO3-track-reader-V2',
    /** Testing only: point at a fake GitHub API. */
    githubApi: (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, ''),
    corsOrigins: (env.CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  };
}
export type Config = ReturnType<typeof loadConfig>;
