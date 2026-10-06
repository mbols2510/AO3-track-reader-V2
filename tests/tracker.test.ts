import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../services/tracker/src/app.ts';
import { loadConfig } from '../services/tracker/src/config.ts';
import { blurb, searchPage, RETRY_LATER } from './fixtures.ts';

process.env.LOG_LEVEL = 'silent';

function fakeAo3() {
  const calls: string[] = [];
  let limited = false;
  const fetch = async (url: string) => {
    calls.push(url);
    if (limited) return new Response(RETRY_LATER, { status: 429, headers: { 'Retry-After': '600' } });
    const u = new URL(url);
    const ids = [...(u.searchParams.get('work_search[query]') ?? '').matchAll(/\d+/g)].map((m) => Number(m[0]));
    return new Response(searchPage(ids.map((i) => blurb(i, { ch: `${i % 7 + 1}/10` }))));
  };
  return { fetch, calls, setLimited: (v: boolean) => (limited = v) };
}

const cfg = () => loadConfig({ DB_PATH: ':memory:', RATE_REFILL_SECONDS: '0.001', RATE_MIN_INTERVAL_SECONDS: '0', REFRESH_INTERVAL_HOURS: '0' } as NodeJS.ProcessEnv);

test('tracker batches concurrent requests and serves repeats from cache', async () => {
  const ao3 = fakeAo3();
  const app = await buildApp(cfg(), ao3.fetch);
  const [a, b] = await Promise.all([
    app.inject({ url: '/api/works?ids=1,2,3&wait=5' }),
    app.inject({ url: '/api/works?ids=3,4&wait=5' }),
  ]);
  assert.equal(a.json().works.length, 3);
  assert.equal(b.json().works.length, 2);
  assert.equal(ao3.calls.length, 1, 'both callers shared one search request');
  const again = await app.inject({ url: '/api/works?ids=1,2,3,4' });
  assert.equal(again.json().works.length, 4);
  assert.deepEqual(again.json().pending, []);
  assert.equal(ao3.calls.length, 1, 'served from cache');
  await app.close();
});

test('API key protects /api when set; internal token also accepted', async () => {
  const ao3 = fakeAo3();
  const c = loadConfig({ DB_PATH: ':memory:', REFRESH_INTERVAL_HOURS: '0', API_KEY: 'k3y', INTERNAL_TOKEN: 'int' } as NodeJS.ProcessEnv);
  const app = await buildApp(c, ao3.fetch);
  assert.equal((await app.inject({ url: '/api/status' })).statusCode, 401);
  assert.equal((await app.inject({ url: '/api/status', headers: { 'x-api-key': 'nope' } })).statusCode, 401);
  assert.equal((await app.inject({ url: '/api/status', headers: { 'x-api-key': 'k3y' } })).statusCode, 200);
  assert.equal((await app.inject({ url: '/api/status', headers: { authorization: 'Bearer k3y' } })).statusCode, 200);
  assert.equal((await app.inject({ url: '/api/status', headers: { 'x-internal-token': 'int' } })).statusCode, 200);
  assert.equal((await app.inject({ url: '/healthz' })).statusCode, 200, 'health check stays open');
  await app.close();
});

test('tracker stops hitting AO3 once rate limited', async () => {
  const ao3 = fakeAo3();
  ao3.setLimited(true);
  const app = await buildApp(cfg(), ao3.fetch);
  const r = await app.inject({ url: '/api/works?ids=50&wait=1' });
  assert.deepEqual(r.json().pending, [50]);
  assert.ok(r.json().limiter.pausedUntil > Date.now() + 5 * 60_000, 'paused for Retry-After');
  await app.inject({ url: '/api/works?ids=51,52&wait=1' });
  assert.equal(ao3.calls.length, 1, 'no further requests while paused');
  const s = (await app.inject({ url: '/api/status' })).json();
  assert.equal(s.limiter.totalRateLimited, 1);
  await app.close();
});

