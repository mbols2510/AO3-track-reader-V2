import { app, BaseWindow, WebContentsView, ipcMain, shell, session, nativeTheme, Menu, clipboard, dialog, type WebContents } from 'electron';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import {
  SyncEngine, isAo3Url, isAhead, filterFromUrl, readingListKey, workIdFromUrl, exportFromSyncServer, LEGACY_API,
  type WorkChapter, type WorkChapterEx, type ReaderSettings,
} from '@ao3track/core';
import { parseWorkBlurbs, parseWorkPage } from '@ao3track/core/parse';
import { JsonStore } from './jsonstore.ts';
import { defaultState, defaultMeta, type AppState, type MetaCacheFile, type Prefs } from './state.ts';
import { ReadingListService } from './readinglist.ts';

const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';
const AO3_PARTITION = 'persist:ao3';
const TOOLBAR_H = 48;

// Portable / test mode: keep all data (including AO3 cookies) in one folder.
if (process.env.AO3TRACK_DATA_DIR) app.setPath('userData', process.env.AO3TRACK_DATA_DIR);
if (!app.requestSingleInstanceLock()) app.quit();
app.setAppUserModelId('org.ao3track.reader');

let win: BaseWindow;
let ui: WebContentsView;
let page: WebContentsView;
let store: JsonStore<AppState>;
let meta: JsonStore<MetaCacheFile>;
let engine: SyncEngine;
let rl: ReadingListService;
let contentRect = { x: 0, y: TOOLBAR_H, width: 800, height: 600 };
let syncTimer: NodeJS.Timeout | null = null;
let pageCssKey: string | null = null;
let fontCssKey: string | null = null;
const trackerCss = readFileSync(join(__dirname, 'tracker.css'), 'utf8');

const prefs = (): Prefs => store.data.prefs;
const toUi = (channel: string, ...args: unknown[]) => { if (!ui?.webContents.isDestroyed()) ui.webContents.send(channel, ...args); };

// ---------------------------------------------------------------- sync

function scheduleSync(ms: number) {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => void engine.sync().then(pushState), ms);
}

function pushState() {
  const s = engine.state;
  toUi('state', {
    sync: { status: engine.status, username: s.auth?.username ?? null, server: s.serverUrl, lastSyncAt: s.lastSyncAt, lastSyncError: s.lastSyncError, works: Object.keys(s.works).length },
    settings: store.data.settings,
    prefs: prefs(),
    filters: engine.filters().all().sort(),
  });
}

function pushReadingList() {
  toUi('readingList', rl.items());
}

// ---------------------------------------------------------------- window

function applyTheme() {
  nativeTheme.themeSource = prefs().theme;
  const dark = nativeTheme.shouldUseDarkColors;
  if (isWin && win) win.setTitleBarOverlay?.({ color: '#00000000', symbolColor: dark ? '#efeae6' : '#1d1b1a', height: TOOLBAR_H });
  // AO3 has no dark mode of its own; its "Reversi" skin is the closest.
  const s = store.data.settings;
  s.theme = dark ? 'dark' : 'light';
  toUi('theme', dark);
}

function layout() {
  const b = win.getContentBounds();
  ui.setBounds({ x: 0, y: 0, width: b.width, height: b.height });
  page.setBounds({ x: Math.round(contentRect.x), y: Math.round(contentRect.y), width: Math.max(0, Math.round(contentRect.width)), height: Math.max(0, Math.round(contentRect.height)) });
}

