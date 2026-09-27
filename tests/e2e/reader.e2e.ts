// End-to-end: the real Electron reader + fake AO3 + real tracksync + a stand-in for the original cloud service.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { openDb } from '../../services/tracksync/src/db.ts';
import { buildApp } from '../../services/tracksync/src/app.ts';
import { loadConfig } from '../../services/tracksync/src/config.ts';
import { TrackSyncClient } from '../../packages/core/src/index.ts';
import { startFakeAo3 } from './fakeao3.ts';
import { buildApp as buildTracker } from '../../services/tracker/src/app.ts';
import { loadConfig as trackerConfig } from '../../services/tracker/src/config.ts';
import { createServer } from 'node:http';

process.env.LOG_LEVEL = 'silent';
const require = createRequire(import.meta.url);
const { _electron } = require('/home/claude/.npm-global/lib/node_modules/playwright');
const root = resolve(import.meta.dirname, '../..');
const shots = process.env.SHOTS_DIR;

async function server() {
  const app = await buildApp(openDb(':memory:'), loadConfig({} as NodeJS.ProcessEnv));
  await app.listen({ port: 0, host: '127.0.0.1' });
  return { app, url: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}` };
}
const sync = await server();
const legacy = await server();
const ao3 = await startFakeAo3();
// A stand-in for GitHub's releases API (issue #5) and a real tracker pointed at the fake AO3.
const gh = createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.url?.endsWith('/releases/latest')) return res.end(JSON.stringify({ tag_name: 'v9.9.0', name: 'Ao3Track 9.9.0', html_url: 'https://github.com/x/y/releases/tag/v9.9.0',
    body: '### Enhancements\n- **Docker images follow latest** (#4). Details.\n- **Update checker** (#5). More.', assets: [{ id: 1, name: 'ArchiveTrackReader-9.9.0-x64.msi', size: 10 }] }));
  res.statusCode = 404; res.end('{}');
});
await new Promise<void>((r) => gh.listen(0, '127.0.0.1', () => r()));
const tracker = await buildTracker(trackerConfig({
  DB_PATH: ':memory:', AO3_ORIGIN: `http://127.0.0.1:${ao3.port}`, RATE_REFILL_SECONDS: '0.2', RATE_MIN_INTERVAL_SECONDS: '0', REFRESH_INTERVAL_HOURS: '0',
  GITHUB_TOKEN: 'test-token', GITHUB_REPO: 'x/y', GITHUB_API_URL: `http://127.0.0.1:${(gh.address() as AddressInfo).port}`,
} as NodeJS.ProcessEnv));
await tracker.listen({ port: 0, host: '127.0.0.1' });
const trackerUrl = `http://127.0.0.1:${(tracker.server.address() as AddressInfo).port}`;

// Seed the "original service" with a long-time user's data.
const old = new TrackSyncClient(legacy.url);
await old.create('longtime', 'oldpass1');
await old.postValues({ 456: { number: 4, chapterid: 4004, location: null, timestamp: 1_500_000_000_000, seq: 0 } });
await old.syncReadingList({ last_sync: 0, paths: { 'http://archiveofourown.org/works/456': 1_500_000_000_000, 'http://archiveofourown.org/series/77': 1_500_000_000_001 } });

const dataDir = mkdtempSync(join(tmpdir(), 'reader-'));
const step = (s: string) => console.log(`  ✓ ${s}`);
const app = await _electron.launch({
  executablePath: join(root, 'node_modules/electron/dist/electron'),
  args: [join(root, 'apps/reader'), `--host-resolver-rules=MAP archiveofourown.org 127.0.0.1:${ao3.port}`, '--no-sandbox'],
  env: { ...process.env, AO3TRACK_DATA_DIR: dataDir, AO3TRACK_START_URL: 'http://archiveofourown.org/works/123/chapters/2002', AO3TRACK_AO3_ORIGIN: 'http://archiveofourown.org' },
});

