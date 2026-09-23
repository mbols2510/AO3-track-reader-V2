import { TrackSyncClient } from './syncclient.ts';
import type { FetchLike } from './ao3client.ts';
import type { StoredWorkChapter } from './types.ts';

export const LEGACY_API = 'https://wenchy.net/ao3track/api';

/** Everything an account holds, in a portable form. */
export interface AccountExport {
  format: 'ao3track-export';
  version: 1;
  source: string;
  username: string;
  exportedAt: string;
  works: Record<string, StoredWorkChapter>;
  readingList: Record<string, number>;
  listFilters: Record<string, number>;
  /** Only present when imported from the old app's local database. */
  favourites?: string[];
}

/**
 * Pull a complete copy of an account from an Ao3Track sync server (by default
 * the original wenchy.net service). This is read-only: it posts an *empty*
 * reading list / filter set with last_sync=0, which the protocol answers with
 * "here is everything" and never treats as a deletion.
 */
export async function exportFromSyncServer(
  username: string,
  password: string,
  opts: { baseUrl?: string; fetch?: FetchLike } = {},
): Promise<AccountExport> {
  const client = new TrackSyncClient(opts.baseUrl ?? LEGACY_API, opts.fetch);
  const login = await client.login(username, password);
  if ('errors' in login) {
    throw new Error(`Login to ${client.baseUrl} failed: ${Object.values(login.errors).join('; ')}`);
  }
  const works = await client.getValues(0);
  const rl = await client.syncReadingList({ last_sync: 0, paths: {} });
  let filters: Record<string, number> = {};
  try {
    filters = (await client.syncListFilters({ last_sync: 0, filters: {} })).filters ?? {};
  } catch {
    // Very old server builds had no ListFilters endpoint.
  }
  const clean = <T extends Record<string, number>>(o: T) =>
    Object.fromEntries(Object.entries(o ?? {}).filter(([k, v]) => k !== '' && typeof v === 'number' && v >= 0));
  return {
    format: 'ao3track-export',
    version: 1,
    source: client.baseUrl,
    username,
    exportedAt: new Date().toISOString(),
    works: normaliseWorks(works),
    readingList: clean(rl.paths),
    listFilters: clean(filters),
  };
}

export function normaliseWorks(input: Record<string, Partial<StoredWorkChapter>>): Record<string, StoredWorkChapter> {
  const out: Record<string, StoredWorkChapter> = {};
  for (const [k, v] of Object.entries(input ?? {})) {
    const id = Number(k);
    if (!Number.isInteger(id) || id <= 0 || !v) continue;
    out[String(id)] = {
      number: Number(v.number ?? 1),
      chapterid: Number(v.chapterid ?? 0),
      location: v.location === null || v.location === undefined ? null : Number(v.location),
      timestamp: Number(v.timestamp ?? 0),
      seq: Number(v.seq ?? 0),
    };
  }
  return out;
}

export function isAccountExport(x: unknown): x is AccountExport {
  return !!x && typeof x === 'object' && (x as AccountExport).format === 'ao3track-export';
}
