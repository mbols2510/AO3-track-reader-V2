/**
 * The three sync algorithms, ported line-for-line from the original
 * ValuesController / ReadingListController / ListFiltersController so that
 * existing clients behave identically.
 */
import type { Db } from './db.ts';
import { Stmts, tx } from './db.ts';
import type { StoredWorkChapter, ReadingListSync, ListFiltersSync } from '@ao3track/core';
import { isAhead } from '@ao3track/core';

interface WorkRow extends StoredWorkChapter { id: number }

const toWire = (r: WorkRow): StoredWorkChapter => ({
  chapterid: r.chapterid, number: r.number, location: r.location, timestamp: r.timestamp, seq: r.seq,
});

/** Largest whole number JavaScript (and so every app) can hold exactly. */
const MAX = Number.MAX_SAFE_INTEGER;
const clamp = (n: number) => Math.min(MAX, Math.max(-MAX, n));

const int = (v: unknown, dflt = 0): number => {
  const n = typeof v === 'string' || typeof v === 'bigint' ? Number(v) : (v as number);
  return Number.isFinite(n) ? clamp(Math.trunc(n)) : dflt;
};
const loc = (v: unknown): number | null => (v === null || v === undefined ? null : int(v));

/**
 * A value read from the database. Rows written before 2.2.1 (e.g. brought over from the
 * original service) can hold numbers too large for JavaScript; node:sqlite would throw on
 * the whole query, so those are read as BigInt and clamped instead. Stored data is untouched.
 */
const num = (v: unknown): number => (typeof v === 'bigint' ? (v > BigInt(MAX) ? MAX : v < BigInt(-MAX) ? -MAX : Number(v)) : (v as number));
const fromDb = (r: Record<string, unknown>): WorkRow => ({
  id: num(r.id), chapterid: num(r.chapterid), number: num(r.number), timestamp: num(r.timestamp), seq: num(r.seq),
  location: r.location === null || r.location === undefined ? null : typeof r.location === 'string' ? int(r.location) : num(r.location),
});

export class SyncStore {
  private s: Stmts;
  constructor(private readonly db: Db) {
    this.s = new Stmts(db);
  }

  /** A statement over works rows that can't be broken by one out-of-range value. */
  private works(sql: string) {
    const st = this.s.get(sql);
    st.setReadBigInts(true);
    return st;
  }

  // ---- api/Values -------------------------------------------------------

  getWorks(userid: number, after = 0, onlyId?: number): Record<string, StoredWorkChapter> {
    const rows = (onlyId !== undefined
      ? this.works('SELECT * FROM works WHERE userid = ? AND id = ? AND timestamp > ?').all(userid, onlyId, after)
      : this.works('SELECT * FROM works WHERE userid = ? AND timestamp > ?').all(userid, after)).map((r) => fromDb(r));
    const out: Record<string, StoredWorkChapter> = {};
    for (const r of rows) out[String(r.id)] = toWire(r);
    return out;
  }

