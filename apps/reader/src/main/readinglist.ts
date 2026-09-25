import { EventEmitter } from 'node:events';
import {
  Ao3Client, Ao3RateLimiter, RateLimitedError, chaptersFinished, workIdFromUrl, seriesIdFromUrl, browseUrl, listingTitle, listingFilters,
  type FetchLike, type LimiterStatus, type SyncEngine, type WorkMeta,
} from '@ao3track/core';
import { lookupWorks, parseSeriesPage } from '@ao3track/core/parse';
import type { JsonStore } from './jsonstore.ts';
import type { MetaCacheFile, Prefs } from './state.ts';

const TTL = 6 * 3600_000;
const ORIGIN = process.env.AO3TRACK_AO3_ORIGIN || 'https://archiveofourown.org';
const link = (key: string) => browseUrl(key).replace('https://archiveofourown.org', ORIGIN);

export interface ReadingListItem {
  key: string;
  url: string;
  kind: 'work' | 'series' | 'other';
  id: number | null;
  addedAt: number;
  title: string;
  authors: string[];
  fandoms: string[];
  summary: string;
  rating: string | null;
  words: number | null;
  chaptersPublished: number | null;
  chaptersTotal: number | null;
  chaptersRead: number;
  unread: number | null;
  complete: boolean;
  updated: string | null;
  fetchedAt: number | null;
  missing: boolean;
  favourite: boolean;
  continueUrl: string;
  seriesWorks?: number;
  /** Filters applied to a listing ("complete only · English"), '' otherwise. */
  detail: string;
}

export interface RefreshStatus {
  mode: 'tracker' | 'direct';
  running: boolean;
  pending: number;
  lastRefresh: number | null;
  limiter: LimiterStatus | null;
  error: string | null;
}

/**
 * Keeps metadata for reading-list entries fresh while being careful with AO3:
 *  - if a tracker service is configured, all AO3 traffic goes through it;
 *  - otherwise requests go through a local rate limiter using the reader's
 *    own AO3 session (so works restricted to logged-in users resolve);
 *  - pages the user browses feed the cache for free (see ingest*).
 */
