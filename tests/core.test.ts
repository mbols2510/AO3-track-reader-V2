import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readingListKey, filterFromUrl, escapeTag, unescapeTag, ListFilterSet, isAhead, chaptersFinished,
  Ao3RateLimiter, Ao3Client, RateLimitedError, parseRetryAfter,
} from '../packages/core/src/index.ts';
import { parseWorkBlurbs, parseWorkPage, searchUrlForIds, lookupWorks } from '../packages/core/src/parse.ts';
import { exportFromLegacyDb } from '../packages/core/src/legacydb.ts';
import { blurb, searchPage, workPage, RETRY_LATER } from './fixtures.ts';

test('reading-list keys match the original apps byte-for-byte', () => {
  assert.equal(readingListKey('https://archiveofourown.org/works/123/chapters/456#workskin'), 'http://archiveofourown.org/works/123');
  assert.equal(readingListKey('https://www.archiveofourown.org/collections/foo/works/9'), 'http://archiveofourown.org/works/9');
  assert.equal(readingListKey('https://archiveofourown.org/series/77?page=3'), 'http://archiveofourown.org/series/77');
  assert.equal(readingListKey('https://archiveofourown.org/tags/X/works?page=2&sort=kudos'), 'http://archiveofourown.org/tags/X/works?sort=kudos');
  assert.equal(readingListKey('https://example.com/works/1'), null);
});

test('tag escaping and list filters', () => {
  assert.equal(escapeTag('A/B & C.D?'), 'A*s*B *a* C*d*D*q*');
  assert.equal(unescapeTag(escapeTag('A/B & C.D?#')), 'A/B & C.D?#');
  assert.equal(filterFromUrl('https://archiveofourown.org/tags/Major%20Character%20Death/works'), 'Tag Major Character Death');
  assert.equal(filterFromUrl('/users/someone/pseuds/x'), 'Author someone');
  const f = new ListFilterSet(['Tag Major Character Death', 'Author Spammy', 'Work 5 Bad fic', 'Series 8']);
  assert.equal(f.match(1, [], ['major character death'], []), 'Tag Major Character Death');
  assert.equal(f.match(5, [], [], []), 'Work 5 Bad fic');
  assert.equal(f.match(2, ['spammy'], [], []), 'Author Spammy');
  assert.equal(f.match(2, [], [], [8]), 'Series 8');
  assert.equal(f.match(2, ['ok'], ['fine'], [1]), null);
});

test('position comparison', () => {
  assert.ok(isAhead({ number: 1, location: 0, seq: 0 }, { number: 1, location: null, seq: null }));
  assert.ok(!isAhead({ number: 2, location: 0, seq: 0 }, { number: 1, location: null, seq: null }));
  assert.ok(isAhead({ number: 9, location: null, seq: 0 }, { number: 1, location: 0, seq: 1 }), 'higher seq always wins');
  assert.equal(chaptersFinished({ number: 3, location: 5 }), 2);
  assert.equal(chaptersFinished({ number: 3, location: null }), 3);
});

test('parses AO3 blurbs and work pages', () => {
  const [w] = parseWorkBlurbs(searchPage([blurb(101, { title: 'Hello &amp; Goodbye', ch: '3/?', series: 44 })]));
  assert.equal(w.workid, 101);
  assert.equal(w.title, 'Hello & Goodbye');
  assert.deepEqual(w.authors, ['writer']);
  assert.equal(w.rating, 'Teen And Up Audiences');
  assert.deepEqual(w.relationships, ['Aziraphale/Crowley']);
  assert.equal(w.chaptersPublished, 3);
  assert.equal(w.chaptersTotal, null);
  assert.equal(w.words, 12345);
  assert.equal(w.kudos, 1024);
  assert.deepEqual(w.series, [{ id: 44, title: 'The Series', part: 2 }]);
  const p = parseWorkPage(workPage(7), 7)!;
  assert.equal(p.title, 'Restricted One');
  assert.equal(p.chaptersPublished, 2);
  assert.deepEqual(p.authors, ['secret']);
  assert.equal(p.rating, 'Explicit');
  assert.match(searchUrlForIds([1, 2]), /id%3A%281\+OR\+2%29/);
});

test('rate limiter pauses on 429 and honours Retry-After', async () => {
  let now = 0;
  const sleeps: number[] = [];
  const limiter = new Ao3RateLimiter({ now: () => now, sleep: async (ms) => { sleeps.push(ms); now += ms; }, burst: 2, refillMs: 6000, minIntervalMs: 2000 });
  let calls = 0;
  const client = new Ao3Client({
    limiter, maxRateLimitRetries: 1,
    fetch: async () => {
      calls++;
      if (calls === 1) return new Response(RETRY_LATER, { status: 429, headers: { 'Retry-After': '120' } });
      return new Response('<html>ok</html>', { status: 200 });
    },
  });
  const html = await client.getHtml('/works/1');
  assert.equal(html, '<html>ok</html>');
  assert.equal(calls, 2);
  assert.ok(now >= 125_000, `waited for Retry-After (+slack), now=${now}`);
  assert.equal(limiter.status().totalRateLimited, 1);
  assert.equal(parseRetryAfter('30'), 30_000);
});