  /** Upsert; returns server copies of rows that were newer (conflicts). */
  postWorks(userid: number, values: Record<string, Partial<StoredWorkChapter>>): Record<string, StoredWorkChapter> {
    const conflicts: Record<string, StoredWorkChapter> = {};
    tx(this.db, () => {
      for (const [key, v] of Object.entries(values ?? {})) {
        const id = int(key, -1);
        if (id <= 0 || !v) continue;
        const incoming: StoredWorkChapter = {
          chapterid: int(v.chapterid), number: int(v.number, 1),
          location: v.location === null || v.location === undefined ? null : int(v.location),
          timestamp: int(v.timestamp), seq: int(v.seq),
        };
        const row = this.works('SELECT * FROM works WHERE userid = ? AND id = ?').get(userid, id);
        const existing = row ? fromDb(row) : undefined;
        if (!existing) {
          // Deleted in the dashboard after this position was recorded: a device that hasn't
          // heard about the deletion yet is re-sending it. Drop it; the device will forget it.
          const del = this.s.get('SELECT timestamp FROM deleted_works WHERE userid = ? AND id = ?').get(userid, id) as { timestamp: number } | undefined;
          if (del && del.timestamp >= incoming.timestamp) continue;
          if (del) this.s.get('DELETE FROM deleted_works WHERE userid = ? AND id = ?').run(userid, id); // read again since: track it again
          this.s.get('INSERT INTO works (userid, id, chapterid, number, timestamp, location, seq) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(userid, id, incoming.chapterid, incoming.number, incoming.timestamp, incoming.location, incoming.seq);
        } else if (existing.timestamp < incoming.timestamp || existing.seq < incoming.seq) {
          this.s.get('UPDATE works SET chapterid = ?, number = ?, location = ?, timestamp = ?, seq = ? WHERE userid = ? AND id = ?')
            .run(incoming.chapterid, incoming.number, incoming.location, incoming.timestamp, incoming.seq, userid, id);
        } else {
          conflicts[String(id)] = toWire(existing);
        }
      }
    });
    return conflicts;
  }

  deleteWork(userid: number, id: number) {
    return this.deleteWorks(userid, [id]);
  }

  /** Forget reading positions, and remember the deletion so the apps forget them too. */
  deleteWorks(userid: number, ids: number[], now = Date.now()): number {
    let n = 0;
    tx(this.db, () => {
      for (const raw of ids) {
        const id = int(raw, -1);
        if (id <= 0) continue;
        n += Number(this.s.get('DELETE FROM works WHERE userid = ? AND id = ?').run(userid, id).changes);
        this.s.get('INSERT OR REPLACE INTO deleted_works (userid, id, timestamp) VALUES (?, ?, ?)').run(userid, id, now);
      }
    });
    return n;
  }

  /** Deletions newer than `after`, as { workid: deletedAt }. */
  deletedWorks(userid: number, after = 0): Record<string, number> {
    const rows = this.s.get('SELECT id, timestamp FROM deleted_works WHERE userid = ? AND timestamp > ?').all(userid, after) as { id: number; timestamp: number }[];
    return Object.fromEntries(rows.map((r) => [String(r.id), r.timestamp]));
  }

  // ---- api/ReadingList and api/ListFilters (same algorithm, different table) ----

  private syncSet(table: 'reading_list' | 'list_filters', col: 'path' | 'data', userid: number,
    lastSync: number, incomingIn: Record<string, number>): { last_sync: number; items: Record<string, number> } {
    return tx(this.db, () => {
      const incoming = new Map(Object.entries(incomingIn ?? {}).map(([k, v]) => [k, int(v)]));
      incoming.delete('');
      const changes: Record<string, number> = {};
      const rows = this.s.get(`SELECT id, ${col} AS k, timestamp FROM ${table} WHERE userid = ?`).all(userid) as { id: number; k: string; timestamp: number }[];
      const existing = new Map(rows.map((r) => [r.k, r]));

      // The row with an empty key holds this user's sync marker.
      let marker = existing.get('');
      existing.delete('');
      if (!marker) {
        const r = this.s.get(`INSERT INTO ${table} (userid, ${col}, timestamp) VALUES (?, '', 0)`).run(userid);
        marker = { id: Number(r.lastInsertRowid), k: '', timestamp: 0 };
      }
      let latest = marker.timestamp;

      for (const [k, row] of existing) {
        if (row.timestamp > latest) latest = row.timestamp;
        if (!incoming.has(k)) {
          if (row.timestamp >= lastSync) changes[k] = row.timestamp;             // added elsewhere: send to client
          else this.s.get(`DELETE FROM ${table} WHERE id = ?`).run(row.id);       // client deleted it since last sync
        } else {
          incoming.delete(k);
        }
      }
      for (const [k, ts] of incoming) {
        if (ts > latest) latest = ts;
        if (ts >= marker.timestamp) {
          this.s.get(`INSERT OR IGNORE INTO ${table} (userid, ${col}, timestamp) VALUES (?, ?, ?)`).run(userid, k, ts); // new
        } else {
          changes[k] = -1;                                                         // was deleted elsewhere: tell client
        }
      }
      const newMarker = latest + 1;
      this.s.get(`UPDATE ${table} SET timestamp = ? WHERE id = ?`).run(newMarker, marker.id);
      return { last_sync: newMarker, items: changes };
    });
  }

  syncReadingList(userid: number, body: Partial<ReadingListSync>): ReadingListSync {
    const r = this.syncSet('reading_list', 'path', userid, int(body?.last_sync), body?.paths ?? {});
    return { last_sync: r.last_sync, paths: r.items };
  }

  syncListFilters(userid: number, body: Partial<ListFiltersSync>): ListFiltersSync {
    const r = this.syncSet('list_filters', 'data', userid, int(body?.last_sync), body?.filters ?? {});
    return { last_sync: r.last_sync, filters: r.items };
  }

  // ---- helpers for export / import / dashboard ---------------------------

  readingList(userid: number): Record<string, number> {
    const rows = this.s.get("SELECT path, timestamp FROM reading_list WHERE userid = ? AND path <> ''").all(userid) as { path: string; timestamp: number }[];
    return Object.fromEntries(rows.map((r) => [r.path, r.timestamp]));
  }

  listFilters(userid: number): Record<string, number> {
    const rows = this.s.get("SELECT data, timestamp FROM list_filters WHERE userid = ? AND data <> ''").all(userid) as { data: string; timestamp: number }[];
    return Object.fromEntries(rows.map((r) => [r.data, r.timestamp]));
  }

  counts(userid: number) {
    const one = (sql: string) => (this.s.get(sql).get(userid) as { n: number }).n;
    return {
      works: one('SELECT COUNT(*) AS n FROM works WHERE userid = ?'),
      readingList: one("SELECT COUNT(*) AS n FROM reading_list WHERE userid = ? AND path <> ''"),
      listFilters: one("SELECT COUNT(*) AS n FROM list_filters WHERE userid = ? AND data <> ''"),
      lastActivity: ((n) => (n === null ? null : num(n)))((this.works('SELECT MAX(timestamp) AS n FROM works WHERE userid = ?').get(userid) as { n: unknown }).n),
    };
  }

  /**
   * Merge an exported account into this user. Safe to run repeatedly.
   *
   * Timestamps are bumped to "now" for anything that changes, because the
   * protocol only pushes rows newer than a client's last_sync — rows keeping
   * their 2019 timestamps would never reach devices that already synced, and
   * reading-list rows older than a client's last_sync would even be treated
   * as deleted by that client.
   */
  importAccount(userid: number, data: { works: Record<string, StoredWorkChapter>; readingList: Record<string, number>; listFilters: Record<string, number> }) {
    const now = Date.now();
    const result = { worksAdded: 0, worksAdvanced: 0, worksKept: 0, readingListAdded: 0, listFiltersAdded: 0 };
    tx(this.db, () => {
      for (const [key, w] of Object.entries(data.works ?? {})) {
        const id = int(key, -1);
        if (id <= 0) continue;
        const row = this.works('SELECT * FROM works WHERE userid = ? AND id = ?').get(userid, id);
        const existing = row ? fromDb(row) : undefined;
        if (!existing) {
          this.s.get('DELETE FROM deleted_works WHERE userid = ? AND id = ?').run(userid, id); // restoring brings it back
          this.s.get('INSERT INTO works (userid, id, chapterid, number, timestamp, location, seq) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(userid, id, int(w.chapterid), int(w.number, 1), now, loc(w.location), int(w.seq));
          result.worksAdded++;
        } else if (isAhead({ ...existing, seq: 0 }, { number: int(w.number, 1), location: loc(w.location), seq: 0 })) {
          // Imported position is further along: take it, keeping the higher seq.
          this.s.get('UPDATE works SET chapterid = ?, number = ?, location = ?, timestamp = ?, seq = ? WHERE userid = ? AND id = ?')
            .run(int(w.chapterid), int(w.number, 1), loc(w.location), Math.max(now, existing.timestamp + 1), Math.max(existing.seq, int(w.seq)), userid, id);
          result.worksAdvanced++;
        } else {
          result.worksKept++;
        }
      }
      const addSet = (table: 'reading_list' | 'list_filters', col: 'path' | 'data', items: Record<string, number>) => {
        const marker = (this.s.get(`SELECT timestamp FROM ${table} WHERE userid = ? AND ${col} = ''`).get(userid) as { timestamp: number } | undefined)?.timestamp ?? 0;
        const ts = Math.max(now, marker);
        let added = 0;
        for (const k of Object.keys(items ?? {})) {
          if (!k) continue;
          const r = this.s.get(`INSERT OR IGNORE INTO ${table} (userid, ${col}, timestamp) VALUES (?, ?, ?)`).run(userid, k, ts);
          added += Number(r.changes);
        }
        return added;
      };
      result.readingListAdded = addSet('reading_list', 'path', data.readingList);
      result.listFiltersAdded = addSet('list_filters', 'data', data.listFilters);
    });
    return result;
  }

  /** All work and series ids across every user's reading list (for the tracker's refresher). */
  allReadingListTargets(): { works: number[]; series: number[] } {
    const rows = this.s.get("SELECT DISTINCT path FROM reading_list WHERE path <> ''").all() as { path: string }[];
    const works = new Set<number>(), series = new Set<number>();
    for (const { path } of rows) {
      let m = path.match(/\/works\/(\d+)$/);
      if (m) { works.add(Number(m[1])); continue; }
      m = path.match(/\/series\/(\d+)$/);
      if (m) series.add(Number(m[1]));
    }
    return { works: [...works], series: [...series] };
  }
}
