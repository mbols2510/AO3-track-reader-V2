import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { WorkMeta, SeriesMeta } from '@ao3track/core';

function openSqlite(path: string): DatabaseSync {
  try {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    return new DatabaseSync(path);
  } catch (err) {
    const e = err as { code?: string; errcode?: number };
    if (e.code === 'EACCES' || e.code === 'EPERM' || e.errcode === 14) {
      const who = typeof process.getuid === 'function' ? ` (running as uid ${process.getuid()}, gid ${process.getgid?.()})` : '';
      throw new Error(
        `Cannot create or open the database at ${path}${who}. The folder isn't writable by this process. ` +
          'In Docker, set PUID/PGID to the owner of the mounted data folder, or chown that folder to the uid shown here.',
        { cause: err },
      );
    }
    throw err;
  }
}

/** SQLite cache of AO3 metadata. `missing` rows remember works AO3 didn't show us. */
export class MetaCache {
  private db: DatabaseSync;
  constructor(path: string) {
    this.db = openSqlite(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS works (workid INTEGER PRIMARY KEY, status TEXT NOT NULL, json TEXT, fetched_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS series (seriesid INTEGER PRIMARY KEY, json TEXT NOT NULL, fetched_at INTEGER NOT NULL);
    `);
  }

  getWorks(ids: number[]): Map<number, { status: 'ok' | 'missing'; meta: WorkMeta | null; fetchedAt: number }> {
    const out = new Map<number, { status: 'ok' | 'missing'; meta: WorkMeta | null; fetchedAt: number }>();
    const stmt = this.db.prepare('SELECT * FROM works WHERE workid = ?');
    for (const id of ids) {
      const r = stmt.get(id) as { status: 'ok' | 'missing'; json: string | null; fetched_at: number } | undefined;
      if (r) out.set(id, { status: r.status, meta: r.json ? JSON.parse(r.json) : null, fetchedAt: r.fetched_at });
    }
    return out;
  }

  putWork(w: WorkMeta) {
    this.db.prepare('INSERT OR REPLACE INTO works (workid, status, json, fetched_at) VALUES (?, ?, ?, ?)').run(w.workid, 'ok', JSON.stringify(w), w.fetchedAt);
  }

  putMissing(id: number, at = Date.now()) {
    // Keep stale metadata for a work that vanished from search; only mark truly unknown ones missing.
    const r = this.db.prepare("UPDATE works SET fetched_at = ? WHERE workid = ? AND status = 'ok'").run(at, id);
    if (!Number(r.changes)) this.db.prepare('INSERT OR REPLACE INTO works (workid, status, json, fetched_at) VALUES (?, ?, NULL, ?)').run(id, 'missing', at);
  }

  getSeries(id: number): { meta: SeriesMeta; fetchedAt: number } | null {
    const r = this.db.prepare('SELECT * FROM series WHERE seriesid = ?').get(id) as { json: string; fetched_at: number } | undefined;
    return r ? { meta: JSON.parse(r.json), fetchedAt: r.fetched_at } : null;
  }

  putSeries(s: SeriesMeta) {
    this.db.prepare('INSERT OR REPLACE INTO series (seriesid, json, fetched_at) VALUES (?, ?, ?)').run(s.seriesid, JSON.stringify(s), s.fetchedAt);
  }

  stats() {
    const n = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
    return { works: n("SELECT COUNT(*) AS n FROM works WHERE status='ok'"), missing: n("SELECT COUNT(*) AS n FROM works WHERE status='missing'"), series: n('SELECT COUNT(*) AS n FROM series') };
  }

  close() { this.db.close(); }
}
