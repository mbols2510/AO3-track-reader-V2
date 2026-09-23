import { defaultReaderSettings, normaliseApiBase, type ReaderSettings } from '@ao3track/core';
import { send } from './messages.ts';

interface Status { status: string; username: string | null; server: string | null; lastSyncAt: number | null; lastSyncError: string | null; works: number; readingList: number; filters: string[] }
const $ = <T extends HTMLElement>(s: string) => document.querySelector<T>(s)!;
if (new URLSearchParams(location.search).has('popup')) document.body.classList.add('popup');

async function refresh() {
  const s = await send<Status>({ type: 'STATUS' });
  const signedIn = !!s.username;
  $('#signed-in').hidden = !signedIn;
  $('#login').hidden = signedIn;
  $('#sync').hidden = !signedIn;
  $('#uname').textContent = s.username ?? '';
  $('#server-show').textContent = s.server ?? '';
  $('#counts').textContent = `${s.works} works tracked · ${s.readingList} in reading list`;
  $('#status-line').textContent = !signedIn ? 'Not syncing — tracking on this browser only'
    : s.status === 'syncing' ? 'Syncing…'
    : s.lastSyncError ? `Sync problem: ${s.lastSyncError}`
    : s.lastSyncAt ? `Synced ${new Date(s.lastSyncAt).toLocaleString()}` : 'Signed in';
  const ul = $('#filters');
  ul.replaceChildren();
  if (!s.filters.length) ul.innerHTML = '<li class="empty">No filters yet.</li>';
  for (const f of s.filters.sort()) {
    const li = document.createElement('li');
    const x = Object.assign(document.createElement('button'), { textContent: '✕', title: 'Remove filter' });
    x.onclick = async () => { await send({ type: 'REMOVE_FILTER', filter: f }); refresh(); };
    li.append(f, x);
    ul.append(li);
  }
}

$('#login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.currentTarget as HTMLFormElement);
  const server = normaliseApiBase(String(fd.get('server')));
  // Permission to talk to a self-hosted server must be requested inside the click.
  const origin = new URL(server).origin + '/*';
  const granted = await chrome.permissions.request({ origins: [origin] }).catch(() => false);
  if (!granted) { $('#login-err').textContent = 'The extension needs permission to contact your sync server.'; return; }
  const r = await send<{ ok?: true; errors?: Record<string, string>; error?: string }>({
    type: 'LOGIN', server, username: String(fd.get('username')), password: String(fd.get('password')), create: fd.get('create') === 'on',
  });
  $('#login-err').textContent = r.errors ? Object.values(r.errors).join(' ') : r.error ?? '';
  refresh();
});
$('#logout').addEventListener('click', async () => { await send({ type: 'LOGOUT' }); refresh(); });
$('#sync').addEventListener('click', async () => { $('#status-line').textContent = 'Syncing…'; await send({ type: 'DO_SYNC' }); refresh(); });

// ---- settings form bound by data-k="path.to.key" ----
const conv = [['0', 'Off'], ['2', 'US → Metric'], ['1', 'Metric → US']];
for (const sel of document.querySelectorAll<HTMLSelectElement>('select[data-k]')) for (const [v, t] of conv) sel.add(new Option(t, v));
const get = (o: Record<string, unknown>, p: string) => p.split('.').reduce<unknown>((a, k) => (a as Record<string, unknown>)?.[k], o);
const set = (o: Record<string, unknown>, p: string, v: unknown) => {
  const ks = p.split('.'); const last = ks.pop()!;
  (ks.reduce((a, k) => a[k] as Record<string, unknown>, o))[last] = v;
};
let settings: ReaderSettings = defaultReaderSettings();
send<ReaderSettings>({ type: 'SETTINGS' }).then((s) => {
  settings = s;
  for (const el of document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-k]')) {
    const v = get(settings as never, el.dataset.k!);
    if (el instanceof HTMLInputElement && el.type === 'checkbox') el.checked = !!v; else el.value = String(v);
    el.addEventListener('change', () => {
      const val = el instanceof HTMLInputElement && el.type === 'checkbox' ? el.checked : Number(el.value);
      set(settings as never, el.dataset.k!, val);
      if (el.dataset.k === 'override_site_theme') settings.theme = val ? 'dark' : 'light';
      void send({ type: 'SAVE_SETTINGS', settings });
    });
  }
});
refresh();
