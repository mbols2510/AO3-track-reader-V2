// Ao3Track Sync dashboard. Uses the same token auth as the apps, kept in localStorage.
import { listingTitle } from './listing.js';
const $ = (s, r = document) => r.querySelector(s);
const API = new URL('api', location.href.replace(/[^/]*$/, '')).href.replace(/\/$/, '');
const KEY = 'ao3track.dashboard.auth';

let auth = JSON.parse(localStorage.getItem(KEY) || 'null');

const b64 = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
const authHeader = () => (auth ? { Authorization: `Ao3track ${b64(`${auth.username}\n${auth.credential}`)}` } : {});

async function call(method, path, body, isForm = false) {
  const headers = { ...authHeader() };
  if (body !== undefined && !isForm) headers['Content-Type'] = 'application/json';
  const res = await fetch(API + path, { method, headers, body: body === undefined ? undefined : isForm ? body : JSON.stringify(body) });
  if (res.status === 401 || res.status === 403) { signOut(false); throw new Error('Your session expired — sign in again.'); }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw Object.assign(new Error(data?.error || `HTTP ${res.status}`), { data });
  return data;
}

function showErrors(form, errors) {
  form.querySelectorAll('.err').forEach((e) => (e.textContent = errors?.[e.dataset.for] ?? ''));
}
function busy(btn, on, label) {
  if (on) { btn.dataset.label = btn.textContent; btn.textContent = label; btn.disabled = true; }
  else { btn.textContent = btn.dataset.label; btn.disabled = false; }
}
function out(el, text, ok = true) { el.textContent = text; el.className = `out ${ok ? 'ok' : 'bad'}`; }
const fmtCounts = (i) => `${i.worksAdded ?? 0} works added, ${i.worksAdvanced ?? 0} updated, ${i.worksKept ?? 0} already up to date; ${i.readingListAdded ?? 0} reading-list entries and ${i.listFiltersAdded ?? 0} filters added.`;

// ---------- auth views ----------
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
  $('#form-login').hidden = t.dataset.tab !== 'login';
  $('#form-create').hidden = t.dataset.tab !== 'create';
}));

async function authForm(form, path) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    const data = Object.fromEntries(new FormData(form));
    busy(btn, true, 'Working…');
    try {
      const r = await call('POST', path, data);
      if (typeof r === 'string') {
        auth = { username: data.username, credential: r };
        localStorage.setItem(KEY, JSON.stringify(auth));
        form.reset();
        await render();
      } else showErrors(form, r);
    } catch (err) {
      showErrors(form, err.data ?? { password: err.message });
    } finally { busy(btn, false); }
  });
}
authForm($('#form-login'), '/User/Login');
authForm($('#form-create'), '/User/Create');

async function signOut(remote = true) {
  if (remote && auth) await call('POST', '/v2/logout').catch(() => {});
  auth = null;
  localStorage.removeItem(KEY);
  render();
}
$('#logout').addEventListener('click', () => signOut());

// ---------- dashboard ----------
async function refreshStats() {
  const me = await call('GET', '/v2/me');
  $('#s-works').textContent = me.works.toLocaleString();
  $('#s-rl').textContent = me.readingList.toLocaleString();
  $('#s-lf').textContent = me.listFilters.toLocaleString();
  $('#s-last').textContent = me.lastActivity ? new Date(me.lastActivity).toLocaleDateString() : 'Never';
}

let rlItems = [];
async function refreshReadingList() {
  const rl = await call('GET', '/v2/reading-list');
  rlItems = Object.entries(rl).sort((a, b) => b[1] - a[1]).map(([path, ts]) => ({ path, ts, title: /\/(works|series)\/\d+$/.test(path) ? null : listingTitle(path), meta: '' }));
  drawReadingList();
  const ids = rlItems.map((i) => i.path.match(/\/works\/(\d+)$/)?.[1]).filter(Boolean);
  if (!ids.length) return;
  try {
    for (let i = 0; i < ids.length; i += 100) {
      const r = await call('GET', `/v2/works-meta?ids=${ids.slice(i, i + 100).join(',')}`);
      for (const w of r.works ?? []) {
        const item = rlItems.find((x) => x.path.endsWith(`/works/${w.workid}`));
        if (item) { item.title = w.title; item.meta = [w.authors?.join(', '), w.fandoms?.[0], w.chaptersPublished != null ? `${w.chaptersPublished}/${w.chaptersTotal ?? '?'} ch` : ''].filter(Boolean).join(' · '); }
      }
      drawReadingList();
    }
  } catch { /* tracker is optional */ }
}
function drawReadingList() {
  const q = $('#rl-filter').value.trim().toLowerCase();
  const ul = $('#rl');
  ul.replaceChildren();
  const items = rlItems.filter((i) => !q || `${i.title ?? ''} ${i.meta} ${i.path}`.toLowerCase().includes(q));
  if (!items.length) { ul.innerHTML = '<li class="empty">Nothing here yet.</li>'; return; }
  for (const i of items.slice(0, 500)) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = i.path.replace(/^http:/, 'https:');
    a.target = '_blank'; a.rel = 'noopener';
    a.className = 't';
    a.textContent = i.title ?? i.path.replace(/^https?:\/\/archiveofourown\.org/, '');
    const m = document.createElement('div'); m.className = 'm'; m.textContent = i.meta;
    const left = document.createElement('div'); left.append(a, m);
    const when = document.createElement('span'); when.className = 'when'; when.textContent = new Date(i.ts).toLocaleDateString();
    li.append(left, when);
    ul.append(li);
  }
}
$('#rl-filter').addEventListener('input', drawReadingList);