test('rate limiter gives up after repeated 429s and backs off exponentially', async () => {
  let now = 0;
  const limiter = new Ao3RateLimiter({ now: () => now, sleep: async (ms) => { now += ms; }, defaultPauseMs: 300_000 });
  const client = new Ao3Client({ limiter, maxRateLimitRetries: 2, fetch: async () => new Response(RETRY_LATER, { status: 429 }) });
  await assert.rejects(client.getHtml('/works/1'), RateLimitedError);
  // 5 min + 10 min of pauses before the third attempt, then a 20 min pause is set
  assert.ok(now >= 15 * 60_000, `now=${now}`);
  assert.ok(limiter.status().pausedUntil! >= now + 19 * 60_000);
});

test('limiter paces requests: burst then refill rate, one at a time', async () => {
  let now = 0;
  const limiter = new Ao3RateLimiter({ now: () => now, sleep: async (ms) => { now += ms; }, burst: 3, refillMs: 6000, minIntervalMs: 2000 });
  const starts: number[] = [];
  await Promise.all(Array.from({ length: 6 }, () => limiter.schedule(async () => { starts.push(now); })));
  const gaps = starts.slice(1).map((t, i) => t - starts[i]);
  assert.ok(gaps.every((g) => g >= 2000), `min interval respected: ${gaps}`);
  assert.ok(starts[5] - starts[0] >= 17_000, `sustained rate ≈ 10/min: ${starts}`);
});

test('high priority jumps the queue', async () => {
  let now = 0;
  const limiter = new Ao3RateLimiter({ now: () => now, sleep: async (ms) => { now += ms; } });
  const order: string[] = [];
  const lows = [1, 2, 3].map((i) => limiter.schedule(async () => { order.push(`low${i}`); }, 'low'));
  const hi = limiter.schedule(async () => { order.push('high'); }, 'high');
  await Promise.all([...lows, hi]);
  assert.equal(order.indexOf('high') <= 1, true, order.join(','));
});

test('lookupWorks batches 20 per search and falls back to the work page', async () => {
  const urls: string[] = [];
  const limiter = new Ao3RateLimiter({ sleep: async () => {}, minIntervalMs: 0, refillMs: 1 });
  const client = new Ao3Client({
    limiter,
    fetch: async (url) => {
      urls.push(url);
      const u = new URL(url);
      if (u.pathname === '/works/search') {
        const ids = [...(u.searchParams.get('work_search[query]') ?? '').matchAll(/\d+/g)].map((m) => Number(m[0])).filter((i) => i !== 999);
        return new Response(searchPage(ids.map((i) => blurb(i))));
      }
      if (u.pathname === '/works/999') return new Response(workPage(999));
      return new Response('nope', { status: 404 });
    },
  });
  const ids = [...Array.from({ length: 24 }, (_, i) => i + 1), 999];
  const { found, missing } = await lookupWorks(client, ids);
  assert.equal(found.size, 25);
  assert.deepEqual(missing, []);
  assert.equal(urls.filter((u) => u.includes('/works/search')).length, 2, '25 works = 2 search requests');
  assert.equal(urls.length, 3, 'plus one page fetch for the restricted work');
});

test('imports the original Windows app database', () => {
  const path = join(tmpdir(), `legacy-${process.pid}.db3`);
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE Work (id INTEGER PRIMARY KEY, chapterid INTEGER, number INTEGER, timestamp INTEGER, location INTEGER, seq INTEGER);
    CREATE TABLE ReadingList (Uri TEXT PRIMARY KEY, Timestamp INTEGER, Unread INTEGER, Favourite INTEGER, Model TEXT);
    CREATE TABLE ListFilter (data TEXT PRIMARY KEY, timestamp INTEGER);
    CREATE TABLE Variable (name TEXT PRIMARY KEY, value TEXT);
    INSERT INTO Work VALUES (10, 100, 2, 1500000000000, NULL, 0), (11, 0, 1, 1500000000001, 3000000000, 1);
    INSERT INTO ReadingList VALUES ('http://archiveofourown.org/works/10', 1500000000000, 3, 1, '{}');
    INSERT INTO ListFilter VALUES ('Author Nope', 1500000000000);
    INSERT INTO Variable VALUES ('authorization.username', 'erin');
  `);
  db.close();
  const x = exportFromLegacyDb(path);
  assert.equal(x.username, 'erin');
  assert.deepEqual(x.works['10'], { number: 2, chapterid: 100, location: null, timestamp: 1500000000000, seq: 0 });
  assert.equal(x.works['11'].location, 3000000000);
  assert.deepEqual(Object.keys(x.readingList), ['http://archiveofourown.org/works/10']);
  assert.deepEqual(x.favourites, ['http://archiveofourown.org/works/10']);
  assert.deepEqual(Object.keys(x.listFilters), ['Author Nope']);
});