async function screenshot(name: string) {
  if (!shots) return;
  // Composite the two views the way the window shows them.
  const parts = await app.evaluate(async ({ BaseWindow }: any) => {
    const w = BaseWindow.getAllWindows()[0];
    const out = [];
    for (const v of w.contentView.children) {
      const img = await v.webContents.capturePage();
      out.push({ bounds: v.getBounds(), png: img.toPNG().toString('base64') });
    }
    return out;
  });
  writeFileSync(join(shots, `${name}.json`), JSON.stringify(parts));
}

try {
  let ui: any, page: any, all: any[] = [];
  for (let i = 0; i < 100 && !(ui && page); i++) {
    all = app.windows();
    ui = all.find((p: any) => p.url().startsWith('file:'));
    page = all.find((p: any) => p.url().includes('archiveofourown.org'));
    if (!(ui && page)) await new Promise((r) => setTimeout(r, 200));
  }
  assert.ok(ui && page, `windows: ${all.map((p: any) => p.url())}`);
  await ui.waitForSelector('#acct-form:not([hidden])');
  step('app window opened: toolbar + AO3 page view, settings shown on first run');

  // Sign up on tracksync from the settings pane
  await ui.fill('#acct-form [name=server]', sync.url);
  await ui.fill('#acct-form [name=username]', 'longtime');
  await ui.fill('#acct-form [name=password]', 'newpass1');
  await ui.check('#acct-form [name=create]');
  await ui.click('#acct-form button[type=submit]');
  await ui.waitForSelector('#acct-in:not([hidden])', { timeout: 15000 });
  step('created TrackSync account from the reader');

  // Read to the middle of the chapter
  await page.waitForSelector('#chapters .userstuff p');
  await page.evaluate(() => document.querySelectorAll('#chapters .userstuff p')[80].scrollIntoView({ block: 'center' }));
  await ui.waitForFunction(() => document.querySelector('#pill-sub')?.textContent?.startsWith('Ch 2'), null, { timeout: 5000 });
  await page.waitForTimeout(5500);
  step(`toolbar shows reading location: "${await ui.textContent('#pill-sub')}"`);
  assert.equal(await ui.isDisabled('#btn-next'), false, 'next chapter link detected');

  // Add to reading list from the toolbar
  await ui.click('#btn-rl');
  await ui.waitForSelector('#btn-rl.on');
  await ui.waitForFunction(() => [...document.querySelectorAll('.card .t')].some((e) => e.textContent === 'Work 123'));
  const tags = await ui.$$eval('.card', (cs: HTMLElement[]) => cs.map((c) => c.textContent));
  assert.ok(tags.some((t: string) => t.includes('2 unread')), JSON.stringify(tags));
  step('added to reading list: card shows title, "2 unread", progress — metadata harvested from the page itself');
  const hitsBefore = ao3.hits.length;

  await ui.click('#acct-sync');
  await ui.waitForFunction(() => !document.querySelector('#acct-sync')?.hasAttribute('disabled'));
  const client = new TrackSyncClient(sync.url);
  await client.login('longtime', 'newpass1');
  const vals = await client.getValues(0);
  assert.equal(vals['123'].chapterid, 2002);
  assert.ok(Math.abs(Math.floor(vals['123'].location! / 1e9) - 80) <= 1, `paragraph ${vals['123'].location}`);
  const rl = await client.syncReadingList({ last_sync: 0, paths: {} });
  assert.ok('http://archiveofourown.org/works/123' in rl.paths);
  step('position (chapter 2, paragraph 80) and reading list synced to TrackSync');

  await screenshot('reader-reading');

  // Migrate from the original service
  await ui.fill('#migrate-form [name=username]', 'longtime');
  await ui.fill('#migrate-form [name=password]', 'oldpass1');
  await ui.evaluate(() => (document.querySelector('#migrate-form details') as HTMLDetailsElement).open = true);
  await ui.fill('#migrate-form [name=baseUrl]', `${legacy.url}/api`);
  await ui.click('#migrate-form button[type=submit]');
  await ui.waitForSelector('#migrate-out.ok', { timeout: 15000 });
  step(`migration: ${await ui.textContent('#migrate-out')}`);
  await ui.waitForFunction(() => document.querySelectorAll('.card').length === 3, null, { timeout: 15000 });
  await ui.waitForFunction(() => [...document.querySelectorAll('.card')].some((c) => c.textContent?.includes('Series 77')), null, { timeout: 20000 });
  step('migrated works + series appear in the reading list (series metadata fetched via rate-limited lookup)');
  assert.ok(ao3.hits.slice(hitsBefore).some((h) => h.startsWith('/series/77')));
  assert.ok(ao3.hits.slice(hitsBefore).filter((h) => h.startsWith('/works/search')).length <= 1, 'batched work lookups');

  await page.waitForTimeout(1500);
  await ui.click('#acct-sync');
  await page.waitForTimeout(1500);
  const after = await client.getValues(0);
  assert.equal(after['456']?.number, 4, 'migrated position reached the new server');
  step('migrated data pushed to the new TrackSync server');

  await ui.click('#settings-close');
  await page.waitForTimeout(400);
  await screenshot('reader-list');

  // Listing page decoration inside the reader
  await ui.fill('#url', 'http://archiveofourown.org/works');
  await ui.press('#url', 'Enter');
  await page.waitForSelector('#work_123 .ao3t-unread');
  assert.equal(await page.textContent('#work_123 .ao3t-unread'), '2 unread');
  assert.equal(await page.textContent('#work_456 dd.chapters .ao3t-read'), '4', 'migrated progress shown');
  assert.ok(await page.$('#work_456 .ao3t-inlist'), 'migrated reading-list badge');
  assert.equal(await page.$('#work_456 .ao3t-unread'), null, 'nothing unread when you are ahead of the listing');
  step('works listing: unread badge on 123, migrated progress + reading-list badge on 456');

  // Continue reading via Ctrl+J / the toolbar
  await ui.hover('.card[data-id="123"]');
  await ui.click('.card[data-id="123"] .actions .primary');
  await page.waitForSelector('#chapters .userstuff p');
  await page.waitForTimeout(1800);
  const vis = await page.evaluate(() => {
    const ps = [...document.querySelectorAll('#chapters .userstuff p')];
    return ps.findIndex((p) => { const r = p.getBoundingClientRect(); return r.top <= innerHeight / 2 && r.bottom >= innerHeight / 2; });
  });
  await ui.click('#btn-sync');
  await page.waitForTimeout(1500);
  const latest = Math.floor((await client.getValues(0))['123'].location! / 1e9);
  assert.ok(Math.abs(vis - latest) <= 1, `landed on paragraph ${vis}, saved ${latest}`);
  step(`"Continue" from the reading list reopened the work at paragraph ${vis}`);

  // AO3 "Retry later" while browsing shows the banner and pauses background lookups
  await ui.fill('#url', 'http://archiveofourown.org/works/429');
  await ui.press('#url', 'Enter');
  await ui.waitForSelector('#banner:not([hidden])', { timeout: 8000 });
  step(`rate-limit banner: "${(await ui.textContent('#banner-text'))!.slice(0, 70)}…"`);
  const status = await app.evaluate(() => (globalThis as any).process.pid);
  void status;

  // Issue #2: a filtered fandom listing (AO3 redirects "Sort and Filter" to /works?...&tag_id=) gets a real name
  await ui.fill('#url', 'http://archiveofourown.org/works?work_search%5Bsort_column%5D=revised_at&work_search%5Bcomplete%5D=T&commit=Sort+and+Filter&tag_id=Original+Work');
  await ui.press('#url', 'Enter');
  await page.waitForSelector('#work_123');
  await ui.click('#btn-rl');
  await ui.waitForFunction(() => [...document.querySelectorAll('.card .t')].some((e) => e.textContent === 'Original Work'));
  const listingCard = await ui.$eval('.card[data-key*="tag_id"]', (c: HTMLElement) => c.textContent);
  assert.ok(listingCard.includes('complete only'), listingCard);
  step('filtered fandom listing is named "Original Work" (complete only), not shown as a URL');

  // Issue #3: reading list grouped by fandom, groups fold away and remember it
  const groups = await ui.$$eval('.group-head .name', (els: HTMLElement[]) => els.map((e) => e.textContent));
  assert.ok(groups.includes('Tags, listings & searches'), JSON.stringify(groups));
  assert.ok(groups.some((g: string) => g !== 'Tags, listings & searches' && g !== 'Waiting for details'), `a fandom group: ${JSON.stringify(groups)}`);
  const first = groups[0];
  const before = await ui.$$eval('.card', (cs: HTMLElement[]) => cs.length);
  await ui.click(`.group-head:has(.name:text-is("${first}"))`);
  await ui.waitForFunction((n: number) => document.querySelectorAll('.card').length < n, before);
  await ui.click(`.group-head:has(.name:text-is("${first}"))`);
  await ui.waitForFunction((n: number) => document.querySelectorAll('.card').length === n, before);
  await ui.selectOption('#rl-group', 'none');
  await ui.waitForFunction(() => !document.querySelector('.group-head'));
  await ui.selectOption('#rl-group', 'fandom');
  await ui.waitForSelector('.group-head');
  step(`reading list grouped: ${groups.join(' | ')} (collapse/expand and "No grouping" work)`);

  // Issue #1: text size enlarges the whole page, not just the story text
  await ui.fill('#url', 'http://archiveofourown.org/works/123/chapters/2002');
  await ui.press('#url', 'Enter');
  await page.waitForSelector('#chapters .userstuff p');
  const titleSize = () => page.evaluate(() => document.querySelector('h2.title')!.getBoundingClientRect().height * devicePixelRatio);
  const baseTitle = await titleSize();
  await ui.click('#btn-font-up');
  await ui.click('#btn-font-up');
  await page.waitForFunction(() => Math.abs(devicePixelRatio - 1.2) < 0.01, null, { timeout: 5000 });
  assert.ok((await titleSize()) > baseTitle * 1.1, 'work title got bigger too');
  await page.reload();
  await page.waitForSelector('#chapters .userstuff p');
  await page.waitForFunction(() => Math.abs(devicePixelRatio - 1.2) < 0.01, null, { timeout: 5000 });
  step('text size 120% zooms the whole page (title, tags, story) and survives reloads');
  await ui.click('#btn-settings');
  await ui.click('#font-scope button[data-v="story"]');
  await page.waitForFunction(() => devicePixelRatio === 1 && parseFloat(getComputedStyle(document.querySelector('#chapters')!).fontSize) > 17, null, { timeout: 5000 });
  step('"Story text only" restores the 2.0 behaviour');
  await ui.click('#font-scope button[data-v="page"]');
  // Real keyboard input (Playwright's synthetic keys bypass Electron's before-input-event).
  await app.evaluate(({ BaseWindow }: any) => {
    const wc = BaseWindow.getAllWindows()[0].contentView.children[1].webContents;
    wc.focus();
    wc.sendInputEvent({ type: 'keyDown', keyCode: '0', modifiers: ['control'] });
  });
  await page.waitForFunction(() => devicePixelRatio === 1, null, { timeout: 5000 });
  await ui.click('#settings-close');
  step('Ctrl+0 resets the text size');

  // Issue #9: a fandom AO3 names "Chinese | English" shows (and sorts by) its English name, and can be renamed
  await ui.fill('#url', 'http://archiveofourown.org/works/789/chapters/7890');
  await ui.press('#url', 'Enter');
  await page.waitForSelector('#chapters .userstuff p');
  await ui.click('#btn-rl');
  await ui.waitForFunction(() => [...document.querySelectorAll('.group-head .name')].some((e) => e.textContent === 'Módào Zǔshī - Mòxiāng Tóngxiù'), null, { timeout: 10000 });
  let names = await ui.$$eval('.group-head .name', (els: HTMLElement[]) => els.map((e) => e.textContent));
  assert.ok(names.indexOf('Good Omens') < names.indexOf('Módào Zǔshī - Mòxiāng Tóngxiù'), `sorted by English name: ${names}`);
  step('fandom "魔道祖师 - 墨香铜臭 | Módào Zǔshī - Mòxiāng Tóngxiù" shows as "Módào Zǔshī - Mòxiāng Tóngxiù" and sorts by it');
  // Right-click → Rename group… (the native menu can't be clicked by the test, so send what it sends)
  await app.evaluate(({ BaseWindow }: any, name: string) => BaseWindow.getAllWindows()[0].contentView.children[0].webContents.send('renameGroup', name), '魔道祖师 - 墨香铜臭 | Módào Zǔshī - Mòxiāng Tóngxiù');
  await ui.waitForSelector('.group-head .rename');
  await ui.fill('.group-head .rename', 'Mo Dao Zu Shi');
  await ui.press('.group-head .rename', 'Enter');
  await ui.waitForFunction(() => [...document.querySelectorAll('.group-head .name')].some((e) => e.textContent === 'Mo Dao Zu Shi'));
  const cardBy = await ui.$eval('.card[data-key$="/works/789"] .by', (e: HTMLElement) => e.textContent);
  assert.ok(cardBy.includes('Mo Dao Zu Shi'), cardBy);
  let saved: Record<string, string> = {};
  for (let i = 0; i < 30 && !saved['魔道祖师 - 墨香铜臭 | Módào Zǔshī - Mòxiāng Tóngxiù']; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try { saved = JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8')).prefs.fandomNames ?? {}; } catch { /* mid-write */ }
  }
  assert.equal(saved['魔道祖师 - 墨香铜臭 | Módào Zǔshī - Mòxiāng Tóngxiù'], 'Mo Dao Zu Shi');
  await screenshot('reader-rename');
  step('renamed the group to "Mo Dao Zu Shi": header, card and saved settings updated');

  // Issue #7: with a tracker, the reader only reads the tracker's results; ⟳ checks now
  await ui.click('#banner-close').catch(() => {});
  const ao3Lookups = () => ao3.hits.filter((h) => h.startsWith('/works/search') || h.startsWith('/works?') || h.startsWith('/series/')).length;
  await ui.click('#btn-settings');
  await ui.fill('#tracker-url', trackerUrl);
  await ui.press('#tracker-url', 'Tab');
  await ui.waitForSelector('#refresh-tracker-note:not([hidden])');
  assert.ok(await ui.$eval('#refresh-hours-row', (e: HTMLElement) => e.hidden), 'own schedule hidden in tracker mode');
  const lookupsBefore = ao3Lookups();
  await ui.waitForFunction(() => /via tracker/.test(document.querySelector('#rl-status')!.textContent ?? ''), null, { timeout: 10000 });
  await page.waitForTimeout(1500);
  assert.equal(ao3Lookups(), lookupsBefore, 'switching to the tracker caused no AO3 requests');
  assert.equal((await (await fetch(`${trackerUrl}/api/status`)).json()).limiter.totalRequests, 0, 'tracker made no AO3 requests for a background read');
  step('tracker mode: background update read the tracker cache only (0 AO3 requests); reader schedule replaced by a note');
  await ui.click('#settings-close');
  // Another device adds a work; the reader learns about it by syncing, but doesn't look it up by itself.
  const laptop = new TrackSyncClient(sync.url);
  await laptop.login('longtime', 'newpass1');
  await laptop.syncReadingList({ last_sync: 0, paths: { 'http://archiveofourown.org/works/555': Date.now() } });
  await ui.click('#btn-sync');
  await ui.waitForSelector('.card[data-key$="/works/555"]', { timeout: 10000 });
  await page.waitForTimeout(1500);
  assert.ok((await ui.textContent('.card[data-key$="/works/555"]'))!.includes('Not checked yet'));
  assert.equal((await (await fetch(`${trackerUrl}/api/status`)).json()).limiter.totalRequests, 0, 'still no AO3 requests');
  await ui.click('#rl-refresh');
  await ui.waitForFunction(() => /Updated .* via tracker/.test(document.querySelector('#rl-status')!.textContent ?? ''), null, { timeout: 20000 });
  assert.ok((await (await fetch(`${trackerUrl}/api/status`)).json()).limiter.totalRequests > 0, 'the tracker checked AO3');
  await ui.waitForFunction(() => !(document.querySelector('.card[data-key$="/works/555"]')?.textContent ?? '').includes('Not checked yet'), null, { timeout: 10000 });
  step('work added on another device waits ("Not checked yet"); ⟳ made the tracker check AO3 right away');

  // Issue #6: a background pause shows as a quiet line, not the banner
  tracker.gateway.limiter.reportRateLimited(60_000);
  await ui.click('#btn-settings');
  await ui.fill('#tracker-url', `${trackerUrl}/`); // any change re-reads the tracker
  await ui.press('#tracker-url', 'Tab');
  await ui.click('#settings-close');
  await ui.waitForFunction(() => /Updates paused by AO3 until/.test(document.querySelector('#rl-status')!.textContent ?? ''), null, { timeout: 10000 });
  assert.ok(await ui.$eval('#banner', (e: HTMLElement) => e.hidden), 'no banner for a background pause');
  step(`background pause: "${await ui.textContent('#rl-status')}", no banner`);

  // Issue #5: update check through the tracker (the native dialog is stubbed to record it and answer "Later")
  await app.evaluate(({ dialog }: any) => {
    (globalThis as any).__dialogs = [];
    dialog.showMessageBox = async (_w: unknown, o: unknown) => { (globalThis as any).__dialogs.push(o); return { response: 1 }; };
  });
  await ui.click('#btn-settings');
  await ui.click('#check-update');
  await ui.waitForFunction(() => !(document.querySelector('#check-update') as HTMLButtonElement).disabled);
  const dlg = await app.evaluate(() => (globalThis as any).__dialogs[0]);
  assert.equal(dlg?.message, 'Archive Track Reader 9.9.0 is available', JSON.stringify(dlg));
  assert.deepEqual(dlg.buttons.slice(1), ['Later', 'Skip this version']);
  assert.ok(dlg.detail.includes('You have 2.2.2') && dlg.detail.includes('Update checker'), dlg.detail);
  await ui.click('#settings-close');
  step(`update prompt: "${dlg.message}" [${dlg.buttons.join(' | ')}]`);

  // Dark mode
  await ui.click('#btn-settings');
  await ui.click('#theme button[data-v="dark"]');
  await ui.waitForSelector('html.dark');
  const bg = await ui.evaluate(() => getComputedStyle(document.querySelector('.pane')!).backgroundColor);
  assert.notEqual(bg, 'rgb(247, 244, 241)', 'dark palette applied');
  step(`dark mode applied to app chrome (${bg})`);
  await ui.fill('#url', 'http://archiveofourown.org/works/123/chapters/2002');
  await ui.press('#url', 'Enter');
  await page.waitForTimeout(1500);
  await ui.click('#settings-close');
  await page.waitForTimeout(300);
  await screenshot('reader-dark');
  console.log('\nreader e2e: all checks passed');
} finally {
  await app.close().catch(() => {});
  await sync.app.close();
  await legacy.app.close();
  await tracker.close();
  gh.close();
  ao3.server.close();
}
