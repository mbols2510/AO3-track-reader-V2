import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

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

const SCHEMA_VERSION = 1;

export type Db = DatabaseSync;

export function openDb(path: string): Db {
  const db = openSqlite(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      email TEXT UNIQUE COLLATE NOCASE,
      roles TEXT NOT NULL DEFAULT 'users',
      pwhash TEXT NOT NULL,
      created INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userid INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      hash BLOB NOT NULL UNIQUE,
      label TEXT,
      created INTEGER NOT NULL,
      last_used INTEGER
    );
    CREATE TABLE IF NOT EXISTS works (
      userid INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      id INTEGER NOT NULL,
      chapterid INTEGER NOT NULL,
      number INTEGER NOT NULL,
      timestamp INTEGER NOT NULL,
      location INTEGER,
      seq INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (userid, id)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS works_ts ON works (userid, timestamp);
    CREATE TABLE IF NOT EXISTS reading_list (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userid INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      UNIQUE (userid, path)
    );
    CREATE TABLE IF NOT EXISTS list_filters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userid INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      data TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      UNIQUE (userid, data)
    );
    CREATE TABLE IF NOT EXISTS error_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      received INTEGER NOT NULL,
      body TEXT NOT NULL
    );
  `);
  db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
  return db;
}

/** Run fn inside a transaction (node:sqlite has no helper for this). */
export function tx<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** Tiny prepared-statement cache. */
export class Stmts {
  private cache = new Map<string, StatementSync>();
  constructor(private readonly db: Db) {}
  get(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }
}
