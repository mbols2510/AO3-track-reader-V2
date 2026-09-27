import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { openDb } from '../services/tracksync/src/db.ts';
import { buildApp } from '../services/tracksync/src/app.ts';
import { loadConfig } from '../services/tracksync/src/config.ts';
import { TrackSyncClient, exportFromSyncServer, authHeader } from '../packages/core/src/index.ts';

process.env.LOG_LEVEL = 'silent';

async function start(extra: Record<string, string> = {}) {
  const db = openDb(':memory:');
  const app = await buildApp(db, loadConfig({ ...extra } as NodeJS.ProcessEnv));
  await app.listen({ port: 0, host: '127.0.0.1' });
  const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api`;
  return { app, db, url };
}

let legacy: Awaited<ReturnType<typeof start>>;
let revived: Awaited<ReturnType<typeof start>>;
before(async () => {
  legacy = await start();
  revived = await start({ INTERNAL_TOKEN: 'sekrit' });
});
after(async () => {
  await legacy.app.close();
  await revived.app.close();
});

test('account creation, login and auth errors behave like the original', async () => {
  const c = new TrackSyncClient(revived.url);
  const created = await c.create('Bob', 'hunter22', 'bob@example.com');
  assert.ok('credential' in created);
  const dup = await new TrackSyncClient(revived.url).create('bob', 'whatever1');
  assert.deepEqual(Object.keys('errors' in dup ? dup.errors : {}), ['username']);
  const bad = await new TrackSyncClient(revived.url).login('Bob', 'wrong-pw');
  assert.ok('errors' in bad && bad.errors.password);

  // No credentials -> 401, wrong credentials -> 403 (the original clients rely on this quirk)
  assert.equal((await fetch(`${revived.url}/Values`)).status, 401);
  const r = await fetch(`${revived.url}/Values`, { headers: { Authorization: authHeader({ username: 'Bob', credential: 'nope' }) } });
  assert.equal(r.status, 403);

  // Form-encoded login, as the 2017 extension sent it via jQuery
  const form = await fetch(`${revived.url}/User/Login`, { method: 'POST', body: new URLSearchParams({ username: 'bob', password: 'hunter22' }) });
  assert.equal(typeof (await form.json()), 'string');
});

test('Values: newer timestamp or higher seq wins, otherwise the conflict is returned', async () => {
  const c = new TrackSyncClient(revived.url);
  await c.create('carol', 'password1');
  assert.deepEqual(await c.postValues({ 42: { number: 3, chapterid: 300, location: 5_000_000_000, timestamp: 1000, seq: 0 } }), {});
  const conflict = await c.postValues({ 42: { number: 1, chapterid: 100, location: 0, timestamp: 900, seq: 0 } });
  assert.equal(conflict['42'].number, 3);
  assert.deepEqual(await c.postValues({ 42: { number: 1, chapterid: 100, location: 0, timestamp: 900, seq: 1 } }), {});
  const all = await c.getValues(0);
  assert.equal(all['42'].seq, 1);
  assert.deepEqual(await c.getValues(900), {}, 'after= filters by timestamp');
});

test('ReadingList sync: add, propagate, delete across two devices', async () => {
  const a = new TrackSyncClient(revived.url);
  await a.create('dave', 'password1');
  const b = new TrackSyncClient(revived.url);
  await b.login('dave', 'password1');

  const w1 = 'http://archiveofourown.org/works/1', w2 = 'http://archiveofourown.org/works/2';
  let ra = await a.syncReadingList({ last_sync: 0, paths: { [w1]: 100, [w2]: 101 } });
  assert.deepEqual(ra.paths, {});
  let rb = await b.syncReadingList({ last_sync: 0, paths: {} });
  assert.deepEqual(rb.paths, { [w1]: 100, [w2]: 101 }, 'device B receives both');

  // Device A deletes w1 (it just stops sending it)
  ra = await a.syncReadingList({ last_sync: ra.last_sync, paths: { [w2]: 101 } });
  rb = await b.syncReadingList({ last_sync: rb.last_sync, paths: { [w1]: 100, [w2]: 101 } });
  assert.deepEqual(rb.paths, { [w1]: -1 }, 'device B is told to delete w1');
});

test('migration pulls everything from the original service and merges it', async () => {
  // Populate the stand-in "wenchy.net" server the way a long-time user would have.
  const old = new TrackSyncClient(legacy.url);
  await old.create('erin', 'oldpass1');
  await old.postValues({
    111: { number: 5, chapterid: 555, location: null, timestamp: 1_500_000_000_000, seq: 0 },
    222: { number: 1, chapterid: 0, location: 2_000_000_000, timestamp: 1_500_000_000_001, seq: 0 },
  });
  await old.syncReadingList({ last_sync: 0, paths: { 'http://archiveofourown.org/works/111': 1_500_000_000_000, 'http://archiveofourown.org/series/9': 1_500_000_000_002 } });
  await old.syncListFilters({ last_sync: 0, filters: { 'Tag Major Character Death': 1_500_000_000_003 } });

  const exported = await exportFromSyncServer('erin', 'oldpass1', { baseUrl: legacy.url });
  assert.equal(Object.keys(exported.works).length, 2);
  assert.equal(Object.keys(exported.readingList).length, 2);
  assert.equal(Object.keys(exported.listFilters).length, 1);

  // Exporting twice must not have destroyed anything on the old server.
  const again = await exportFromSyncServer('erin', 'oldpass1', { baseUrl: legacy.url });
  assert.equal(Object.keys(again.readingList).length, 2, 'export is read-only');

  // A device that already synced with the new server before migrating…
  const dev = new TrackSyncClient(revived.url);
  await dev.create('erin', 'newpass1');
  await dev.postValues({ 222: { number: 2, chapterid: 22, location: 0, timestamp: Date.now(), seq: 0 } });
  const rl0 = await dev.syncReadingList({ last_sync: 0, paths: {} });
  const worksSyncedAt = Date.now();

  // …then the user migrates through the dashboard endpoint.
  const res = await fetch(`${revived.url}/v2/migrate`, {
    method: 'POST', headers: { Authorization: authHeader(dev.auth!), 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'erin', password: 'oldpass1', baseUrl: legacy.url }),
  });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.imported.worksAdded, 1);
  assert.equal(body.imported.worksKept, 1, 'the further-along position on the new server is kept');

  // The already-synced device must receive the migrated items through the normal protocol.
  const incoming = await dev.getValues(worksSyncedAt - 1);
  assert.ok(incoming['111'], 'migrated work reaches existing devices');
  assert.equal(incoming['111'].number, 5);
  const rl1 = await dev.syncReadingList({ last_sync: rl0.last_sync, paths: {} });
  assert.equal(Object.values(rl1.paths).filter((v) => v > 0).length, 2, 'migrated reading list reaches existing devices (not treated as deletions)');
  const lf = await dev.syncListFilters({ last_sync: 0, filters: {} });
  assert.ok(lf.filters['Tag Major Character Death']);

  // Running it again changes nothing.
  const res2 = await fetch(`${revived.url}/v2/migrate`, {
    method: 'POST', headers: { Authorization: authHeader(dev.auth!), 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'erin', password: 'oldpass1', baseUrl: legacy.url }),
  });
  const b2 = await res2.json();
  assert.equal(b2.imported.worksAdded + b2.imported.readingListAdded, 0);
});

test('internal endpoint exposes reading-list targets only with the token', async () => {
  const base = revived.url.replace(/\/api$/, '');
  assert.equal((await fetch(`${base}/internal/reading-list-targets`)).status, 404);
  const r = await fetch(`${base}/internal/reading-list-targets`, { headers: { 'x-internal-token': 'sekrit' } });
  const t = await r.json();
  assert.ok(t.works.includes(111));
  assert.ok(t.series.includes(9));
});

test('dashboard Works tracked list: lists, deletes, and survives out-of-range values (#11)', async () => {
  const c = new TrackSyncClient(revived.url);
  const created = await c.create('dora', 'password1');
  assert.ok('credential' in created);
  const headers = { Authorization: authHeader({ username: 'dora', credential: created.credential }), 'Content-Type': 'application/json' };
  const works: Record<string, { number: number; chapterid: number; location: number | null; timestamp: number; seq: number }> = {};
  for (let i = 1; i <= 50; i++) works[i] = { number: i % 5 + 1, chapterid: i * 10, location: i % 2 ? null : 1234, timestamp: 1_700_000_000_000 + i, seq: 0 };
  assert.deepEqual(await c.postValues(works), {});

  const list = async () => {
    const r = await fetch(`${revived.url}/v2/works`, { headers });
    assert.equal(r.status, 200);
    return (await r.json()) as { id: number; number: number; location: number | null; timestamp: number; seq: number }[];
  };
  assert.equal((await list()).length, 50);

  // A row as the original service or an old backup could leave it: numbers beyond 2^53.
  const { id: userid } = revived.db.prepare('SELECT id FROM users WHERE username = ?').get('dora') as { id: number };
  revived.db.prepare('INSERT INTO works (userid, id, chapterid, number, timestamp, location, seq) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(userid, 999, 9990, 2, 1_700_000_000_999n, 5_000_000_000_000_000_000n, 637_000_000_000_000_000n);
  const after = await list();
  assert.equal(after.length, 51, 'one odd row must not empty the whole list');
  const odd = after.find((w) => w.id === 999)!;
  assert.equal(odd.seq, Number.MAX_SAFE_INTEGER);
  assert.equal(odd.timestamp, 1_700_000_000_999);
  const me = await (await fetch(`${revived.url}/v2/me`, { headers })).json();
  assert.equal(me.works, 51);
  // The apps' sync and the counter agree with the list.
  assert.equal(Object.keys(await c.getValues(0)).length, 51);
  // Posting a position for that work still works (it compares against the stored row).
  await c.postValues({ 999: { number: 3, chapterid: 9991, location: null, timestamp: 1_800_000_000_000, seq: 0 } });

  // New oversized values are clamped on the way in rather than stored as-is.
  await c.postValues({ 1000: { number: 1, chapterid: 1, location: 0, timestamp: 1_700_000_001_000, seq: 9e18 } });
  assert.equal((await list()).find((w) => w.id === 1000)!.seq, Number.MAX_SAFE_INTEGER);

  const del = await fetch(`${revived.url}/v2/works/delete`, { method: 'POST', headers, body: JSON.stringify({ ids: [1, 2, 999] }) });
  assert.deepEqual(await del.json(), { deleted: 3 });
  assert.equal((await list()).length, 49);
});
