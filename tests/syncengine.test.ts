import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { openDb } from '../services/tracksync/src/db.ts';
import { buildApp } from '../services/tracksync/src/app.ts';
import { loadConfig } from '../services/tracksync/src/config.ts';
import { SyncEngine } from '../packages/core/src/index.ts';

process.env.LOG_LEVEL = 'silent';
let app: Awaited<ReturnType<typeof buildApp>>, url: string;
before(async () => {
  app = await buildApp(openDb(':memory:'), loadConfig({} as NodeJS.ProcessEnv));
  await app.listen({ port: 0, host: '127.0.0.1' });
  url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});
after(() => app.close());

const engine = () => new SyncEngine({}, () => {});

test('two devices converge on the furthest position, reading list and filters', async () => {
  const pc = engine(), laptop = engine();
  assert.ok('ok' in (await pc.signIn(url, 'zoe', 'password1', true)));
  assert.ok('ok' in (await laptop.signIn(url, 'zoe', 'password1')));

  pc.setWork(7, { number: 2, chapterid: 72, location: 1_000_000_000, seq: null });
  pc.addToReadingList('https://archiveofourown.org/works/7/chapters/72');
  pc.addFilter('Tag Major Character Death');
  assert.ok((await pc.sync()).ok);

  assert.ok((await laptop.sync()).ok);
  assert.equal(laptop.getWork(7)?.number, 2);
  assert.ok(laptop.inReadingList('https://archiveofourown.org/works/7'));
  assert.equal(laptop.filters().match(1, [], ['Major Character Death'], []), 'Tag Major Character Death');

  // Laptop reads further; PC's stale, *behind* position must not win.
  laptop.setWork(7, { number: 3, chapterid: 73, location: null, seq: null });
  await laptop.sync();
  assert.equal(pc.setWork(7, { number: 1, chapterid: 71, location: 0, seq: null }), false, 'backwards move ignored locally');
  await pc.sync();
  assert.equal(pc.getWork(7)?.number, 3);

  // "Mark as unread" uses force (seq bump) and does propagate backwards.
  pc.setWork(7, { number: 1, chapterid: 71, location: 0, seq: null }, true);
  await pc.sync();
  await laptop.sync();
  assert.equal(laptop.getWork(7)?.number, 1);

  // Removing from the reading list propagates as a delete.
  laptop.removeFromReadingList('http://archiveofourown.org/works/7');
  await laptop.sync();
  await pc.sync();
  assert.equal(pc.inReadingList('https://archiveofourown.org/works/7'), false);
});

test('offline edits made on both devices merge without loss', async () => {
  const a = engine(), b = engine();
  await a.signIn(url, 'yan', 'password1', true);
  await b.signIn(url, 'yan', 'password1');
  a.setWork(1, { number: 5, chapterid: 15, location: null, seq: null });
  b.setWork(1, { number: 2, chapterid: 12, location: 0, seq: null });
  b.setWork(2, { number: 1, chapterid: 0, location: 4_000_000_000, seq: null });
  await b.sync(); // b uploads its (behind) copy of 1 first
  await a.sync(); // a is further along on 1 and must win
  await b.sync();
  assert.equal(b.getWork(1)?.number, 5);
  assert.equal(a.getWork(2)?.location, 4_000_000_000);
});

test('rejected credentials sign the device out', async () => {
  const a = engine();
  await a.signIn(url, 'xia', 'password1', true);
  a.state.auth!.credential = 'bogus';
  const r = await a.sync();
  assert.equal(r.ok, false);
  assert.equal(a.status, 'disabled');
});

test('a position deleted in the dashboard disappears from every device, and comes back if read again (#8)', async () => {
  const pc = engine(), laptop = engine();
  await pc.signIn(url, 'del', 'password1', true);
  await laptop.signIn(url, 'del', 'password1');
  pc.setWork(11, { number: 2, chapterid: 112, location: 500, seq: null });
  pc.setWork(12, { number: 1, chapterid: 121, location: 0, seq: null });
  await pc.sync(); await laptop.sync();
  assert.ok(laptop.getWork(11));

  // Dashboard: sign in like the web page does, list, delete.
  const login = await fetch(`${url}/api/User/Login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'del', password: 'password1' }) });
  const auth = { Authorization: `Ao3track ${btoa(`del\n${await login.json()}`)}`, 'Content-Type': 'application/json' };
  const list = (await (await fetch(`${url}/api/v2/works`, { headers: auth })).json()) as { id: number; number: number }[];
  assert.deepEqual(list.map((w) => w.id).sort(), [11, 12]);
  const del = await fetch(`${url}/api/v2/works/delete`, { method: 'POST', headers: auth, body: JSON.stringify({ ids: [11] }) });
  assert.deepEqual(await del.json(), { deleted: 1 });

  await pc.sync(); await laptop.sync();
  assert.equal(pc.getWork(11), undefined, 'forgotten on the PC');
  assert.equal(laptop.getWork(11), undefined, 'forgotten on the laptop');
  assert.ok(pc.getWork(12), 'other works untouched');
  // A stale copy re-sent by an old app must not bring it back.
  await fetch(`${url}/api/Values`, { method: 'POST', headers: auth, body: JSON.stringify({ 11: { chapterid: 112, number: 2, location: 500, timestamp: 1, seq: 0 } }) });
  assert.equal(((await (await fetch(`${url}/api/v2/works`, { headers: auth })).json()) as unknown[]).length, 1);

  // Reading it again later tracks it again, everywhere.
  await new Promise((r) => setTimeout(r, 5));
  laptop.setWork(11, { number: 1, chapterid: 111, location: 10, seq: null });
  await laptop.sync(); await pc.sync();
  assert.equal(pc.getWork(11)?.number, 1);
});
