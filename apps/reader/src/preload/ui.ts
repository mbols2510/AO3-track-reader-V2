// Exposes a small, explicit API to the app UI. Nothing else from Electron/Node is reachable.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

const INVOKE = new Set([
  'ui:nav', 'ui:toggleReadingList', 'ui:font', 'ui:readingList:refresh', 'ui:readingList:remove', 'ui:readingList:favourite',
  'ui:readingList:markRead', 'ui:prefs', 'ui:settings', 'ui:removeFilter', 'ui:signIn', 'ui:signOut', 'ui:syncNow',
  'ui:testTracker', 'ui:migrate', 'ui:exportFile', 'ui:importFile', 'ui:openExternal', 'ui:version', 'ui:checkUpdate', 'ui:groupMenu',
]);
const EVENTS = new Set(['state', 'readingList', 'refreshStatus', 'page', 'location', 'toast', 'theme', 'rateLimited', 'focusUrl', 'togglePane', 'syncStatus', 'renameGroup']);

contextBridge.exposeInMainWorld('ao3', {
  platform: process.platform,
  invoke: (channel: string, ...args: unknown[]) => {
    if (!INVOKE.has(channel)) throw new Error(`blocked channel ${channel}`);
    return ipcRenderer.invoke(channel, ...args);
  },
  on: (channel: string, fn: (...args: unknown[]) => void) => {
    if (!EVENTS.has(channel)) throw new Error(`blocked channel ${channel}`);
    const h = (_e: IpcRendererEvent, ...args: unknown[]) => fn(...args);
    ipcRenderer.on(channel, h);
    return () => ipcRenderer.removeListener(channel, h);
  },
  layout: (r: { x: number; y: number; width: number; height: number }) => ipcRenderer.send('ui:layout', r),
});
