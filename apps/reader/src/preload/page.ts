// Runs in the AO3 page (isolated world, sandboxed). Bridges the shared tracker script to the main process.
import { ipcRenderer } from 'electron';
import { run, type Bridge } from '@ao3track/content';
import type { ReaderSettings } from '@ao3track/core';

const onAo3 = /(^|\.)(archiveofourown|ao3)\.org$/i.test(location.hostname);

function harvest() {
  // Capture metadata *before* the tracker decorates the DOM; the main process parses it,
  // so reading-list entries you browse past refresh without any extra AO3 requests.
  const blurbs = Array.from(document.querySelectorAll('li.blurb.work[id], li.work.blurb[id]'), (li) => li.outerHTML);
  if (blurbs.length) ipcRenderer.send('page:harvest', { kind: 'blurbs', html: `<ol>${blurbs.join('')}</ol>` });
  const m = location.pathname.match(/^(?:\/collections\/[^/]+)?\/works\/(\d+)/);
  const metaDl = document.querySelector('dl.work.meta');
  const preface = document.querySelector('#workskin > .preface');
  if (m && metaDl && preface) {
    ipcRenderer.send('page:harvest', { kind: 'work', workid: Number(m[1]), html: `<div>${metaDl.outerHTML}<div id="workskin">${preface.outerHTML}</div></div>` });
  }
}

function start() {
  const text = document.body?.innerText?.trim() ?? '';
  if (text.length < 300 && /retry later/i.test(text)) {
    ipcRenderer.send('page:rateLimited');
    return;
  }
  const settings = ipcRenderer.sendSync('page:settings') as ReaderSettings;
  harvest();

  let next: string | null = null, prev: string | null = null;
  const sendNav = () => ipcRenderer.send('page:nav', { next, prev });
  const jumpers: Array<() => void> = [];
  ipcRenderer.on('page:jump', () => jumpers.forEach((f) => f()));

  const bridge: Bridge = {
    settings,
    getWorkDetails: (works) => ipcRenderer.invoke('page:getWorkDetails', works),
    setWorkChapters: (data) => ipcRenderer.send('page:setWorkChapters', data),
    shouldFilterWork: (workid, authors, tags, series) => ipcRenderer.invoke('page:shouldFilter', workid, authors, tags, series),
    areUrlsInReadingList: (urls) => ipcRenderer.invoke('page:urlsInList', urls),
    setNextPage: (u) => { next = u; sendNav(); },
    setPrevPage: (u) => { prev = u; sendNav(); },
    enableLastLocationJump: (_w, loc) => ipcRenderer.send('page:jumpAvailable', loc),
    setCurrentLocation: (loc) => {
      const max = document.documentElement.scrollHeight - innerHeight;
      ipcRenderer.send('page:location', { ...loc, percent: max > 0 ? Math.min(100, Math.round((scrollY / max) * 100)) : 100 });
    },
    setPageTitle: (t) => ipcRenderer.send('page:title', t),
    onJumpRequest: (fn) => jumpers.push(fn),
  };
  run(bridge);
}

if (onAo3) {
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}