// ---------- works tracked (reading positions) ----------
let works = [];
const selected = new Set();
const SHOW = 500;
async function refreshWorks() {
  let list;
  try {
    list = await call('GET', '/v2/works');
    if (!Array.isArray(list)) throw new Error('The server sent an unexpected answer.');
  } catch (err) {
    // Say so, rather than leaving an empty list next to a non-zero counter.
    const ul = $('#works');
    const li = Object.assign(document.createElement('li'), { className: 'empty error' });
    const retry = Object.assign(document.createElement('button'), { className: 'ghost', textContent: 'Try again' });
    retry.addEventListener('click', () => { li.textContent = 'Loading…'; refreshWorks().catch(() => {}); });
    li.append(`Couldn't load your tracked works: ${err.message} `, retry);
    ul.replaceChildren(li);
    throw err;
  }
  const known = new Map(works.map((w) => [w.id, w]));
  works = list.sort((a, b) => b.timestamp - a.timestamp)
    .map((w) => ({ ...w, title: known.get(w.id)?.title ?? null, meta: known.get(w.id)?.meta ?? '', total: known.get(w.id)?.total }));
  for (const id of [...selected]) if (!works.some((w) => w.id === id)) selected.delete(id);
  drawWorks();
  // Titles come from the tracker's cache (never from AO3 directly); optional.
  const missing = works.filter((w) => w.title === null).map((w) => w.id);
  try {
    for (let i = 0; i < missing.length; i += 300) {
      const r = await call('GET', `/v2/works-meta?ids=${missing.slice(i, i + 300).join(',')}`);
      const byId = new Map((r.works ?? []).map((m) => [m.workid, m]));
      for (const w of works) {
        const m = byId.get(w.id);
        if (m) { w.title = m.title; w.meta = [m.authors?.join(', '), m.fandoms?.[0]].filter(Boolean).join(' · '); w.total = m.chaptersPublished; }
      }
      drawWorks();
    }
  } catch { /* tracker is optional */ }
}
const shownWorks = () => {
  const q = $('#w-filter').value.trim().toLowerCase();
  return works.filter((w) => !q || `${w.title ?? ''} ${w.meta} ${w.id}`.toLowerCase().includes(q));
};
function drawWorks() {
  const ul = $('#works');
  ul.replaceChildren();
  const items = shownWorks();
  $('#w-delete').disabled = !selected.size;
  $('#w-delete').textContent = selected.size ? `Delete selected (${selected.size})` : 'Delete selected';
  $('#w-delete').classList.toggle('danger', !!selected.size);
  const vis = items.slice(0, SHOW);
  $('#w-all').checked = vis.length > 0 && vis.every((w) => selected.has(w.id));
  if (!items.length) { ul.innerHTML = `<li class="empty">${works.length ? 'Nothing matches.' : 'No reading positions yet.'}</li>`; return; }
  for (const w of vis) {
    const li = document.createElement('li');
    const cb = Object.assign(document.createElement('input'), { type: 'checkbox', checked: selected.has(w.id), title: 'Select' });
    cb.addEventListener('change', () => { if (cb.checked) selected.add(w.id); else selected.delete(w.id); drawWorks(); });
    const a = Object.assign(document.createElement('a'), { href: `https://archiveofourown.org/works/${w.id}`, target: '_blank', rel: 'noopener', className: 't', textContent: w.title ?? `Work ${w.id}` });
    const where = w.location === null ? `Finished chapter ${w.number}` : `Chapter ${w.number}`;
    const m = Object.assign(document.createElement('div'), { className: 'm', textContent: [`${where}${w.total ? ` of ${w.total}` : ''}`, w.meta].filter(Boolean).join(' · ') });
    const left = document.createElement('div'); left.append(a, m);
    const when = Object.assign(document.createElement('span'), { className: 'when', textContent: new Date(w.timestamp).toLocaleDateString(), title: 'Last read' });
    const del = Object.assign(document.createElement('button'), { className: 'ghost del', textContent: 'Delete', title: 'Forget this reading position' });
    del.addEventListener('click', () => deleteWorks([w.id]));
    li.append(cb, left, when, del);
    ul.append(li);
  }
  if (items.length > SHOW) ul.insertAdjacentHTML('beforeend', `<li class="more">Showing the ${SHOW} most recently read of ${items.length}. Use the filter to find others.</li>`);
}
async function deleteWorks(ids) {
  const names = ids.length === 1 ? `“${works.find((w) => w.id === ids[0])?.title ?? `Work ${ids[0]}`}”` : `${ids.length} works`;
  if (!confirm(`Forget your reading position in ${names}? This removes it from every device at their next sync.`)) return;
  const o = $('#w-out');
  try {
    const r = await call('POST', '/v2/works/delete', { ids });
    for (const id of ids) selected.delete(id);
    out(o, `Deleted ${r.deleted} ${r.deleted === 1 ? 'position' : 'positions'}.`);
    await Promise.all([refreshStats(), refreshWorks()]);
  } catch (err) { out(o, err.message, false); }
}
$('#w-filter').addEventListener('input', drawWorks);
$('#w-all').addEventListener('change', (e) => {
  for (const w of shownWorks().slice(0, SHOW)) { if (e.target.checked) selected.add(w.id); else selected.delete(w.id); }
  drawWorks();
});
$('#w-delete').addEventListener('click', () => selected.size && deleteWorks([...selected]));