function createWindow() {
  const bounds = prefs().bounds;
  win = new BaseWindow({
    width: bounds.width, height: bounds.height, x: bounds.x, y: bounds.y,
    minWidth: 720, minHeight: 480, title: 'Archive Track Reader',
    icon: join(__dirname, 'icon.png'),
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    titleBarOverlay: isWin ? { color: '#00000000', symbolColor: '#1d1b1a', height: TOOLBAR_H } : undefined,
    backgroundMaterial: isWin ? 'mica' : undefined,
    backgroundColor: isWin ? '#00000000' : undefined,
    show: false,
  });
  if (bounds.maximized) win.maximize();

  ui = new WebContentsView({ webPreferences: { preload: join(__dirname, 'preload-ui.js'), sandbox: true, contextIsolation: true } });
  if (isWin) ui.setBackgroundColor('#00000000');
  page = new WebContentsView({
    webPreferences: {
      preload: join(__dirname, 'preload-page.js'), partition: AO3_PARTITION,
      sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false,
    },
  });
  win.contentView.addChildView(ui);
  win.contentView.addChildView(page);
  layout();
  win.on('resize', layout);
  win.on('close', () => {
    const b = win.getNormalBounds();
    prefs().bounds = { ...b, maximized: win.isMaximized() };
    prefs().lastUrl = page.webContents.getURL() || prefs().lastUrl;
    store.flush();
    meta.flush();
  });
  win.on('closed', () => app.quit());

  void ui.webContents.loadFile(join(__dirname, 'ui', 'index.html'));
  ui.webContents.once('did-finish-load', () => {
    applyTheme();
    pushState();
    pushReadingList();
    toUi('refreshStatus', rl.status());
    win.show();
  });
  wirePage(page.webContents);
  const start = process.env.AO3TRACK_START_URL || prefs().lastUrl || prefs().homeUrl;
  void page.webContents.loadURL(isAo3Url(start) ? start : prefs().homeUrl);
}

// ---------------------------------------------------------------- the AO3 page

