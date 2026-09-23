import type { FormErrors, ListFiltersSync, ReadingListSync, StoredWorkChapter, WorkMap } from './types.ts';
import type { FetchLike } from './ao3client.ts';

export interface Credentials {
  username: string;
  credential: string;
}

export class SyncHttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'SyncHttpError';
  }
}

function b64utf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export const authHeader = (c: Credentials) => `Ao3track ${b64utf8(`${c.username}\n${c.credential}`)}`;

/** Normalise a server URL typed by a user into the API base ("…/api"). */
export function normaliseApiBase(input: string): string {
  let s = input.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  if (!/\/api$/i.test(s)) s = `${s}/api`;
  return s;
}

/**
 * Client for the Ao3Track sync protocol. Works against both the original
 * wenchy.net service and the revived tracksync server.
 */
export class TrackSyncClient {
  auth: Credentials | null = null;
  constructor(public baseUrl: string, private readonly fetchImpl: FetchLike = (u, i) => fetch(u, i)) {
    this.baseUrl = normaliseApiBase(baseUrl);
  }

  private async call<T>(method: string, path: string, body?: unknown, authed = true): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json; charset=utf-8';
    if (authed) {
      if (!this.auth) throw new SyncHttpError(401, 'Not signed in');
      headers.Authorization = authHeader(this.auth);
    }
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401 || res.status === 403) throw new SyncHttpError(res.status, 'Sync server rejected the saved credentials — sign in again');
    if (!res.ok) throw new SyncHttpError(res.status, `Sync server returned HTTP ${res.status}`);
    const text = await res.text();
    return (text ? JSON.parse(text) : null) as T;
  }

  /** Returns the credential on success, or field errors. */
  async login(username: string, password: string): Promise<{ credential: string } | { errors: FormErrors }> {
    const r = await this.call<string | FormErrors>('POST', '/User/Login', { username, password }, false);
    if (typeof r === 'string') {
      this.auth = { username, credential: r };
      return { credential: r };
    }
    return { errors: r ?? { password: 'Login failed' } };
  }

  async create(username: string, password: string, email?: string | null): Promise<{ credential: string } | { errors: FormErrors }> {
    const r = await this.call<string | FormErrors>('POST', '/User/Create', { username, password, email: email ?? '' }, false);
    if (typeof r === 'string') {
      this.auth = { username, credential: r };
      return { credential: r };
    }
    return { errors: r ?? { username: 'Account creation failed' } };
  }

  time(): Promise<number> {
    return this.call<number>('GET', '/Values/Time', undefined, false);
  }

  getValues(after = 0): Promise<WorkMap> {
    return this.call<WorkMap>('GET', `/Values?after=${after}`);
  }

  /** Returns the server's copy of any item that conflicted (server was newer). */
  postValues(values: Record<string, StoredWorkChapter>): Promise<WorkMap> {
    return this.call<WorkMap>('POST', '/Values', values);
  }

  syncReadingList(body: ReadingListSync): Promise<ReadingListSync> {
    return this.call<ReadingListSync>('POST', '/ReadingList', body);
  }

  syncListFilters(body: ListFiltersSync): Promise<ListFiltersSync> {
    return this.call<ListFiltersSync>('POST', '/ListFilters', body);
  }
}
