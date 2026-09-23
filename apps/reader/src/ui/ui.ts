/* The app chrome: toolbar, reading list and settings. Talks to main only via window.ao3. */
import type { ReaderSettings } from '@ao3track/core';
import type { ReadingListItem, RefreshStatus } from '../main/readinglist.ts';
import type { Prefs } from '../main/state.ts';

interface Api {
  platform: string;
  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>;
  on(channel: string, fn: (...args: any[]) => void): () => void;
  layout(r: { x: number; y: number; width: number; height: number }): void;
}
declare global { interface Window { ao3: Api } }
const api = window.ao3;

const $ = <T extends HTMLElement = HTMLElement>(s: string, r: ParentNode = document) => r.querySelector<T>(s)!;
const $$ = <T extends HTMLElement = HTMLElement>(s: string, r: ParentNode = document) => Array.from(r.querySelectorAll<T>(s));
const h = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {}, ...kids: (Node | string | null | false)[]) => {
  const el = document.createElement(tag);
  const { class: cls, ...rest } = props as Record<string, unknown>;
  if (cls) el.className = cls as string;
  Object.assign(el, rest);
  for (const k of kids) if (k) el.append(k);
  return el;
};

// ---------------------------------------------------------------- icons
const ICONS: Record<string, string> = {
  list: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  back: '<path d="M15 18l-6-6 6-6"/>',
  forward: '<path d="M9 18l6-6-6-6"/>',
  reload: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6"/>',
  home: '<path d="M4 11l8-7 8 7v8a1 1 0 0 1-1 1h-4v-6h-6v6H5a1 1 0 0 1-1-1z"/>',
  'chevron-left': '<path d="M11 17l-5-5 5-5M18 17l-5-5 5-5"/>',
  'chevron-right': '<path d="M13 17l5-5-5-5M6 17l5-5-5-5"/>',
  'bookmark-jump': '<path d="M6 4h12v16l-6-4-6 4z"/>',
  star: '<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/>',
  'text-smaller': '<path d="M4 18l4-10 4 10M5.5 14.5h5M15 13h6"/>',
  'text-larger': '<path d="M3 19l5-13 5 13M5 15h6M15 12h6M18 9v6"/>',
  cloud: '<path d="M7 18h10a4 4 0 0 0 .6-8 6 6 0 0 0-11.4 1.6A3.3 3.3 0 0 0 7 18z"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
};
for (const el of $$('[data-icon]')) el.insertAdjacentHTML('afterbegin', `<svg viewBox="0 0 24 24">${ICONS[el.dataset.icon!] ?? ''}</svg>`);

document.documentElement.classList.add(api.platform === 'win32' ? 'win' : api.platform === 'darwin' ? 'mac' : 'linux');
if (api.platform === 'win32') document.documentElement.classList.add('mica');

// ---------------------------------------------------------------- state
let prefs: Prefs;
let settings: ReaderSettings;
let items: ReadingListItem[] = [];
let currentUrl = '';
let currentWorkId: number | null = null;
let signedIn = false;

