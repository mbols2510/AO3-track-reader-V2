// Ao3Track Sync dashboard. Uses the same token auth as the apps, kept in localStorage.
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
  rlItems = Object.entries(rl).sort((a, b) => b[1] - a[1]).map(([path, ts]) => ({ path, ts, title: null, meta: '' }));
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

$('#form-migrate').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget, btn = form.querySelector('button[type=submit]');
  const o = $('#migrate-out');
  busy(btn, true, 'Contacting the original service…'); out(o, '');
  try {
    const r = await call('POST', '/v2/migrate', Object.fromEntries(new FormData(form)));
    out(o, `Found ${r.found.works} works, ${r.found.readingList} reading-list entries and ${r.found.listFilters} filters.\n${fmtCounts(r.imported)}`);
    form.reset();
    await Promise.all([refreshStats(), refreshReadingList()]);
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
    await Promise.all([refreshStats(), refreshReadingList()]);
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
    await Promise.all([refreshStats(), refreshReadingList()]);
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
  try { await Promise.all([refreshStats(), refreshReadingList()]); } catch { /* handled in call() */ }
}
render();