function wirePage(wc: WebContents) {
  // Keep the reader on AO3: everything else opens in the system browser.
  const allow = (url: string) => isAo3Url(url) || url.startsWith('about:') || url.startsWith('devtools:') || !!process.env.AO3TRACK_ALLOW_ANY;
  wc.on('will-navigate', (e, url) => { if (!allow(url)) { e.preventDefault(); void shell.openExternal(url); } });
  wc.setWindowOpenHandler(({ url }) => {
    if (isAo3Url(url)) void wc.loadURL(url); else void shell.openExternal(url);
    return { action: 'deny' };
  });

  wc.on('did-start-navigation', (d) => { if (d.isMainFrame && !d.isSameDocument) toUi('page', { loading: true, url: d.url }); });
  wc.on('did-navigate', (_e, url, code) => {
    if (code === 429) {
      rl.reportBrowsingRateLimited(null);
      toUi('rateLimited', { until: rl.limiter.status().pausedUntil, fromBrowsing: true });
    }
    toUi('page', { url, loading: true, canGoBack: wc.navigationHistory.canGoBack(), canGoForward: wc.navigationHistory.canGoForward(), inReadingList: engine.inReadingList(url) });
  });
  wc.on('did-navigate-in-page', (_e, url) => toUi('page', { url, canGoBack: wc.navigationHistory.canGoBack(), canGoForward: wc.navigationHistory.canGoForward(), inReadingList: engine.inReadingList(url) }));
  wc.on('dom-ready', async () => {
    if (pageCssKey) await wc.removeInsertedCSS(pageCssKey).catch(() => {});
    pageCssKey = await wc.insertCSS(trackerCss);
    await applyFontSize();
  });
  wc.on('did-stop-loading', () => toUi('page', { loading: false, title: wc.getTitle(), url: wc.getURL() }));
  wc.on('did-fail-load', (_e, code, desc, url, isMain) => { if (isMain && code !== -3) toUi('page', { loading: false, error: `${desc} (${code})`, url }); });

  wc.on('context-menu', (_e, p) => {
    const items: Electron.MenuItemConstructorOptions[] = [];
    if (p.linkURL) {
      const inAo3 = isAo3Url(p.linkURL);
      items.push({ label: 'Open link', click: () => void wc.loadURL(p.linkURL) });
      if (inAo3 && readingListKey(p.linkURL)) {
        const inList = engine.inReadingList(p.linkURL);
        items.push({ label: inList ? 'Remove from reading list' : 'Add to reading list', click: () => toggleReadingList(p.linkURL) });
      }
      const filter = inAo3 ? filterFromUrl(p.linkURL, p.linkText) : null;
      if (filter) {
        const on = engine.filters().all().includes(filter);
        items.push({ label: on ? `Stop hiding “${filter}”` : `Hide works: ${filter}`, click: () => { on ? engine.removeFilter(filter) : engine.addFilter(filter); pushState(); scheduleSync(3000); } });
      }
      items.push({ type: 'separator' }, { label: 'Open in browser', click: () => void shell.openExternal(p.linkURL) }, { label: 'Copy link', click: () => clipboard.writeText(p.linkURL) });
    } else if (p.selectionText) {
      items.push({ role: 'copy' }, { label: `Search AO3 for “${p.selectionText.slice(0, 30)}”`, click: () => void wc.loadURL(`https://archiveofourown.org/works/search?work_search[query]=${encodeURIComponent(p.selectionText)}`) });
    } else {
      items.push(
        { label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
        { label: 'Forward', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
        { label: 'Reload', click: () => wc.reload() },
        { type: 'separator' },
        { label: engine.inReadingList(wc.getURL()) ? 'Remove page from reading list' : 'Add page to reading list', click: () => toggleReadingList(wc.getURL()) },
      );
    }
    if (p.isEditable) items.unshift({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { type: 'separator' });
    if (!app.isPackaged) items.push({ type: 'separator' }, { label: 'Inspect', click: () => wc.inspectElement(p.x, p.y) });
    Menu.buildFromTemplate(items).popup();
  });

  wc.on('before-input-event', (e, input) => { if (handleShortcut(input)) e.preventDefault(); });
  wc.on('zoom-changed', (_e, dir) => void setFont(prefs().fontSize + (dir === 'in' ? 10 : -10)));
}

/**
 * Text size. "page" zooms the whole AO3 page (titles, tags, menus, story text,
 * like the original app); "story" enlarges only the story text and summaries.
 */
async function applyFontSize() {
  const wc = page.webContents;
  const size = prefs().fontSize;
  const wholePage = prefs().fontScope !== 'story';
  if (fontCssKey) { const k = fontCssKey; fontCssKey = null; await wc.removeInsertedCSS(k).catch(() => {}); }
  wc.setZoomFactor(wholePage ? size / 100 : 1);
  if (!wholePage && size !== 100) fontCssKey = await wc.insertCSS(`#workskin, #chapters, .userstuff { font-size: ${size}% !important; }`);
}

function toggleReadingList(url: string) {
  const inList = engine.inReadingList(url);
  if (inList) engine.removeFromReadingList(url);
  else {
    engine.addToReadingList(url);
    void rl.refresh(true, [readingListKey(url)!]);
  }
  toUi('page', { inReadingList: engine.inReadingList(page.webContents.getURL()) });
  toUi('toast', inList ? 'Removed from reading list' : 'Added to reading list');
  pushReadingList();
  scheduleSync(3000);
}

let nextUrl: string | null = null, prevUrl: string | null = null;

function handleShortcut(input: Electron.Input): boolean {
  if (input.type !== 'keyDown') return false;
  const mod = isMac ? input.meta : input.control;
  const wc = page.webContents;
  const k = input.key;
  if (input.alt && k === 'ArrowLeft') { wc.navigationHistory.goBack(); return true; }
  if (input.alt && k === 'ArrowRight') { wc.navigationHistory.goForward(); return true; }
  if (k === 'F5' || (mod && k.toLowerCase() === 'r' && !input.shift)) { wc.reload(); return true; }
  if (mod && k.toLowerCase() === 'l') { ui.webContents.focus(); toUi('focusUrl'); return true; }
  if (mod && k.toLowerCase() === 'j') { wc.send('page:jump'); return true; }
  if (mod && k.toLowerCase() === 'd') { toggleReadingList(wc.getURL()); return true; }
  if (mod && k.toLowerCase() === 'b') { toUi('togglePane', 'readingList'); return true; }
  if (mod && (k === '=' || k === '+')) { void setFont(prefs().fontSize + 10); return true; }
  if (mod && k === '-') { void setFont(prefs().fontSize - 10); return true; }
  if (mod && k === '0') { void setFont(100); return true; }
  if (input.shift && mod && k === 'ArrowRight' && nextUrl) { void wc.loadURL(nextUrl); return true; }
  if (input.shift && mod && k === 'ArrowLeft' && prevUrl) { void wc.loadURL(prevUrl); return true; }
  if (k === 'F12' && !app.isPackaged) { wc.toggleDevTools(); return true; }
  return false;
}

async function setFont(v: number) {
  prefs().fontSize = Math.min(250, Math.max(60, Math.round(v)));
  store.save();
  await applyFontSize();
  pushState();
}

// ---------------------------------------------------------------- IPC: page preload

function wireIpc() {
  ipcMain.on('page:settings', (e) => { e.returnValue = store.data.settings; });

  ipcMain.handle('page:getWorkDetails', (_e, works: number[]) => {
    const out: Record<number, { savedLoc?: WorkChapter; inReadingList?: boolean }> = {};
    for (const id of works) {
      const w = engine.getWork(id);
      const inList = engine.inReadingList(`https://archiveofourown.org/works/${id}`);
      if (w || inList) out[id] = { savedLoc: w, inReadingList: inList };
    }
    return out;
  });

  ipcMain.on('page:setWorkChapters', (_e, data: Record<number, WorkChapter>) => {
    let important = false, any = false;
    for (const [id, wc] of Object.entries(data)) {
      const prev = engine.getWork(Number(id));
      if (engine.setWork(Number(id), wc)) {
        any = true;
        important ||= !prev || wc.location === null || wc.number !== prev.number;
      }
    }
    if (any) {
      scheduleSync(important ? 10_000 : 60_000);
      if (important) pushReadingList();
    }
  });

  ipcMain.handle('page:shouldFilter', (_e, workid: number, authors: string[], tags: string[], series: number[]) => engine.filters().match(workid, authors, tags, series));
  ipcMain.handle('page:urlsInList', (_e, urls: string[]) => Object.fromEntries(urls.map((u) => [u, engine.inReadingList(u)])));
  ipcMain.on('page:nav', (_e, n: { next: string | null; prev: string | null }) => { nextUrl = n.next; prevUrl = n.prev; toUi('page', { next: n.next, prev: n.prev }); });
  ipcMain.on('page:jumpAvailable', (_e, loc: WorkChapter) => toUi('page', { jump: loc }));
  ipcMain.on('page:location', (_e, loc: WorkChapterEx & { percent: number }) => toUi('location', loc));
  ipcMain.on('page:title', (_e, t: unknown) => toUi('page', { pageTitle: t }));
  ipcMain.on('page:harvest', (_e, h: { kind: 'blurbs' | 'work'; html: string; workid?: number }) => {
    try {
      if (h.kind === 'blurbs') rl.ingestWorks(parseWorkBlurbs(h.html));
      else if (h.workid) { const w = parseWorkPage(h.html, h.workid); if (w) rl.ingestWorks([w]); }
    } catch { /* best effort */ }
  });
  ipcMain.on('page:rateLimited', () => {
    rl.reportBrowsingRateLimited(null);
    toUi('rateLimited', { until: rl.limiter.status().pausedUntil, fromBrowsing: true });
  });

  // ---------------------------------------------------------------- IPC: app UI

  ipcMain.on('ui:layout', (_e, r: typeof contentRect) => { contentRect = r; layout(); });
  ipcMain.handle('ui:nav', (_e, action: string, arg?: string) => {
    const wc = page.webContents;
    switch (action) {
      case 'back': wc.navigationHistory.goBack(); break;
      case 'forward': wc.navigationHistory.goForward(); break;
      case 'reload': wc.reload(); break;
      case 'stop': wc.stop(); break;
      case 'home': void wc.loadURL(prefs().homeUrl); break;
      case 'next': if (nextUrl) void wc.loadURL(nextUrl); break;
      case 'prev': if (prevUrl) void wc.loadURL(prevUrl); break;
      case 'jump': wc.send('page:jump'); break;
      case 'go': {
        const s = (arg ?? '').trim();
        if (!s) break;
        const url = /^https?:\/\//i.test(s) ? s : /^(www\.)?(archiveofourown|ao3)\.org/i.test(s) ? `https://${s}` : /^\d+$/.test(s) ? `https://archiveofourown.org/works/${s}` : `https://archiveofourown.org/works/search?work_search[query]=${encodeURIComponent(s)}`;
        if (isAo3Url(url)) void wc.loadURL(url); else void shell.openExternal(url);
        break;
      }
      case 'open': if (arg) void wc.loadURL(arg); break;
    }
    page.webContents.focus();
  });
  ipcMain.handle('ui:toggleReadingList', () => toggleReadingList(page.webContents.getURL()));
  ipcMain.handle('ui:font', (_e, delta: number) => setFont(delta === 0 ? 100 : prefs().fontSize + delta));

  ipcMain.handle('ui:readingList:refresh', () => void rl.refresh(true));
  ipcMain.handle('ui:readingList:remove', (_e, key: string) => { engine.removeFromReadingList(key); pushReadingList(); scheduleSync(3000); });
  ipcMain.handle('ui:readingList:favourite', (_e, key: string) => {
    const f = new Set(prefs().favourites);
    if (f.has(key)) f.delete(key); else f.add(key);
    prefs().favourites = [...f];
    store.save();
    pushReadingList();
  });
  ipcMain.handle('ui:readingList:markRead', (_e, key: string, read: boolean) => {
    const id = workIdFromUrl(key);
    const m = id ? meta.data.works[id] : null;
    if (!id) return;
    const cur = engine.getWork(id);
    const next: WorkChapter = read
      ? { number: m?.chaptersPublished ?? cur?.number ?? 1, chapterid: cur?.chapterid ?? 0, location: null, seq: null }
      : { number: 1, chapterid: 0, location: 0, seq: null };
    // Marking read only moves forward; marking unread must go backwards, so it bumps seq.
    if (read && cur && !isAhead(cur, next)) return;
    engine.setWork(id, next, !read);
    pushReadingList();
    scheduleSync(3000);
  });

  ipcMain.handle('ui:prefs', (_e, patch: Partial<Prefs>) => {
    const trackerChanged = (patch.trackerUrl !== undefined && patch.trackerUrl !== prefs().trackerUrl) || (patch.trackerKey !== undefined && patch.trackerKey !== prefs().trackerKey);
    Object.assign(prefs(), patch);
    store.save();
    if (patch.theme) applyTheme();
    if (patch.fontSize !== undefined || patch.fontScope !== undefined) void applyFontSize();
    if (trackerChanged) void rl.refresh(false);
    pushState();
    if (patch.readingListSort || patch.readingListFilter || patch.readingListGroup) pushReadingList();
  });
  ipcMain.handle('ui:settings', (_e, s: ReaderSettings) => {
    store.data.settings = s;
    store.save();
    pushState();
    page.webContents.reload(); // page script reads settings at load
  });
  ipcMain.handle('ui:removeFilter', (_e, f: string) => { engine.removeFilter(f); pushState(); scheduleSync(3000); });

  ipcMain.handle('ui:signIn', async (_e, a: { server: string; username: string; password: string; create?: boolean; email?: string }) => {
    try {
      const r = await engine.signIn(a.server, a.username, a.password, a.create, a.email);
      if ('errors' in r) return r;
      await engine.sync();
      pushState();
      pushReadingList();
      void rl.refresh(false);
      return { ok: true };
    } catch (e) {
      return { errors: { server: `Couldn't reach the sync server: ${(e as Error).message}` } };
    }
  });
  ipcMain.handle('ui:signOut', () => { engine.signOut(); pushState(); });
  ipcMain.handle('ui:syncNow', async () => { const r = await engine.sync(); pushState(); pushReadingList(); return r; });
  ipcMain.handle('ui:testTracker', async (_e, url: string, key = '') => {
    try {
      const r = await fetch(`${url.replace(/\/+$/, '')}/api/status`, { signal: AbortSignal.timeout(5000), headers: key ? { 'X-Api-Key': key } : {} });
      if (r.status === 401) return { ok: false, error: 'wrong or missing API key' };
      return r.ok ? { ok: true, status: await r.json() } : { ok: false, error: `HTTP ${r.status}` };
    } catch (e) { return { ok: false, error: (e as Error).message }; }
  });

  ipcMain.handle('ui:migrate', async (_e, a: { username: string; password: string; baseUrl?: string }) => {
    try {
      const data = await exportFromSyncServer(a.username, a.password, { baseUrl: a.baseUrl || LEGACY_API });
      return { ok: true, ...importIntoEngine(data.works, data.readingList, data.listFilters) };
    } catch (e) { return { ok: false, error: (e as Error).message }; }
  });
  ipcMain.handle('ui:exportFile', async () => {
    const r = await dialog.showSaveDialog({ defaultPath: `ao3track-backup-${new Date().toISOString().slice(0, 10)}.json`, filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (r.canceled || !r.filePath) return false;
    const s = engine.state;
    const { writeFileSync } = await import('node:fs');
    writeFileSync(r.filePath, JSON.stringify({ format: 'ao3track-export', version: 1, source: 'desktop', username: s.auth?.username ?? '', exportedAt: new Date().toISOString(), works: s.works, readingList: s.readingList.paths, listFilters: s.listFilters.filters, favourites: prefs().favourites }, null, 1));
    return true;
  });
  ipcMain.handle('ui:importFile', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'Ao3Track backup', extensions: ['json'] }] });
    if (r.canceled || !r.filePaths[0]) return null;
    const data = JSON.parse(readFileSync(r.filePaths[0], 'utf8'));
    if (data?.format !== 'ao3track-export') return { ok: false, error: 'Not an Ao3Track backup file.' };
    if (Array.isArray(data.favourites)) prefs().favourites = [...new Set([...prefs().favourites, ...data.favourites])];
    return { ok: true, ...importIntoEngine(data.works ?? {}, data.readingList ?? {}, data.listFilters ?? {}) };
  });
  ipcMain.handle('ui:openExternal', (_e, url: string) => shell.openExternal(url));
  ipcMain.handle('ui:version', () => app.getVersion());
}

