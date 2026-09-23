import { run, type Bridge } from '@ao3track/content';
import type { ReaderSettings, WorkChapter } from '@ao3track/core';
import { send } from './messages.ts';

function toast(text: string) {
  document.getElementById('ao3t-toast')?.remove();
  const t = Object.assign(document.createElement('div'), { id: 'ao3t-toast', textContent: text });
  document.body.append(t);
  setTimeout(() => t.remove(), 2200);
}

(async () => {
  const settings = await send<ReaderSettings>({ type: 'SETTINGS' });
  const fab = Object.assign(document.createElement('div'), { id: 'ao3t-fab' });
  const jumpListeners: Array<() => void> = [];
  let jumpBtn: HTMLButtonElement | null = null;

  const bridge: Bridge = {
    settings,
    getWorkDetails: (works) => send({ type: 'GET_DETAILS', works }),
    setWorkChapters: (data) => void send({ type: 'SET', data }),
    shouldFilterWork: (workid, authors, tags, series) => send({ type: 'FILTER', workid, authors, tags, series }),
    areUrlsInReadingList: (urls) => send({ type: 'URLS_IN_LIST', urls }),
    setNextPage: () => {},
    setPrevPage: () => {},
    enableLastLocationJump: (_workid: number, _loc: WorkChapter) => {
      if (jumpBtn) return;
      jumpBtn = Object.assign(document.createElement('button'), { className: 'primary', textContent: 'Continue reading', title: 'Jump to where you left off' });
      jumpBtn.addEventListener('click', () => jumpListeners.forEach((f) => f()));
      fab.prepend(jumpBtn);
    },
    setCurrentLocation: () => {},
    onJumpRequest: (fn) => jumpListeners.push(fn),
  };
  const api = run(bridge);

  // Reading list toggle for the current work / series / tag page
  const rl = document.createElement('button');
  const url = api.workid ? `https://archiveofourown.org/works/${api.workid}` : location.href;
  const inList = (await send<Record<string, boolean>>({ type: 'URLS_IN_LIST', urls: [url] }))[url];
  rl.textContent = inList ? '✓ In reading list' : '+ Reading list';
  rl.addEventListener('click', async () => {
    const r = await send<{ inList: boolean }>({ type: 'RL_TOGGLE', url });
    rl.textContent = r.inList ? '✓ In reading list' : '+ Reading list';
    toast(r.inList ? 'Added to reading list' : 'Removed from reading list');
  });
  fab.append(rl);
  document.body.append(fab);
})();