export class ReadingListService extends EventEmitter {
  readonly limiter: Ao3RateLimiter;
  private client: Ao3Client;
  private running = false;
  private lastRefresh: number | null = null;
  private lastError: string | null = null;
  private pending = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private engine: SyncEngine,
    private meta: JsonStore<MetaCacheFile>,
    private prefs: () => Prefs,
    ao3Fetch: FetchLike,
  ) {
    super();
    this.limiter = new Ao3RateLimiter();
    this.client = new Ao3Client({ limiter: this.limiter, fetch: ao3Fetch, maxRateLimitRetries: 1, origin: process.env.AO3TRACK_AO3_ORIGIN || undefined });
    this.limiter.onStatus(() => this.emit('status', this.status()));
  }

  get mode(): 'tracker' | 'direct' { return this.prefs().trackerUrl.trim() ? 'tracker' : 'direct'; }

  status(): RefreshStatus {
    return { mode: this.mode, running: this.running, pending: this.pending, lastRefresh: this.lastRefresh, limiter: this.mode === 'direct' ? this.limiter.status() : this.trackerLimiter, error: this.lastError };
  }
  private trackerLimiter: LimiterStatus | null = null;

  /** The user's own browsing tripped AO3's limit: stop background requests too. */
  reportBrowsingRateLimited(retryAfterMs: number | null) {
    this.limiter.reportRateLimited(retryAfterMs);
  }

  items(): ReadingListItem[] {
    const favs = new Set(this.prefs().favourites);
    return Object.entries(this.engine.state.readingList.paths).map(([key, addedAt]) => {
      const workid = workIdFromUrl(key);
      const seriesid = workid ? null : seriesIdFromUrl(key);
      const base = {
        key, url: link(key), addedAt, favourite: favs.has(key), summary: '', rating: null, words: null,
        authors: [] as string[], fandoms: [] as string[], chaptersPublished: null, chaptersTotal: null,
        chaptersRead: 0, unread: null, complete: false, updated: null, fetchedAt: null, missing: false, continueUrl: link(key), detail: '',
      };
      if (workid) {
        const m: WorkMeta | undefined = this.meta.data.works[workid];
        const saved = this.engine.getWork(workid);
        const read = saved ? chaptersFinished(saved) : 0;
        const pub = m?.chaptersPublished ?? null;
        return {
          ...base, kind: 'work' as const, id: workid,
          title: m?.title ?? `Work ${workid}`, authors: m?.authors ?? [], fandoms: m?.fandoms ?? [], summary: m?.summary ?? '',
          rating: m?.rating ?? null, words: m?.words ?? null, chaptersPublished: pub, chaptersTotal: m?.chaptersTotal ?? null,
          chaptersRead: read, unread: pub === null ? null : Math.max(0, pub - read), complete: !!m?.complete, updated: m?.updated ?? null,
          fetchedAt: m?.fetchedAt ?? null, missing: !m && !!this.meta.data.missing[workid],
          continueUrl: saved ? `${ORIGIN}/works/${workid}${saved.chapterid ? `/chapters/${saved.chapterid}` : ''}#ao3tjump` : base.url,
        };
      }
      if (seriesid) {
        const s = this.meta.data.series[seriesid];
        let unread: number | null = null;
        // A series has no fandoms of its own: use its works', most common first.
        const fandomCount = new Map<string, number>();
        if (s) {
          unread = 0;
          for (const w of s.workIds) {
            const m = this.meta.data.works[w];
            const saved = this.engine.getWork(w);
            if (m?.chaptersPublished != null) unread += Math.max(0, m.chaptersPublished - (saved ? chaptersFinished(saved) : 0));
            for (const f of m?.fandoms ?? []) fandomCount.set(f, (fandomCount.get(f) ?? 0) + 1);
          }
        }
        const fandoms = [...fandomCount.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f);
        return { ...base, kind: 'series' as const, id: seriesid, title: s?.title ?? `Series ${seriesid}`, authors: s?.authors ?? [], fandoms,
          unread, complete: !!s?.complete, updated: s?.updated ?? null, fetchedAt: s?.fetchedAt ?? null, seriesWorks: s?.workIds.length };
      }
      return { ...base, kind: 'other' as const, id: null, title: listingTitle(key), detail: listingFilters(key) };
    });
  }

  // ---- free metadata from pages the user is browsing ----
  ingestWorks(works: WorkMeta[]) {
    if (!works.length) return;
    for (const w of works) { this.meta.data.works[w.workid] = w; delete this.meta.data.missing[w.workid]; }
    this.meta.save(2000);
    this.emit('changed');
  }

  // ---- refresh ----
  startSchedule() {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      const h = this.prefs().refreshHours;
      if (h > 0 && (!this.lastRefresh || Date.now() - this.lastRefresh > h * 3600_000)) void this.refresh(false);
    }, 10 * 60_000);
    setTimeout(() => void this.refresh(false), 20_000);
  }

  /** Refresh stale entries (or specific keys). `manual` bumps priority, never the rate. */
  async refresh(manual: boolean, onlyKeys?: string[]) {
    if (this.running) return;
    this.running = true;
    this.lastError = null;
    const ttl = manual ? 15 * 60_000 : TTL;
    const items = this.items().filter((i) => !onlyKeys || onlyKeys.includes(i.key));
    const now = Date.now();
    const stale = (at: number | null | undefined) => !at || now - at > ttl;
    const workIds = items.filter((i) => i.kind === 'work' && stale(i.fetchedAt ?? this.meta.data.missing[i.id!])).map((i) => i.id!);
    const seriesIds = items.filter((i) => i.kind === 'series' && stale(i.fetchedAt)).map((i) => i.id!);
    this.pending = workIds.length + seriesIds.length;
    this.emit('status', this.status());
    try {
      if (this.mode === 'tracker') await this.viaTracker(workIds, seriesIds, manual);
      else await this.direct(workIds, seriesIds, manual);
      this.lastRefresh = Date.now();
    } catch (e) {
      this.lastError = e instanceof RateLimitedError ? 'AO3 asked us to slow down — will resume automatically.' : (e as Error).message;
    } finally {
      this.running = false;
      this.pending = 0;
      this.meta.save();
      this.emit('changed');
      this.emit('status', this.status());
    }
  }

  private async direct(workIds: number[], seriesIds: number[], manual: boolean) {
    const priority = manual ? 'high' : 'low';
    for (const s of seriesIds) {
      const html = await this.client.getHtml(`/series/${s}`, priority);
      const { series, works } = parseSeriesPage(html, s);
      if (series) this.meta.data.series[s] = series;
      this.ingestWorks(works);
      this.pending--;
    }
    const { missing } = await lookupWorks(this.client, workIds, {
      priority,
      onResult: (w) => { this.meta.data.works[w.workid] = w; delete this.meta.data.missing[w.workid]; this.pending--; this.emit('changed'); },
    });
    for (const id of missing) this.meta.data.missing[id] = Date.now();
  }

  private async viaTracker(workIds: number[], seriesIds: number[], manual: boolean) {
    const base = this.prefs().trackerUrl.trim().replace(/\/+$/, '');
    const key = this.prefs().trackerKey.trim();
    const auth: Record<string, string> = key ? { 'X-Api-Key': key } : {};
    for (const s of seriesIds) {
      const r = await fetch(`${base}/api/series/${s}${manual ? '?priority=high' : ''}`, { headers: auth });
      if (r.status === 401) throw new Error('The tracker needs an API key — add it in Settings.');
      if (r.ok) this.meta.data.series[s] = await r.json();
      this.pending--;
    }
    // Ask, then poll while the tracker works through its queue at AO3's pace.
    let remaining = workIds;
    const invisible: number[] = [];
    for (let round = 0; remaining.length && round < 30; round++) {
      const r = await fetch(`${base}/api/works`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify({ ids: remaining, priority: manual ? 'high' : 'low', wait: round === 0 ? 15 : 30, maxAge: (manual ? 0.25 : 6) }),
      });
      if (r.status === 401) throw new Error('The tracker needs an API key — add it in Settings.');
      if (!r.ok) throw new Error(`Tracker returned HTTP ${r.status}`);
      const body = (await r.json()) as { works: WorkMeta[]; missing: number[]; pending: number[]; limiter: LimiterStatus };
      this.trackerLimiter = body.limiter;
      this.ingestWorks(body.works);
      invisible.push(...body.missing);
      remaining = body.pending;
      this.pending = remaining.length;
      this.emit('status', this.status());
    }
    // Works the tracker couldn't see anonymously are usually restricted to logged-in
    // users: fetch just those with the reader's own AO3 session. Anything still pending
    // is waiting on the tracker's rate limiter, so we deliberately don't retry it here
    // (we'd share the same IP and make AO3's limit worse).
    if (invisible.length) await this.direct(invisible, [], manual);
  }
}
