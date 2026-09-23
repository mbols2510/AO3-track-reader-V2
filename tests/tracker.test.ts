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
