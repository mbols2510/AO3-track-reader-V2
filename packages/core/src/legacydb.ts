/**
 * Import from the original Windows app's local database, for when the old
 * cloud service is unreachable. The UWP app kept it at:
 *   %LOCALAPPDATA%\Packages\<Archive Track Reader package>\LocalState\Ao3TrackSQLite.db3
 * Requires Node >= 22.13 (node:sqlite).
 */
import { DatabaseSync } from 'node:sqlite';
import type { AccountExport } from './legacy.ts';
import { normaliseWorks } from './legacy.ts';

export function exportFromLegacyDb(path: string): AccountExport {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name),
    );
    if (!tables.has('Work')) throw new Error('This does not look like an Archive Track Reader database (no Work table).');

    const works: Record<string, Record<string, unknown>> = {};
    // Read as BigInt so one out-of-range value can't abort the whole import; the server clamps it.
    const q = db.prepare('SELECT id, chapterid, number, timestamp, location, seq FROM Work');
    q.setReadBigInts(true);
    for (const r of q.all() as Record<string, bigint | number | string | null>[]) {
      const v = Object.fromEntries(Object.entries(r).map(([k, x]) => [k, typeof x === 'bigint' ? Number(x) : x]));
      works[String(v.id)] = v;
    }
    const readingList: Record<string, number> = {};
    const favourites: string[] = [];
    if (tables.has('ReadingList')) {
      const cols = new Set((db.prepare('PRAGMA table_info(ReadingList)').all() as { name: string }[]).map((c) => c.name));
      const favCol = cols.has('Favourite') ? ', Favourite' : '';
      for (const r of db.prepare(`SELECT Uri, Timestamp${favCol} FROM ReadingList`).all() as Record<string, unknown>[]) {
        if (typeof r.Uri !== 'string' || !r.Uri) continue;
        readingList[r.Uri] = Number(r.Timestamp ?? 0);
        if (r.Favourite) favourites.push(r.Uri);
      }
    }
    const listFilters: Record<string, number> = {};
    if (tables.has('ListFilter')) {
      for (const r of db.prepare('SELECT data, timestamp FROM ListFilter').all() as { data: string; timestamp: number }[]) {
        if (r.data) listFilters[r.data] = Number(r.timestamp ?? 0);
      }
    }
    let username = '';
    if (tables.has('Variable')) {
      const row = db.prepare("SELECT value FROM Variable WHERE name = 'authorization.username'").get() as { value?: string } | undefined;
      username = row?.value ?? '';
    }
    return {
      format: 'ao3track-export',
      version: 1,
      source: `file:${path}`,
      username,
      exportedAt: new Date().toISOString(),
      works: normaliseWorks(works as never),
      readingList,
      listFilters,
      favourites,
    };
  } finally {
    db.close();
  }
}