/** Merge exported data locally; everything added gets a fresh timestamp so sync treats it as new. */
function importIntoEngine(works: Record<string, WorkChapter & { seq?: number }>, readingList: Record<string, number>, filters: Record<string, number>) {
  let worksAdded = 0, rlAdded = 0, filtersAdded = 0;
  for (const [id, w] of Object.entries(works)) {
    if (engine.setWork(Number(id), { number: Number(w.number), chapterid: Number(w.chapterid), location: w.location ?? null, seq: null })) worksAdded++;
  }
  for (const k of Object.keys(readingList)) if (k && !engine.inReadingList(k)) { engine.addToReadingList(k); rlAdded++; }
  for (const f of Object.keys(filters)) if (f && !engine.filters().all().includes(f)) { if (engine.addFilter(f)) filtersAdded++; }
  store.save();
  pushState();
  pushReadingList();
  void engine.sync().then(pushState);
  void rl.refresh(false);
  return { worksAdded, readingListAdded: rlAdded, listFiltersAdded: filtersAdded };
}

// ---------------------------------------------------------------- startup

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on('window-all-closed', () => app.quit());

app.whenReady().then(() => {
  Menu.setApplicationMenu(isMac ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]) : null);
  const dir = app.getPath('userData');
  store = new JsonStore(join(dir, 'state.json'), defaultState);
  store.data.prefs = { ...defaultState().prefs, ...store.data.prefs };
  store.data.settings = { ...defaultState().settings, ...store.data.settings };
  meta = new JsonStore(join(dir, 'metadata.json'), defaultMeta);
  engine = new SyncEngine(store.data.sync, (s) => { store.data.sync = s; store.save(); });
  engine.onChange(() => toUi('syncStatus', { status: engine.status, lastSyncAt: engine.state.lastSyncAt, lastSyncError: engine.state.lastSyncError }));

  const ao3Session = session.fromPartition(AO3_PARTITION);
  // Background lookups share the reader's AO3 cookies, so restricted works resolve when logged in.
  rl = new ReadingListService(engine, meta, prefs, (url, init) => ao3Session.fetch(url, init));
  rl.on('changed', pushReadingList);
  rl.on('status', (s) => {
    toUi('refreshStatus', s);
    if (s.limiter?.pausedUntil) toUi('rateLimited', { until: s.limiter.pausedUntil, fromBrowsing: false });
  });
  nativeTheme.on('updated', applyTheme);

  wireIpc();
  createWindow();
  rl.startSchedule();
  setInterval(() => void engine.sync().then(pushState), 30 * 60_000);
  setTimeout(() => void engine.sync().then(() => { pushState(); pushReadingList(); }), 2_000);
});

app.on('before-quit', () => { store?.flush(); meta?.flush(); });
