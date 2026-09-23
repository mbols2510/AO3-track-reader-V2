/**
 * Client-side sync engine (the logic that lived in background.ts and
 * SyncedStorage.cs). Storage is pluggable: the extension persists to
 * chrome.storage, the desktop reader to a JSON file.
 */
import type { StoredWorkChapter, WorkChapter } from './types.ts';
import { isAhead, isAheadOrEqual } from './location.ts';
import { readingListKey } from './ao3url.ts';
import { ListFilterSet } from './filters.ts';
import { TrackSyncClient, SyncHttpError, type Credentials } from './syncclient.ts';
import type { FetchLike } from './ao3client.ts';

export interface SyncState {
  serverUrl: string | null;
  auth: Credentials | null;
  works: Record<string, StoredWorkChapter>;
  unsynced: string[];
  worksLastSync: number;
  readingList: { last_sync: number; paths: Record<string, number> };
  listFilters: { last_sync: number; filters: Record<string, number> };
  /** Server clock minus local clock, so timestamps agree across devices. */
  timeOffset: number;
  lastSyncAt: number | null;
  lastSyncError: string | null;
}

export const emptySyncState = (): SyncState => ({
  serverUrl: null, auth: null, works: {}, unsynced: [], worksLastSync: 0,
  readingList: { last_sync: 0, paths: {} }, listFilters: { last_sync: 0, filters: {} },
  timeOffset: 0, lastSyncAt: null, lastSyncError: null,
});

export type SyncStatus = 'disabled' | 'idle' | 'syncing' | 'error';

export interface SyncResult { ok: boolean; error?: string; changed: boolean }

export class SyncEngine {
  state: SyncState;
  status: SyncStatus;
  private filterSet: ListFilterSet;
  private current: Promise<SyncResult> | null = null;
  private again = false;
  private listeners = new Set<() => void>();

  constructor(
    state: Partial<SyncState>,
    private readonly save: (s: SyncState) => void | Promise<void>,
    private readonly fetchImpl?: FetchLike,
    private readonly clock: () => number = () => Date.now(),
  ) {
    this.state = { ...emptySyncState(), ...state };
    this.status = this.state.auth && this.state.serverUrl ? 'idle' : 'disabled';
    this.filterSet = new ListFilterSet(Object.keys(this.state.listFilters.filters));
  }

