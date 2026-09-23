// End-to-end: real Chrome + the built MV3 extension + fake AO3 + a real tracksync server.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
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
const { chromium } = require('/home/claude/.npm-global/lib/node_modules/playwright');
const CHROME = process.env.CHROME ?? '/home/claude/.cache/puppeteer/chrome/linux-131.0.6778.204/chrome-linux64/chrome';
const EXT = resolve(import.meta.dirname, '../../apps/extension/dist/unpacked');

const sync = await buildApp(openDb(':memory:'), loadConfig({} as NodeJS.ProcessEnv));
await sync.listen({ port: 0, host: '127.0.0.1' });
const syncUrl = `http://127.0.0.1:${(sync.server.address() as AddressInfo).port}`;
const ao3 = await startFakeAo3();

const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'ext-')), {
  executablePath: CHROME,
  headless: true,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, `--host-resolver-rules=MAP archiveofourown.org 127.0.0.1:${ao3.port}`, '--no-sandbox'],
});
const step = (s: string) => console.log(`  ✓ ${s}`);
try {
  let [sw] = ctx.serviceWorkers();
  sw ??= await ctx.waitForEvent('serviceworker');
  const extId = new URL(sw.url()).host;
  step(`extension loaded (${extId})`);

  const opts = await ctx.newPage();
  await opts.goto(`chrome-extension://${extId}/options.html`);
  const login = await opts.evaluate((server: string) => chrome.runtime.sendMessage({ type: 'LOGIN', server, username: 'reader', password: 'password1', create: true }), syncUrl);
  assert.ok(login.ok, JSON.stringify(login));
  step('created account on tracksync from the extension');

  // Filter out an author, then load a listing page
  await opts.evaluate(() => chrome.runtime.sendMessage({ type: 'SET', data: {} }));
  const client = new TrackSyncClient(syncUrl);
  await client.login('reader', 'password1');
  await client.syncListFilters({ last_sync: 0, filters: { 'Author blocked': Date.now() } });
  await opts.evaluate(() => chrome.runtime.sendMessage({ type: 'DO_SYNC' }));

  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.goto('http://archiveofourown.org/works/123/chapters/2002');
  await page.waitForSelector('#ao3t-fab');
  step('content script injected on AO3 work page');

  // Scroll to roughly paragraph 60 of 120 and let the tracker save
  await page.evaluate(() => document.querySelectorAll('#chapters .userstuff p')[60].scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(6000);
  const sv = await opts.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_DETAILS', works: [123] }));
  const loc = sv[123].savedLoc;
  assert.equal(loc.number, 2);
  assert.equal(loc.chapterid, 2002);
  const para = Math.floor(loc.location / 1e9);
  assert.ok(para >= 58 && para <= 62, `saved paragraph ${para}`);
  step(`reading position saved: chapter 2, paragraph ${para}`);

  await opts.evaluate(() => chrome.runtime.sendMessage({ type: 'DO_SYNC' }));
  const server = await client.getValues(0);
  assert.equal(server['123'].chapterid, 2002);
  step('position synced to tracksync server');

  // Add to reading list via the floating button
  await page.click('#ao3t-fab button:last-child');
  await page.waitForFunction(() => document.querySelector('#ao3t-fab button:last-child')?.textContent?.includes('In reading list'));
  await opts.evaluate(() => chrome.runtime.sendMessage({ type: 'DO_SYNC' }));
  const rl = await client.syncReadingList({ last_sync: 0, paths: {} });
  assert.ok('http://archiveofourown.org/works/123' in rl.paths, JSON.stringify(rl));
  step('reading list toggle synced (canonical key http://archiveofourown.org/works/123)');

  // Reload: "Continue reading" jumps back to the saved paragraph
  await page.goto('http://archiveofourown.org/works/123/chapters/2002');
  await page.waitForSelector('#ao3t-fab button.primary');
  await page.click('#ao3t-fab button.primary');
  await page.waitForTimeout(1500);
  const visible = await page.evaluate(() => {
    const ps = [...document.querySelectorAll('#chapters .userstuff p')];
    const mid = innerHeight / 2;
    return ps.findIndex((p) => { const r = p.getBoundingClientRect(); return r.top <= mid && r.bottom >= mid; });
  });
  assert.ok(Math.abs(visible - para) <= 1, `jumped to paragraph ${visible}`);
  step(`"Continue reading" jumped back to paragraph ${visible}`);

  // Listing page: unread badge, reading-list badge, author filter
  await page.goto('http://archiveofourown.org/works');
  await page.waitForSelector('#work_123 .ao3t-unread');
  const badge = await page.textContent('#work_123 .ao3t-unread');
  assert.equal(badge, '2 unread');
  assert.ok(await page.$('#work_123 .ao3t-inlist'));
  const readLink = await page.textContent('#work_123 dd.chapters .ao3t-read');
  assert.equal(readLink, '1');
  await page.waitForSelector('#work_456.ao3t-filtered-hide');
  assert.match(await page.textContent('#work_456 .ao3t-filtered-message') ?? '', /Author blocked/);
  assert.ok(await page.isVisible('#work_789 h4.heading'));
  step('listing: "2 unread" + reading-list badges shown, filtered author hidden');

  // Unit conversion setting
  const s = await opts.evaluate(() => chrome.runtime.sendMessage({ type: 'SETTINGS' }));
  s.unitConv.temp = 2;
  await opts.evaluate((st: unknown) => chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings: st }), s);
  await page.goto('http://archiveofourown.org/works/123/chapters/2002');
  await page.waitForSelector('span.mw_ao3track_unitconv');
  await page.click('span.mw_ao3track_unitconv');
  assert.match(await page.textContent('span.mw_ao3track_unitconv') ?? '', /22\.2° C/);
  step('unit conversion: "72 degrees Fahrenheit" → 22.2° C');
  console.log('\nextension e2e: all checks passed');
} finally {
  await ctx.close();
  await sync.close();
  ao3.server.close();
}
