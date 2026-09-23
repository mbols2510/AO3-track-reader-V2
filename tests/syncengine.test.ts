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
