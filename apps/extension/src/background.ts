import { SyncEngine, defaultReaderSettings, filterFromUrl, readingListKey, workKey, type ReaderSettings, type SyncState } from '@ao3track/core';
import type { Msg } from './messages.ts';

// ---- state (reloaded whenever the service worker wakes) ----
let engine: SyncEngine | null = null;
let settings: ReaderSettings = defaultReaderSettings();
let saveTimer: ReturnType<typeof setTimeout> | null = null;

async function load(): Promise<SyncEngine> {
  if (engine) return engine;
  const got = await chrome.storage.local.get(['sync', 'settings', 'authorization', 'last_sync']);
  settings = { ...defaultReaderSettings(), ...(got.settings ?? {}) };
  let state: Partial<SyncState> = (got.sync as Partial<SyncState> | undefined) ?? {};
  // Upgrade from the 2017 extension, which kept works as top-level keys.
  if (!got.sync && got.authorization) {
    const all = await chrome.storage.local.get(null);
    const works: SyncState['works'] = {};
    for (const [k, v] of Object.entries(all)) if (/^\d+$/.test(k) && v && typeof v === 'object') works[k] = { seq: 0, ...(v as object) } as never;
    state = { serverUrl: 'https://wenchy.net/ao3track/api', auth: got.authorization as SyncState['auth'], works, unsynced: Object.keys(works) };
  }
  engine = new SyncEngine(state, (s) => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void chrome.storage.local.set({ sync: s }), 300);
  });
  return engine;
}

/** Sync soon, coalescing bursts (e.g. many position updates while scrolling). */
function scheduleSync(delayMinutes = 0.5) {
  void chrome.alarms.create('sync-soon', { delayInMinutes: delayMinutes });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    const ao3 = ['*://archiveofourown.org/*', '*://www.archiveofourown.org/*'];
    chrome.contextMenus.create({ id: 'rl-add', title: 'Add to reading list', contexts: ['link'], targetUrlPatterns: ao3 });
    chrome.contextMenus.create({ id: 'rl-page', title: 'Add this page to reading list', contexts: ['page'], documentUrlPatterns: ao3 });
    chrome.contextMenus.create({ id: 'filter', title: 'Hide works matching this link (tag / author / work / series)', contexts: ['link'], targetUrlPatterns: ao3 });
  });
  void chrome.alarms.create('sync-periodic', { periodInMinutes: 30 });
});
chrome.runtime.onStartup.addListener(() => void load().then((e) => e.sync()));

chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name === 'sync-soon' || a.name === 'sync-periodic') await (await load()).sync();
});

chrome.contextMenus.onClicked.addListener(async (info) => {
  const e = await load();
  if (info.menuItemId === 'rl-add' && info.linkUrl) e.addToReadingList(info.linkUrl);
  if (info.menuItemId === 'rl-page' && info.pageUrl) e.addToReadingList(info.pageUrl);
  if (info.menuItemId === 'filter' && info.linkUrl) {
    const f = filterFromUrl(info.linkUrl, info.selectionText);
    if (f) e.addFilter(f);
  }
  scheduleSync(0.1);
});

async function handle(m: Msg): Promise<unknown> {
  const e = await load();
  switch (m.type) {
    case 'GET_DETAILS': {
      const out: Record<number, { savedLoc?: unknown; inReadingList?: boolean }> = {};
      for (const id of m.works) {
        const w = e.getWork(id);
        const inList = workKey(id) in e.state.readingList.paths;
        if (w || inList) out[id] = { savedLoc: w, inReadingList: inList };
      }
      return out;
    }
    case 'SET': {
      let big = false;
      for (const [id, wc] of Object.entries(m.data)) {
        const prev = e.getWork(Number(id));
        if (e.setWork(Number(id), wc)) big ||= !prev || wc.location === null || wc.number !== prev.number;
      }
      scheduleSync(big ? 0.2 : 2);
      return null;
    }
    case 'FILTER':
      return e.filters().match(m.workid, m.authors, m.tags, m.series);
    case 'URLS_IN_LIST':
      return Object.fromEntries(m.urls.map((u) => [u, e.inReadingList(u)]));
    case 'RL_TOGGLE': {
      const inList = e.inReadingList(m.url);
      if (inList) e.removeFromReadingList(m.url); else e.addToReadingList(m.url);
      scheduleSync(0.1);
      return { inList: !inList, key: readingListKey(m.url) };
    }
    case 'SETTINGS':
      return settings;
    case 'SAVE_SETTINGS':
      settings = m.settings;
      await chrome.storage.local.set({ settings });
      return true;
    case 'STATUS':
      return {
        status: e.status, username: e.state.auth?.username ?? null, server: e.state.serverUrl,
        lastSyncAt: e.state.lastSyncAt, lastSyncError: e.state.lastSyncError,
        works: Object.keys(e.state.works).length, readingList: Object.keys(e.state.readingList.paths).length,
        filters: Object.keys(e.state.listFilters.filters),
      };
    case 'DO_SYNC':
      return e.sync();
    case 'LOGIN': {
      const r = await e.signIn(m.server, m.username, m.password, m.create, m.email);
      if ('ok' in r) await e.sync();
      return r;
    }
    case 'LOGOUT':
      e.signOut();
      return true;
    case 'REMOVE_FILTER':
      e.removeFilter(m.filter);
      scheduleSync(0.1);
      return true;
  }
}

chrome.runtime.onMessage.addListener((m: Msg, _sender, reply) => {
  handle(m).then(reply, (err) => reply({ error: String(err?.message ?? err) }));
  return true; // async response
});