$('#form-migrate').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget, btn = form.querySelector('button[type=submit]');
  const o = $('#migrate-out');
  busy(btn, true, 'Contacting the original service…'); out(o, '');
  try {
    const r = await call('POST', '/v2/migrate', Object.fromEntries(new FormData(form)));
    out(o, `Found ${r.found.works} works, ${r.found.readingList} reading-list entries and ${r.found.listFilters} filters.\n${fmtCounts(r.imported)}`);
    form.reset();
    await Promise.all([refreshStats(), refreshReadingList(), refreshWorks()]);
  } catch (err) { out(o, err.message, false); }
  finally { busy(btn, false); }
});

$('#form-legacydb').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget, btn = form.querySelector('button[type=submit]');
  const o = $('#legacydb-out');
  busy(btn, true, 'Importing…'); out(o, '');
  try {
    const r = await call('POST', '/v2/import-legacy-db', new FormData(form), true);
    out(o, `Found ${r.found.works} works and ${r.found.readingList} reading-list entries.\n${fmtCounts(r.imported)}`);
    form.reset();
    await Promise.all([refreshStats(), refreshReadingList(), refreshWorks()]);
  } catch (err) { out(o, err.message, false); }
  finally { busy(btn, false); }
});

$('#export').addEventListener('click', async () => {
  const data = await call('GET', '/v2/export');
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `ao3track-${auth.username}-${new Date().toISOString().slice(0, 10)}.json` });
  a.click(); URL.revokeObjectURL(a.href);
});
$('#import-file').addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return;
  const o = $('#import-out');
  try {
    const r = await call('POST', '/v2/import', JSON.parse(await f.text()));
    out(o, fmtCounts(r.imported));
    await Promise.all([refreshStats(), refreshReadingList(), refreshWorks()]);
  } catch (err) { out(o, err.message, false); }
  e.target.value = '';
});

$('#form-pw').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget, o = $('#pw-out');
  showErrors(form, {}); out(o, '');
  try {
    const r = await call('POST', '/v2/password', Object.fromEntries(new FormData(form)));
    auth.credential = r.credential; localStorage.setItem(KEY, JSON.stringify(auth));
    form.reset(); out(o, 'Password changed. Other devices have been signed out.');
  } catch (err) { showErrors(form, err.data); }
});

$('#copy-api').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('#api-url').textContent);
  $('#copy-api').textContent = 'Copied'; setTimeout(() => ($('#copy-api').textContent = 'Copy'), 1500);
});

async function render() {
  const info = await call('GET', '/v2/info').catch(() => ({}));
  $('#api-url').textContent = info.apiUrl || API;
  $('#server-line').textContent = new URL(API).host;
  $('#legacy-url').placeholder = info.legacyApiUrl || 'https://wenchy.net/ao3track/api';
  $('#tab-create').hidden = info.allowRegistration === false;
  $('#view-auth').hidden = !!auth;
  $('#view-dash').hidden = !auth;
  $('#who').hidden = !auth;
  if (!auth) return;
  $('#who-name').textContent = auth.username;
  try { await Promise.all([refreshStats(), refreshReadingList(), refreshWorks()]); } catch { /* handled in call() */ }
}
render();