test('cacheOnly reads never contact AO3, even for stale or unknown works (#7)', async () => {
  const ao3 = fakeAo3();
  const app = await buildApp(cfg(), ao3.fetch);
  await app.inject({ url: '/api/works?ids=1,2&wait=5' });
  assert.equal(ao3.calls.length, 1);
  // maxAge=0 makes everything stale; 99 is unknown. Neither may cause a request.
  const r = await app.inject({ method: 'POST', url: '/api/works', payload: { ids: [1, 2, 99], cacheOnly: true, maxAge: 0 } });
  assert.deepEqual(r.json().works.map((w: { workid: number }) => w.workid).sort(), [1, 2]);
  assert.deepEqual(r.json().pending, [99], 'unknown work reported as not fetched yet');
  const g = await app.inject({ url: '/api/works?ids=1,99&cacheOnly=1&maxAge=0' });
  assert.equal(g.json().works.length, 1);
  assert.equal((await app.inject({ url: '/api/series/5?cacheOnly=1' })).statusCode, 404);
  await new Promise((r) => setTimeout(r, 400)); // give any (wrongly) queued request time to run
  assert.equal(ao3.calls.length, 1, 'no AO3 requests from cache-only reads');
  await app.close();
});

test('app-update: reports the newest Gitea release and streams its installer; off without GITEA_REPO (#5, #12)', async () => {
  const seen: { url: string; auth: string | null }[] = [];
  const gitea = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    seen.push({ url: u, auth: new Headers(init?.headers).get('authorization') });
    if (u === 'https://gitea.test/api/v1/repos/me/app/releases/latest') {
      return Response.json({ tag_name: 'v2.2.0', name: 'Ao3Track 2.2.0', body: 'notes', html_url: 'https://gitea.test/me/app/releases/tag/v2.2.0',
        assets: [
          { id: 7, name: 'ArchiveTrackReader-2.2.0-x64.msi', size: 4, browser_download_url: 'https://gitea.test/me/app/releases/download/v2.2.0/ArchiveTrackReader-2.2.0-x64.msi' },
        ] });
    }
    if (u === 'https://gitea.test/me/app/releases/download/v2.2.0/ArchiveTrackReader-2.2.0-x64.msi') return new Response('MSI!', { headers: { 'content-length': '4' } });
    return new Response('nope', { status: 404 });
  }) as typeof fetch;
  const c = loadConfig({ DB_PATH: ':memory:', REFRESH_INTERVAL_HOURS: '0', GITEA_TOKEN: 'tok_x', GITEA_REPO: 'me/app', GITEA_URL: 'https://gitea.test' } as NodeJS.ProcessEnv);
  const app = await buildApp(c, fakeAo3().fetch, gitea);
  const r = (await app.inject({ url: '/api/app-update' })).json();
  assert.equal(r.configured, true);
  assert.equal(r.version, '2.2.0');
  assert.deepEqual(r.files, [{ name: 'ArchiveTrackReader-2.2.0-x64.msi', size: 4 }]);
  assert.equal(seen[0].auth, 'token tok_x');
  const d = await app.inject({ url: '/api/app-update/download/ArchiveTrackReader-2.2.0-x64.msi' });
  assert.equal(d.statusCode, 200);
  assert.equal(d.body, 'MSI!');
  assert.equal((await app.inject({ url: '/api/app-update/download/other.exe' })).statusCode, 404);
  assert.ok(!JSON.stringify(r).includes('tok_x'), 'token never sent to clients');
  await app.close();

  const off = await buildApp(loadConfig({ DB_PATH: ':memory:', REFRESH_INTERVAL_HOURS: '0', GITEA_REPO: '' } as NodeJS.ProcessEnv), fakeAo3().fetch);
  assert.deepEqual((await off.inject({ url: '/api/app-update' })).json(), { configured: false });
  await off.close();
});
