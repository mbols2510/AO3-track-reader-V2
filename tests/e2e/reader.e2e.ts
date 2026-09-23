// End-to-end: the real Electron reader + fake AO3 + real tracksync + a stand-in for the original cloud service.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { openDb } from '../../services/tracksync/src/db.ts';
import { buildApp } from '../../services/tracksync/src/app.ts';
import { loadConfig } from '../../services/tracksync/src/config.ts';
import { TrackSyncClient } from '../../packages/core/src/index.ts';
import { startFakeAo3 } from './fakeao3.ts';

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
  ao3.server.close();
}