  onChange(fn: () => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private changed() {
    this.filterSet = new ListFilterSet(Object.keys(this.state.listFilters.filters));
    void this.save(this.state);
    for (const l of this.listeners) try { l(); } catch { /* ignore */ }
  }

  now() { return this.clock() + this.state.timeOffset; }

  private client(): TrackSyncClient | null {
    if (!this.state.serverUrl || !this.state.auth) return null;
    const c = new TrackSyncClient(this.state.serverUrl, this.fetchImpl);
    c.auth = this.state.auth;
    return c;
  }

  // ---------- account ----------

  async signIn(serverUrl: string, username: string, password: string, create = false, email?: string) {
    const c = new TrackSyncClient(serverUrl, this.fetchImpl);
    const r = create ? await c.create(username, password, email) : await c.login(username, password);
    if ('errors' in r) return r;
    this.state.serverUrl = c.baseUrl;
    this.state.auth = { username, credential: r.credential };
    // A new account or server: send everything we have.
    this.state.worksLastSync = 0;
    this.state.unsynced = Object.keys(this.state.works);
    this.state.readingList.last_sync = 0;
    this.state.listFilters.last_sync = 0;
    this.status = 'idle';
    this.changed();
    return { ok: true as const };
  }

  signOut() {
    this.state.auth = null;
    this.status = 'disabled';
    this.changed();
  }

  // ---------- works ----------

  getWork(id: number): StoredWorkChapter | undefined { return this.state.works[String(id)]; }

  /** Record a reading position. Only moves forward unless `force` (which bumps seq). */
  setWork(id: number, wc: WorkChapter, force = false): boolean {
    const key = String(id);
    const cur = this.state.works[key];
    const seq = force ? (cur?.seq ?? 0) + 1 : (wc.seq ?? cur?.seq ?? 0);
    const next = { ...wc, seq };
    if (cur && !force && !isAhead(cur, next)) return false;
    this.state.works[key] = { number: wc.number, chapterid: wc.chapterid, location: wc.location, timestamp: this.now(), seq };
    if (!this.state.unsynced.includes(key)) this.state.unsynced.push(key);
    this.changed();
    return true;
  }

  // ---------- reading list ----------

  inReadingList(url: string): boolean {
    const k = readingListKey(url);
    return !!k && k in this.state.readingList.paths;
  }
  addToReadingList(url: string): string | null {
    const k = readingListKey(url);
    if (!k || k in this.state.readingList.paths) return k;
    this.state.readingList.paths[k] = this.now();
    this.changed();
    return k;
  }
  removeFromReadingList(url: string): boolean {
    const k = readingListKey(url) ?? url;
    if (!(k in this.state.readingList.paths)) return false;
    delete this.state.readingList.paths[k];
    this.changed();
    return true;
  }

  // ---------- list filters ----------

  filters() { return this.filterSet; }
  addFilter(f: string): string | null {
    const k = ListFilterSet.normalise(f);
    if (!k || k in this.state.listFilters.filters) return k;
    this.state.listFilters.filters[k] = this.now();
    this.changed();
    return k;
  }
  removeFilter(f: string) {
    const k = ListFilterSet.normalise(f) ?? f;
    if (!(k in this.state.listFilters.filters)) return false;
    delete this.state.listFilters.filters[k];
    this.changed();
    return true;
  }

  // ---------- sync ----------

  /** Sync everything. Concurrent calls coalesce into at most one extra run. */
  sync(): Promise<SyncResult> {
    if (this.current) { this.again = true; return this.current; }
    this.current = (async () => {
      let r: SyncResult;
      do {
        this.again = false;
        r = await this.syncOnce();
      } while (this.again && r.ok);
      return r;
    })().finally(() => { this.current = null; });
    return this.current;
  }

  private async syncOnce(): Promise<SyncResult> {
    const c = this.client();
    if (!c) { this.status = 'disabled'; return { ok: false, error: 'Not signed in', changed: false }; }
    this.status = 'syncing';
    for (const l of this.listeners) try { l(); } catch { /* ignore */ }
    let changed = false;
    try {
      try {
        const serverTime = await c.time();
        if (Number.isFinite(serverTime)) this.state.timeOffset = serverTime - this.clock();
      } catch { /* optional */ }
      changed = (await this.syncWorks(c)) || changed;
      changed = (await this.syncSet(c, 'readingList')) || changed;
      try { changed = (await this.syncSet(c, 'listFilters')) || changed; } catch { /* old servers */ }
      this.state.lastSyncAt = this.clock();
      this.state.lastSyncError = null;
      this.status = 'idle';
      this.changed();
      return { ok: true, changed };
    } catch (e) {
      const msg = (e as Error).message;
      this.state.lastSyncError = msg;
      if (e instanceof SyncHttpError && (e.status === 401 || e.status === 403)) {
        this.state.auth = null;
        this.status = 'disabled';
      } else this.status = 'error';
      this.changed();
      return { ok: false, error: msg, changed };
    }
  }

  private async syncWorks(c: TrackSyncClient, depth = 0): Promise<boolean> {
    const s = this.state;
    let changed = false;
    const items = await c.getValues(s.worksLastSync);
    let lastSync = s.worksLastSync;
    for (const [key, item] of Object.entries(items)) {
      if (item.timestamp > lastSync) lastSync = item.timestamp;
      const local = s.works[key];
      if (!local || isAheadOrEqual(local, item)) {
        s.works[key] = { ...item, seq: item.seq ?? 0 };
        s.unsynced = s.unsynced.filter((k) => k !== key);
        changed = true;
      } else {
        // Our copy is further along: make it newer than the server's and push it.
        if (local.timestamp <= item.timestamp) local.timestamp = item.timestamp + 1;
        if (!s.unsynced.includes(key)) s.unsynced.push(key);
      }
    }
    s.worksLastSync = lastSync;
    if (s.unsynced.length) {
      const batch: Record<string, StoredWorkChapter> = {};
      let time = s.worksLastSync;
      for (const k of s.unsynced) {
        const w = s.works[k];
        if (!w) continue;
        batch[k] = w;
        if (w.timestamp > time) time = w.timestamp;
      }
      const sent = new Set(Object.keys(batch));
      const conflicts = await c.postValues(batch);
      s.unsynced = s.unsynced.filter((k) => !sent.has(k));
      if (Object.keys(conflicts).length && depth < 2) {
        // Server had newer data for some works: pull everything again.
        s.worksLastSync = 0;
        return (await this.syncWorks(c, depth + 1)) || changed;
      }
      if (time > s.worksLastSync) s.worksLastSync = time;
    }
    return changed;
  }

  private async syncSet(c: TrackSyncClient, which: 'readingList' | 'listFilters'): Promise<boolean> {
    let changed = false;
    if (which === 'readingList') {
      const local = this.state.readingList;
      const r = await c.syncReadingList({ last_sync: local.last_sync, paths: { ...local.paths } });
      for (const [k, v] of Object.entries(r.paths ?? {})) {
        if (v === -1) delete local.paths[k];
        else local.paths[k] = v;
        changed = true;
      }
      local.last_sync = r.last_sync;
    } else {
      const local = this.state.listFilters;
      const r = await c.syncListFilters({ last_sync: local.last_sync, filters: { ...local.filters } });
      for (const [k, v] of Object.entries(r.filters ?? {})) {
        if (v === -1) delete local.filters[k];
        else local.filters[k] = v;
        changed = true;
      }
      local.last_sync = r.last_sync;
    }
    return changed;
  }
}
