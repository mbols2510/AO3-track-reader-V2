import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import type { Db } from './db.ts';
import { Stmts } from './db.ts';

const N = 2 ** 15, R = 8, P = 1, KEYLEN = 32;
const MAXMEM = 128 * N * R * 2;

export const MIN_PW_SIZE = 6;
export const PW_SIZE_MSG = `Password must be at least ${MIN_PW_SIZE} characters long`;

export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(pw.normalize('NFKC'), salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, 'base64');
  const actual = scryptSync(pw.normalize('NFKC'), Buffer.from(salt, 'base64'), expected.length, {
    N: Number(n), r: Number(r), p: Number(p), maxmem: 128 * Number(n) * Number(r) * 2,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const tokenHash = (t: string) => createHash('sha256').update(t, 'utf8').digest();

export interface UserRow {
  id: number;
  username: string;
  email: string | null;
  roles: string;
  pwhash: string;
  created: number;
}

export class Auth {
  private s: Stmts;
  constructor(private readonly db: Db) {
    this.s = new Stmts(db);
  }

  findUser(username: string): UserRow | undefined {
    return this.s.get('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined;
  }

  userById(id: number): UserRow | undefined {
    return this.s.get('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
  }

  emailInUse(email: string): boolean {
    return !!this.s.get('SELECT 1 FROM users WHERE email = ?').get(email);
  }

  createUser(username: string, email: string | null, password: string): UserRow {
    const r = this.s.get('INSERT INTO users (username, email, roles, pwhash, created) VALUES (?, ?, ?, ?, ?)')
      .run(username, email, 'users', hashPassword(password), Date.now());
    return this.userById(Number(r.lastInsertRowid))!;
  }

  setPassword(userid: number, password: string) {
    this.s.get('UPDATE users SET pwhash = ? WHERE id = ?').run(hashPassword(password), userid);
    this.s.get('DELETE FROM tokens WHERE userid = ?').run(userid);
  }

  /**
   * Issue a new credential. The original server derived one fixed credential
   * from the password hash; we issue a random per-device token instead (so a
   * lost device can be revoked), but clients treat it exactly the same way.
   */
  issueToken(userid: number, label: string | null = null): string {
    const token = randomBytes(32).toString('base64url');
    this.s.get('INSERT INTO tokens (userid, hash, label, created) VALUES (?, ?, ?, ?)').run(userid, tokenHash(token), label, Date.now());
    return token;
  }

  revokeToken(token: string) {
    this.s.get('DELETE FROM tokens WHERE hash = ?').run(tokenHash(token));
  }

  checkToken(username: string, token: string): UserRow | null {
    const row = this.s.get(
      'SELECT u.*, t.id AS tid FROM tokens t JOIN users u ON u.id = t.userid WHERE t.hash = ?',
    ).get(tokenHash(token)) as (UserRow & { tid: number }) | undefined;
    if (!row || row.username.toLowerCase() !== username.toLowerCase()) return null;
    this.s.get('UPDATE tokens SET last_used = ? WHERE id = ?').run(Date.now(), row.tid);
    const { tid: _tid, ...user } = row;
    return user;
  }

  /** Parse "Authorization: Ao3track base64(username \n credential)". */
  static parseHeader(h: string | undefined): { username: string; credential: string } | null {
    if (!h) return null;
    const m = h.match(/^Ao3track\s+(.+)$/i);
    if (!m) return null;
    let decoded: string;
    try {
      decoded = Buffer.from(m[1].trim(), 'base64').toString('utf8');
    } catch {
      return null;
    }
    const parts = decoded.split('\n');
    if (parts.length !== 2 || !parts[0].trim() || !parts[1].trim()) return null;
    return { username: parts[0], credential: parts[1] };
  }
}