function toast(text: string) {
  const t = $('#toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout((t as any)._timer);
  (t as any)._timer = setTimeout(() => (t.hidden = true), 2200);
}

// ---------------------------------------------------------------- layout: tell main where the page view goes
const content = $('#content');
new ResizeObserver(() => {
  const r = content.getBoundingClientRect();
  api.layout({ x: r.left, y: r.top, width: r.width, height: r.height });
}).observe(content);

function setPane(open: boolean) {
  document.body.classList.toggle('pane-closed', !open);
  $('#btn-pane').classList.toggle('on', open);
  void api.invoke('ui:prefs', { paneOpen: open });
  // Width animates via CSS; ResizeObserver sends the final bounds.
}
function setSettings(open: boolean) {
  $('#pane-right').hidden = !open;
  $('#btn-settings').classList.toggle('on', open);
}

// ---------------------------------------------------------------- toolbar
const nav = (a: string, arg?: string) => api.invoke('ui:nav', a, arg);
$('#btn-back').onclick = () => nav('back');
$('#btn-fwd').onclick = () => nav('forward');
$('#btn-reload').onclick = () => nav('reload');
$('#btn-home').onclick = () => nav('home');
$('#btn-prev').onclick = () => nav('prev');
$('#btn-next').onclick = () => nav('next');
$('#btn-jump').onclick = () => nav('jump');
$('#btn-rl').onclick = () => api.invoke('ui:toggleReadingList');
$('#btn-font-down').onclick = () => api.invoke('ui:font', -10);
$('#btn-font-up').onclick = () => api.invoke('ui:font', 10);
$('#btn-pane').onclick = () => setPane(document.body.classList.contains('pane-closed'));
$('#btn-settings').onclick = () => setSettings(!!$('#pane-right').hidden);
$('#settings-close').onclick = () => setSettings(false);
$('#btn-sync').onclick = async () => {
  if (!signedIn) { setSettings(true); return; }
  const r = await api.invoke<{ ok: boolean; error?: string }>('ui:syncNow');
  toast(r.ok ? 'Synced' : `Sync failed: ${r.error}`);
};

const urlInput = $<HTMLInputElement>('#url');
$('#address').addEventListener('submit', (e) => { e.preventDefault(); void nav('go', urlInput.value); urlInput.blur(); });
urlInput.addEventListener('focus', () => { urlInput.value = currentUrl; urlInput.select(); });
urlInput.addEventListener('keydown', (e) => { if (e.key === 'Escape') { urlInput.value = currentUrl; urlInput.blur(); } });

function setProgress(state: 'loading' | 'done') {
  const p = $('#progress');
  p.className = 'progress';
  void p.offsetWidth; // restart transition
  p.classList.add(state);
}

let pageTitle = '';
let locationSub = '';
function renderPill() {
  $('#pill-title').textContent = pageTitle || currentUrl.replace(/^https?:\/\/(www\.)?/, '') || 'Archive Track Reader';
  $('#pill-sub').textContent = locationSub;
}

api.on('page', (p: any) => {
  if (p.url !== undefined && p.url !== currentUrl) {
    currentUrl = p.url;
    locationSub = '';
    $('#btn-jump').hidden = true;
    const m = currentUrl.match(/\/works\/(\d+)/);
    currentWorkId = m ? Number(m[1]) : null;
    if (document.activeElement !== urlInput) urlInput.value = currentUrl;
    highlightCurrent();
  }
  if (p.loading === true) { setProgress('loading'); $('#btn-prev').setAttribute('disabled', ''); $('#btn-next').setAttribute('disabled', ''); $('#content-msg').hidden = true; }
  if (p.loading === false) setProgress('done');
  if (p.title !== undefined && !p.pageTitle) pageTitle = pageTitle || String(p.title).replace(/ \| Archive of Our Own$/, '');
  if (p.pageTitle) pageTitle = [p.pageTitle.title, p.pageTitle.chapter && p.pageTitle.chaptername ? `${p.pageTitle.chapter}: ${p.pageTitle.chaptername}` : p.pageTitle.chapter].filter(Boolean).join(' · ');
  if (p.loading === true) pageTitle = '';
  if (p.canGoBack !== undefined) ($('#btn-back') as HTMLButtonElement).disabled = !p.canGoBack;
  if (p.canGoForward !== undefined) ($('#btn-fwd') as HTMLButtonElement).disabled = !p.canGoForward;
  if (p.next !== undefined) ($('#btn-next') as HTMLButtonElement).disabled = !p.next;
  if (p.prev !== undefined) ($('#btn-prev') as HTMLButtonElement).disabled = !p.prev;
  if (p.jump) $('#btn-jump').hidden = false;
  if (p.inReadingList !== undefined) {
    $('#btn-rl').classList.toggle('on', !!p.inReadingList);
    $('#btn-rl').title = p.inReadingList ? 'Remove from reading list (Ctrl+D)' : 'Add to reading list (Ctrl+D)';
  }
  if (p.error) { const m = $('#content-msg'); m.textContent = `Couldn't load the page: ${p.error}`; m.hidden = false; }
  renderPill();
});

api.on('location', (loc: { number: number; location: number | null; percent: number }) => {
  locationSub = `Ch ${loc.number} · ${loc.percent}%`;
  renderPill();
});
api.on('toast', toast);
api.on('theme', (dark: boolean) => { document.documentElement.classList.toggle('dark', dark); document.documentElement.style.colorScheme = dark ? 'dark' : 'light'; });
api.on('focusUrl', () => urlInput.focus());
api.on('togglePane', () => setPane(document.body.classList.contains('pane-closed')));

// ---------------------------------------------------------------- rate limit banner
let bannerTimer: number | undefined;
api.on('rateLimited', (r: { until: number | null; fromBrowsing: boolean }) => {
  if (!r.until) return;
  const b = $('#banner');
  const update = () => {
    const left = r.until! - Date.now();
    if (left <= 0) { b.hidden = true; clearInterval(bannerTimer); return; }
    const mins = Math.ceil(left / 60_000);
    $('#banner-text').textContent = r.fromBrowsing
      ? `AO3 is asking this connection to slow down (“Retry later”). Background updates are paused for about ${mins} min — reload the page after that.`
      : `AO3 asked us to slow down. Reading-list updates will resume in about ${mins} min; browsing is unaffected unless AO3 shows “Retry later”.`;
  };
  b.hidden = false;
  update();
  clearInterval(bannerTimer);
  bannerTimer = window.setInterval(update, 15_000);
});
$('#banner-close').onclick = () => { $('#banner').hidden = true; clearInterval(bannerTimer); };

// ---------------------------------------------------------------- reading list
const search = $<HTMLInputElement>('#rl-search');
search.addEventListener('input', () => renderList());
for (const b of $$('#rl-filter button')) b.onclick = () => { void api.invoke('ui:prefs', { readingListFilter: b.dataset.v }); prefs.readingListFilter = b.dataset.v as Prefs['readingListFilter']; renderList(); };
$<HTMLSelectElement>('#rl-sort').onchange = (e) => { const v = (e.target as HTMLSelectElement).value as Prefs['readingListSort']; prefs.readingListSort = v; void api.invoke('ui:prefs', { readingListSort: v }); renderList(); };
$('#rl-refresh').onclick = () => api.invoke('ui:readingList:refresh');

const parseDate = (s: string | null) => (s ? Date.parse(s) || 0 : 0);

function renderList() {
  if (!prefs) return;
  for (const b of $$('#rl-filter button')) b.classList.toggle('on', b.dataset.v === prefs.readingListFilter);
  $<HTMLSelectElement>('#rl-sort').value = prefs.readingListSort;
  const q = search.value.trim().toLowerCase();
  let list = items.filter((i) => {
    if (prefs.readingListFilter === 'unread' && !(i.unread && i.unread > 0)) return false;
    if (prefs.readingListFilter === 'complete' && !i.complete) return false;
    if (prefs.readingListFilter === 'favourites' && !i.favourite) return false;
    return !q || `${i.title} ${i.authors.join(' ')} ${i.fandoms.join(' ')}`.toLowerCase().includes(q);
  });
  const by: Record<Prefs['readingListSort'], (a: ReadingListItem, b: ReadingListItem) => number> = {
    unread: (a, b) => (b.unread ?? -1) - (a.unread ?? -1) || parseDate(b.updated) - parseDate(a.updated),
    updated: (a, b) => parseDate(b.updated) - parseDate(a.updated),
    added: (a, b) => b.addedAt - a.addedAt,
    title: (a, b) => a.title.localeCompare(b.title),
  };
  list = list.sort((a, b) => Number(b.favourite) - Number(a.favourite) || by[prefs.readingListSort](a, b));

  const total = items.reduce((n, i) => n + (i.kind === 'work' && i.unread ? 1 : 0), 0);
  $('#unread-total').hidden = !total;
  $('#unread-total').textContent = total > 99 ? '99+' : String(total);
  $('#rl-count').textContent = items.length ? String(items.length) : '';

  const ul = $('#rl-list');
  ul.replaceChildren();
  if (!list.length) {
    ul.append(h('li', { class: 'empty' }, items.length ? 'Nothing matches.' : 'Your reading list is empty.\nPress ☆ in the toolbar (or Ctrl+D) on any work, series or tag to add it.'));
    return;
  }
  for (const i of list) ul.append(card(i));
  highlightCurrent();
}

function card(i: ReadingListItem) {
  const pct = i.chaptersPublished ? Math.min(100, (i.chaptersRead / i.chaptersPublished) * 100) : 0;
  const tags: HTMLElement[] = [];
  if (i.kind === 'series') tags.push(h('span', { class: 'tag series' }, `Series${i.seriesWorks ? ` · ${i.seriesWorks} works` : ''}`));
  if (i.kind === 'other') tags.push(h('span', { class: 'tag series' }, 'Listing'));
  if (i.unread) tags.push(h('span', { class: 'tag new' }, `${i.unread} unread`));
  else if (i.kind === 'work' && i.chaptersPublished != null && i.complete) tags.push(h('span', { class: 'tag done' }, 'Finished'));
  else if (i.kind === 'work' && i.unread === 0) tags.push(h('span', { class: 'tag done' }, 'Caught up'));
  if (i.kind === 'work' && i.chaptersPublished != null) {
    const read = Math.min(i.chaptersRead, i.chaptersPublished);
    tags.push(h('span', { class: 'tag', title: `${read} of ${i.chaptersPublished} published chapters read${i.chaptersTotal ? `; ${i.chaptersTotal} planned` : '; total unknown'}` },
      `${read} of ${i.chaptersPublished} read`));
    if (!i.complete) tags.push(h('span', { class: 'tag' }, i.chaptersTotal ? `WIP · ${i.chaptersPublished}/${i.chaptersTotal}` : 'WIP'));
  }
  if (i.missing) tags.push(h('span', { class: 'tag gone', title: 'AO3 did not return this work — it may be deleted, hidden, or restricted to logged-in users.' }, 'Unavailable'));
  if (i.kind === 'work' && i.fetchedAt === null && !i.missing) tags.push(h('span', { class: 'tag' }, 'Checking…'));

  const fav = h('button', { class: `fav${i.favourite ? ' on' : ''}`, title: i.favourite ? 'Unfavourite' : 'Favourite (pins to top)', textContent: i.favourite ? '★' : '☆' });
  fav.onclick = (e) => { e.stopPropagation(); void api.invoke('ui:readingList:favourite', i.key); };

  const actions = h('div', { class: 'actions' });
  const act = (label: string, fn: () => void, cls = '') => { const b = h('button', { class: cls, textContent: label }); b.onclick = (e) => { e.stopPropagation(); fn(); }; actions.append(b); };
  act(i.kind === 'work' && i.chaptersRead ? 'Continue' : 'Open', () => nav('open', i.continueUrl), 'primary');
  if (i.kind === 'work') {
    if (i.unread) act('Mark read', () => api.invoke('ui:readingList:markRead', i.key, true));
    if (i.chaptersRead) act('Mark unread', () => api.invoke('ui:readingList:markRead', i.key, false));
  }
  act('Remove', () => { void api.invoke('ui:readingList:remove', i.key); toast('Removed from reading list'); });

  const el = h('li', { class: 'card', tabIndex: 0, title: i.summary.slice(0, 400) },
    fav,
    h('div', { class: 't' }, i.title),
    h('div', { class: 'by' }, [i.authors.join(', '), i.fandoms.slice(0, 2).join(', ')].filter(Boolean).join(' · ') || (i.kind === 'other' ? i.url.replace(/^https?:\/\/archiveofourown\.org/, '') : i.kind === 'series' ? 'Series' : '')),
    i.kind === 'work' && i.chaptersPublished ? h('div', { class: `bar${pct >= 100 ? ' full' : ''}` }, h('i', { style: `width:${pct}%` } as never)) : null,
    h('div', { class: 'meta' }, ...tags, i.updated ? h('span', { class: 'when' }, i.updated) : null),
    actions,
  );
  (el.querySelector('.bar > i') as HTMLElement | null)?.style.setProperty('width', `${pct}%`);
  el.dataset.key = i.key;
  el.dataset.id = String(i.id ?? '');
  el.onclick = () => nav('open', i.continueUrl);
  el.onkeydown = (e) => { if (e.key === 'Enter') nav('open', i.continueUrl); };
  return el;
}

function highlightCurrent() {
  for (const c of $$('.card')) c.classList.toggle('current', !!currentWorkId && c.dataset.id === String(currentWorkId) && !!c.dataset.key?.includes('/works/'));
}

api.on('readingList', (list: ReadingListItem[]) => { items = list; renderList(); });

api.on('refreshStatus', (s: RefreshStatus) => {
  $('#rl-refresh').classList.toggle('spin', s.running);
  const st = $('#rl-status');
  st.classList.remove('warn');
  const paused = s.limiter?.pausedUntil;
  if (paused) {
    st.textContent = `AO3 asked us to wait — resuming at ${new Date(paused).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    st.classList.add('warn');
  } else if (s.running) {
    const q = s.pending || (s.limiter ? s.limiter.queuedHigh + s.limiter.queuedLow : 0);
    st.textContent = `Checking for updates${q ? ` · ${q} to go` : ''}${s.mode === 'tracker' ? ' via tracker' : ''}…`;
  } else if (s.error) {
    st.textContent = s.error;
    st.classList.add('warn');
  } else {
    st.textContent = s.lastRefresh ? `Updated ${new Date(s.lastRefresh).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${s.mode === 'tracker' ? ' via tracker' : ''}` : '';
  }
});

// ---------------------------------------------------------------- settings
const convOpts: [string, string][] = [['0', 'Off'], ['2', 'US → Metric'], ['1', 'Metric → US']];
for (const s of $$<HTMLSelectElement>('select[data-k]')) for (const [v, t] of convOpts) s.add(new Option(t, v));
const getK = (o: any, p: string) => p.split('.').reduce((a, k) => a?.[k], o);
const setK = (o: any, p: string, v: unknown) => { const ks = p.split('.'); const last = ks.pop()!; ks.reduce((a, k) => a[k], o)[last] = v; };
for (const el of $$<HTMLInputElement | HTMLSelectElement>('[data-k]')) {
  el.addEventListener('change', () => {
    const v = el instanceof HTMLInputElement && el.type === 'checkbox' ? el.checked : Number(el.value);
    setK(settings, el.dataset.k!, v);
    void api.invoke('ui:settings', settings);
  });
}
for (const b of $$('#theme button')) b.onclick = () => api.invoke('ui:prefs', { theme: b.dataset.v });
const font = $<HTMLInputElement>('#font-size');
font.oninput = () => { $('#font-val').textContent = `${font.value}%`; };
font.onchange = () => api.invoke('ui:prefs', { fontSize: Number(font.value) });
const trackerUrl = $<HTMLInputElement>('#tracker-url');
trackerUrl.onchange = () => api.invoke('ui:prefs', { trackerUrl: trackerUrl.value.trim() });
const trackerKey = $<HTMLInputElement>('#tracker-key');
trackerKey.onchange = () => api.invoke('ui:prefs', { trackerKey: trackerKey.value.trim() });
$('#tracker-test').onclick = async () => {
  const out = $('#tracker-out');
  out.className = 'small'; out.textContent = 'Checking…';
  const r = await api.invoke<{ ok: boolean; error?: string; status?: any }>('ui:testTracker', trackerUrl.value.trim(), trackerKey.value.trim());
  if (r.ok) {
    const l = r.status.limiter;
    out.className = 'small ok';
    out.textContent = `Connected · ${r.status.cache.works} works cached${l.pausedUntil ? ` · paused by AO3 until ${new Date(l.pausedUntil).toLocaleTimeString()}` : ''}${r.status.refresher.enabled ? ` · refreshes every ${r.status.refresher.intervalHours}h` : ''}`;
    void api.invoke('ui:prefs', { trackerUrl: trackerUrl.value.trim(), trackerKey: trackerKey.value.trim() });
  } else { out.className = 'small bad'; out.textContent = `Couldn't reach the tracker: ${r.error}`; }
};
$<HTMLSelectElement>('#refresh-hours').onchange = (e) => api.invoke('ui:prefs', { refreshHours: Number((e.target as HTMLSelectElement).value) });

async function busy<T>(btn: HTMLButtonElement, label: string, fn: () => Promise<T>): Promise<T> {
  const old = btn.textContent; btn.disabled = true; btn.textContent = label;
  try { return await fn(); } finally { btn.disabled = false; btn.textContent = old; }
}

$('#acct-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.currentTarget as HTMLFormElement;
  const fd = new FormData(f);
  const r = await busy($('button[type=submit]', f) as HTMLButtonElement, 'Signing in…', () => api.invoke<{ ok?: boolean; errors?: Record<string, string> }>('ui:signIn', {
    server: String(fd.get('server')), username: String(fd.get('username')), password: String(fd.get('password')), create: fd.get('create') === 'on',
  }));
  $('#acct-err').textContent = r.errors ? Object.values(r.errors).join(' ') : '';
  if (r.ok) { f.reset(); toast('Signed in — syncing'); }
});
$('#acct-out').onclick = () => api.invoke('ui:signOut');
$('#acct-sync').onclick = (e) => busy(e.currentTarget as HTMLButtonElement, 'Syncing…', () => api.invoke('ui:syncNow'));

$('#migrate-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.currentTarget as HTMLFormElement;
  const fd = new FormData(f);
  const out = $('#migrate-out');
  out.className = 'small'; out.textContent = '';
  const r = await busy($('button[type=submit]', f) as HTMLButtonElement, 'Contacting the original service…', () => api.invoke<any>('ui:migrate', Object.fromEntries(fd)));
  if (r.ok) {
    out.className = 'small ok';
    out.textContent = `Imported ${r.worksAdded} reading positions, ${r.readingListAdded} reading-list entries and ${r.listFiltersAdded} filters.${signedIn ? ' Syncing to your server now.' : ''}`;
    f.reset();
  } else { out.className = 'small bad'; out.textContent = r.error; }
});

$('#export').onclick = async () => { if (await api.invoke('ui:exportFile')) $('#backup-out').textContent = 'Backup saved.'; };
$('#import').onclick = async () => {
  const r = await api.invoke<any>('ui:importFile');
  if (!r) return;
  $('#backup-out').textContent = r.ok ? `Imported ${r.worksAdded} positions, ${r.readingListAdded} reading-list entries, ${r.listFiltersAdded} filters.` : r.error;
};

function renderSync(s: { status: string; username: string | null; server: string | null; lastSyncAt: number | null; lastSyncError: string | null }) {
  signedIn = !!s.username;
  $('#acct-in').hidden = !signedIn;
  $('#acct-form').hidden = signedIn;
  if (s.username) $('#acct-name').textContent = s.username;
  if (s.server) $('#acct-server').textContent = s.server;
  $('#acct-status').textContent = s.status === 'syncing' ? 'Syncing…' : s.lastSyncError ? `Last sync failed: ${s.lastSyncError}` : s.lastSyncAt ? `Last synced ${new Date(s.lastSyncAt).toLocaleString()}` : '';
  const btn = $('#btn-sync');
  btn.className = `icon sync ${signedIn ? s.status : ''}`;
  btn.title = !signedIn ? 'Sync is off — click to set up' : s.status === 'error' ? `Sync problem: ${s.lastSyncError}` : s.lastSyncAt ? `Synced ${new Date(s.lastSyncAt).toLocaleTimeString()}` : 'Sync';
}
api.on('syncStatus', (s) => renderSync({ ...lastSync, ...s }));
let lastSync: any = {};

api.on('state', (st: { sync: any; settings: ReaderSettings; prefs: Prefs; filters: string[] }) => {
  const first = !prefs;
  prefs = st.prefs;
  settings = st.settings;
  lastSync = st.sync;
  renderSync(st.sync);
  for (const el of $$<HTMLInputElement | HTMLSelectElement>('[data-k]')) {
    const v = getK(settings, el.dataset.k!);
    if (el instanceof HTMLInputElement && el.type === 'checkbox') el.checked = !!v; else el.value = String(v);
  }
  for (const b of $$('#theme button')) b.classList.toggle('on', b.dataset.v === prefs.theme);
  font.value = String(prefs.fontSize);
  $('#font-val').textContent = `${prefs.fontSize}%`;
  if (document.activeElement !== trackerUrl) trackerUrl.value = prefs.trackerUrl;
  if (document.activeElement !== trackerKey) trackerKey.value = prefs.trackerKey ?? '';
  $<HTMLSelectElement>('#refresh-hours').value = String(prefs.refreshHours);
  const ul = $('#filters');
  ul.replaceChildren();
  if (!st.filters.length) ul.append(h('li', { class: 'none' }, 'None yet.'));
  for (const f of st.filters) {
    const x = h('button', { textContent: '✕', title: 'Stop hiding' });
    x.onclick = () => api.invoke('ui:removeFilter', f);
    ul.append(h('li', {}, f, x));
  }
  if (first) {
    document.body.classList.toggle('pane-closed', !prefs.paneOpen);
    $('#btn-pane').classList.toggle('on', prefs.paneOpen);
    if (!signedIn && !localStorage.getItem('welcomed')) { setSettings(true); localStorage.setItem('welcomed', '1'); }
  }
  renderList();
});

void api.invoke<string>('ui:version').then((v) => ($('#version').textContent = v));
