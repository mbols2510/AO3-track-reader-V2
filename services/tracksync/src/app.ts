import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import formbody from '@fastify/formbody';
import fastifyStatic from '@fastify/static';
import multipart from '@fastify/multipart';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { Db } from './db.ts';
import { Auth, MIN_PW_SIZE, PW_SIZE_MSG, verifyPassword, type UserRow } from './auth.ts';
import { SyncStore } from './sync.ts';
import type { Config } from './config.ts';
import { exportFromSyncServer, isAccountExport, normaliseWorks, type AccountExport } from '@ao3track/core';

declare module 'fastify' {
  interface FastifyRequest {
    user: UserRow | null;
    authFailed: boolean;
    credential: string | null;
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = [join(here, 'web'), join(here, '..', 'src', 'web')].find((p) => existsSync(join(p, 'index.html')));

/** Simple fixed-window limiter for login attempts, keyed by IP. */
class AttemptLimiter {
  private hits = new Map<string, { n: number; until: number }>();
  constructor(private max = 10, private windowMs = 5 * 60_000) {}
  allow(key: string): boolean {
    const now = Date.now();
    const h = this.hits.get(key);
    if (!h || h.until < now) {
      this.hits.set(key, { n: 1, until: now + this.windowMs });
      return true;
    }
    h.n++;
    return h.n <= this.max;
  }
}

const isValidEmail = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

export async function buildApp(db: Db, config: Config): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    trustProxy: config.trustProxy,
    bodyLimit: 50 * 1024 * 1024,
    routerOptions: { caseSensitive: false, ignoreTrailingSlash: true },
  });
  const auth = new Auth(db);
  const store = new SyncStore(db);
  const loginLimiter = new AttemptLimiter();

  await app.register(formbody);
  await app.register(multipart, { limits: { fileSize: 200 * 1024 * 1024, files: 1 } });

  app.decorateRequest('user', null);
  app.decorateRequest('authFailed', false);
  app.decorateRequest('credential', null);

  // ---- CORS: browser extensions and configured origins --------------------
  const allowOrigin = (origin: string | undefined): string | null => {
    if (!origin) return null;
    if (config.corsOrigins === '*') return origin;
    if (/^(chrome|moz|ms-browser|safari-web)-extension:\/\//i.test(origin)) return origin;
    if (config.corsOrigins.includes(origin)) return origin;
    return null;
  };
  app.addHook('onRequest', async (req, reply) => {
    const o = allowOrigin(req.headers.origin);
    if (o) {
      reply.header('Access-Control-Allow-Origin', o);
      reply.header('Vary', 'Origin');
      reply.header('Access-Control-Allow-Credentials', 'true');
      reply.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      reply.header('Access-Control-Max-Age', '604800');
    }
    if (req.method === 'OPTIONS') return reply.code(200).send();
  });

  // ---- Authentication ("Ao3track base64(user\ncredential)") ------------------
  app.addHook('preHandler', async (req) => {
    const creds = Auth.parseHeader(req.headers.authorization);
    if (!creds) return;
    const user = auth.checkToken(creds.username, creds.credential);
    if (user) {
      req.user = user;
      req.credential = creds.credential;
    } else req.authFailed = true;
  });

  const requireUser = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user) {
      reply.header('WWW-Authenticate', 'Ao3track');
      // Original quirk kept on purpose: clients expect 403 for bad credentials, 401 for none.
      return reply.code(req.authFailed ? 403 : 401).send({ message: 'Authorization has been denied for this request.' });
    }
  };
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('Cache-Control', 'no-store');
    return payload;
  });

  // ---- api/User ---------------------------------------------------------
  const body = (req: FastifyRequest) => (req.body ?? {}) as Record<string, string | undefined>;
  const verifyPw = (pw: string, hash: string) => {
    try {
      return verifyPassword(pw, hash);
    } catch {
      return false;
    }
  };
  /** The original API answers a successful login with a bare JSON string. */
  const sendCredential = (reply: FastifyReply, token: string) =>
    reply.type('application/json; charset=utf-8').send(JSON.stringify(token));

  app.get('/api/User/Init', async () => null);
  app.get('/api/Values/Init', async () => null);

  app.post('/api/User/Login', async (req, reply) => {
    if (!loginLimiter.allow(req.ip)) {
      return reply.code(429).header('Retry-After', '300').send({ password: 'Too many attempts. Try again in a few minutes.' });
    }
    const { username = '', password = '' } = body(req);
    const errors: Record<string, string> = {};
    if (!username.trim()) errors.username = 'username must not be empty';
    if (!password.trim()) errors.password = 'password must not be empty';
    if (Object.keys(errors).length) return errors;
    const user = auth.findUser(username);
    if (!user || !verifyPw(password, user.pwhash)) return { password: 'Incorrect password.' };
    return sendCredential(reply, auth.issueToken(user.id, String(req.headers['user-agent'] ?? '').slice(0, 120)));
  });


  app.post('/api/User/Create', async (req, reply) => {
    if (!config.allowRegistration) return reply.code(200).send({ username: 'Registration is disabled on this server.' });
    if (!loginLimiter.allow(req.ip)) return reply.code(429).send({ username: 'Too many attempts. Try again later.' });
    const b = body(req);
    const username = b.username ?? '';
    const password = b.password ?? '';
    const email = b.email?.trim() ? b.email.trim() : null;
    const errors: Record<string, string> = {};
    if (!username.trim()) errors.username = 'username must not be empty';
    else if (username.includes('\n')) errors.username = 'username must not contain new line characters';
    else if (username.trim() !== username) errors.username = 'username must not start or end with whitespace';
    else if (auth.findUser(username)) errors.username = 'username already exists';
    if (!password.trim()) errors.password = 'password must not be empty';
    else if (password.length < MIN_PW_SIZE) errors.password = PW_SIZE_MSG;
    if (email && !isValidEmail(email)) errors.email = 'email is not a valid email address';
    else if (email && auth.emailInUse(email)) errors.email = 'email already used';
    if (Object.keys(errors).length) return errors;
    const user = auth.createUser(username, email, password);
    return sendCredential(reply, auth.issueToken(user.id, String(req.headers['user-agent'] ?? '').slice(0, 120)));
  });

  // ---- api/Values ---------------------------------------------------------
  app.get('/api/Values/Time', async () => Date.now());

  const after = (req: FastifyRequest) => {
    const n = Number((req.query as Record<string, string>)?.after ?? 0);
    return Number.isFinite(n) ? n : 0;
  };
  app.get('/api/Values', { preHandler: requireUser }, async (req) => store.getWorks(req.user!.id, after(req)));
  app.get<{ Params: { id: string } }>('/api/Values/:id', { preHandler: requireUser }, async (req) =>
    store.getWorks(req.user!.id, after(req), Number(req.params.id)));
  app.post('/api/Values', { preHandler: requireUser }, async (req) =>
    store.postWorks(req.user!.id, (req.body ?? {}) as Record<string, never>));
  app.put<{ Params: { id: string } }>('/api/Values/:id', { preHandler: requireUser }, async (req) =>
    store.postWorks(req.user!.id, { [req.params.id]: (req.body ?? {}) as never }));
  app.delete<{ Params: { id: string } }>('/api/Values/:id', { preHandler: requireUser }, async (req, reply) => {
    store.deleteWork(req.user!.id, Number(req.params.id));
    return reply.code(204).send();
  });

  // ---- api/ReadingList, api/ListFilters ---------------------------------
  app.post('/api/ReadingList', { preHandler: requireUser }, async (req) => store.syncReadingList(req.user!.id, req.body as never));
  app.post('/api/ListFilters', { preHandler: requireUser }, async (req) => store.syncListFilters(req.user!.id, req.body as never));

  // ---- api/ErrorReport (apps post crash reports here) --------------------
  app.post('/api/ErrorReport', async (req, reply) => {
    const raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? null);
    db.prepare('INSERT INTO error_reports (received, body) VALUES (?, ?)').run(Date.now(), raw.slice(0, 200_000));
    db.prepare('DELETE FROM error_reports WHERE id NOT IN (SELECT id FROM error_reports ORDER BY id DESC LIMIT 500)').run();
    req.log.warn({ report: raw.slice(0, 2000) }, 'client error report');
    return reply.code(204).send();
  });

  // ---- v2: dashboard, export/import, migration ----------------------------
  app.get('/api/v2/info', async () => ({
    name: 'Ao3Track TrackSync', version: '2.0.0', allowRegistration: config.allowRegistration,
    tracker: !!config.trackerUrl, legacyApiUrl: config.legacyApiUrl,
    apiUrl: config.publicUrl ? `${config.publicUrl}/api` : null,
  }));

  app.get('/api/v2/me', { preHandler: requireUser }, async (req) => {
    const u = req.user!;
    return { username: u.username, email: u.email, created: u.created, ...store.counts(u.id) };
  });

  app.get('/api/v2/export', { preHandler: requireUser }, async (req, reply): Promise<AccountExport> => {
    const u = req.user!;
    reply.header('Content-Disposition', `attachment; filename="ao3track-${encodeURIComponent(u.username)}-${new Date().toISOString().slice(0, 10)}.json"`);
    return {
      format: 'ao3track-export', version: 1, source: config.publicUrl ?? 'tracksync', username: u.username,
      exportedAt: new Date().toISOString(), works: store.getWorks(u.id, -1),
      readingList: store.readingList(u.id), listFilters: store.listFilters(u.id),
    };
  });

  const doImport = (userid: number, data: AccountExport) =>
    store.importAccount(userid, { works: normaliseWorks(data.works), readingList: data.readingList ?? {}, listFilters: data.listFilters ?? {} });

  app.post('/api/v2/import', { preHandler: requireUser }, async (req, reply) => {
    if (!isAccountExport(req.body)) return reply.code(400).send({ error: 'Not an Ao3Track export file.' });
    return { imported: doImport(req.user!.id, req.body) };
  });

  app.post('/api/v2/migrate', { preHandler: requireUser }, async (req, reply) => {
    const { username = '', password = '', baseUrl } = body(req);
    if (!username || !password) return reply.code(400).send({ error: 'Enter the username and password for your original account.' });
    try {
      const data = await exportFromSyncServer(username, password, { baseUrl: baseUrl || config.legacyApiUrl });
      return { source: data.source, found: { works: Object.keys(data.works).length, readingList: Object.keys(data.readingList).length, listFilters: Object.keys(data.listFilters).length }, imported: doImport(req.user!.id, data) };
    } catch (e) {
      req.log.warn({ err: e }, 'migration failed');
      return reply.code(502).send({ error: (e as Error).message });
    }
  });

  app.post('/api/v2/import-legacy-db', { preHandler: requireUser }, async (req, reply) => {
    const file = await req.file();
    if (!file) return reply.code(400).send({ error: 'Attach the Ao3TrackSQLite.db3 file.' });
    const tmp = join(tmpdir(), `legacy-${randomUUID()}.db3`);
    try {
      await writeFile(tmp, await file.toBuffer());
      const { exportFromLegacyDb } = await import('@ao3track/core/legacydb');
      const data = exportFromLegacyDb(tmp);
      return { found: { works: Object.keys(data.works).length, readingList: Object.keys(data.readingList).length, listFilters: Object.keys(data.listFilters).length }, imported: doImport(req.user!.id, data) };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    } finally {
      await unlink(tmp).catch(() => {});
    }
  });

  app.post('/api/v2/password', { preHandler: requireUser }, async (req, reply) => {
    const { current = '', password = '' } = body(req);
    if (!verifyPw(current, req.user!.pwhash)) return reply.code(400).send({ current: 'Current password is incorrect.' });
    if (password.length < MIN_PW_SIZE) return reply.code(400).send({ password: PW_SIZE_MSG });
    auth.setPassword(req.user!.id, password); // revokes every device token
    return { credential: auth.issueToken(req.user!.id, 'dashboard') };
  });

  app.post('/api/v2/logout', { preHandler: requireUser }, async (req, reply) => {
    if (req.credential) auth.revokeToken(req.credential);
    return reply.code(204).send();
  });

  app.get('/api/v2/reading-list', { preHandler: requireUser }, async (req) => store.readingList(req.user!.id));

  /** Proxy to the tracker for titles, so the dashboard needn't know the tracker's address. */
  app.get('/api/v2/works-meta', { preHandler: requireUser }, async (req, reply) => {
    if (!config.trackerUrl) return reply.code(404).send({ error: 'No tracker configured' });
    const ids = String((req.query as Record<string, string>).ids ?? '');
    const r = await fetch(`${config.trackerUrl}/api/works?ids=${encodeURIComponent(ids)}`, { headers: config.internalToken ? { 'x-internal-token': config.internalToken } : {} }).catch(() => null);
    if (!r?.ok) return reply.code(502).send({ error: 'Tracker unavailable' });
    return r.json();
  });

  // ---- internal (tracker service only) ---------------------------------
  app.get('/internal/reading-list-targets', async (req, reply) => {
    if (!config.internalToken || req.headers['x-internal-token'] !== config.internalToken) return reply.code(404).send();
    return store.allReadingListTargets();
  });

  app.get('/healthz', async () => ({ ok: true }));

  // ---- dashboard ------------------------------------------------------------
  if (webRoot) {
    await app.register(fastifyStatic, { root: webRoot, prefix: '/', index: ['index.html'], cacheControl: false });
  }
  return app;
}

