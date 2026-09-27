import { app, dialog, shell, type BaseWindow } from 'electron';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { isNewerVersion as isNewer } from '@ao3track/core';
import type { Prefs } from './state.ts';
import { installScriptArgs } from './installscript.ts';

export interface UpdateInfo { configured: boolean; error?: string | null; version?: string; name?: string; notes?: string; url?: string; files?: { name: string; size: number }[] }
export type CheckResult =
  | { state: 'no-tracker' | 'not-configured' | 'up-to-date' | 'skipped' | 'later' | 'installing' | 'opened' }
  | { state: 'error'; error: string };


/** Plain-text summary of Markdown release notes for the dialog. */
const summary = (md = '') => md.replace(/\r/g, '').split('\n')
  .filter((l) => /^\s*[-*] /.test(l)).slice(0, 6)
  .map((l) => `• ${l.replace(/^\s*[-*] /, '').replace(/\*\*|`|\[([^\]]+)\]\([^)]+\)/g, (_m, t) => t ?? '').replace(/ \(#\d+\)/g, '').split('. ')[0]}`)
  .join('\n');

/**
 * Asks the user's tracker whether a newer reader exists (the tracker can see the private
 * GitHub repo) and offers to install it. Installing downloads the MSI through the tracker
 * and runs it; the MSI upgrades in place and keeps all data.
 */
export async function checkForUpdate(win: BaseWindow, prefs: () => Prefs, save: () => void, opts: { manual: boolean; toast: (t: string) => void }): Promise<CheckResult> {
  const base = prefs().trackerUrl.trim().replace(/\/+$/, '');
  if (!base) return { state: 'no-tracker' };
  const key = prefs().trackerKey.trim();
  const headers: Record<string, string> = key ? { 'X-Api-Key': key } : {};
  let info: UpdateInfo;
  try {
    const r = await fetch(`${base}/api/app-update${opts.manual ? '?force=1' : ''}`, { headers, signal: AbortSignal.timeout(20_000) });
    if (r.status === 404) return { state: 'not-configured' }; // tracker older than 2.2
    if (!r.ok) return { state: 'error', error: `Tracker returned HTTP ${r.status}` };
    info = (await r.json()) as UpdateInfo;
  } catch (e) { return { state: 'error', error: (e as Error).message }; }
  if (!info.configured) return { state: 'not-configured' };
  if (!info.version) return { state: 'error', error: info.error || 'No release found' };
  const current = app.getVersion();
  if (!isNewer(info.version, current)) return { state: 'up-to-date' };
  if (!opts.manual && prefs().skipUpdateVersion === info.version) return { state: 'skipped' };

  const msi = info.files?.find((f) => /\.msi$/i.test(f.name) && /x64/i.test(f.name)) ?? info.files?.find((f) => /\.msi$/i.test(f.name));
  // The MSIX (Store-style) install can't be upgraded by the MSI; send those users to the release page.
  const canInstall = process.platform === 'win32' && !process.windowsStore && !!msi;
  const notes = summary(info.notes);
  const { response } = await dialog.showMessageBox(win as Electron.BaseWindow, {
    type: 'info',
    title: 'Update available',
    message: `Archive Track Reader ${info.version} is available`,
    detail: `You have ${current}.${notes ? `\n\nWhat's new:\n${notes}` : ''}\n\n${canInstall ? 'The reader closes while the update installs and opens again when it has finished. Your reading positions and settings are kept.' : 'Open the release page to download it.'}`,
    buttons: [canInstall ? 'Install now' : 'Open release page', 'Later', 'Skip this version'],
    defaultId: 0, cancelId: 1, noLink: true,
  });
  if (response === 1) return { state: 'later' };
  if (response === 2) { prefs().skipUpdateVersion = info.version; save(); return { state: 'skipped' }; }
  if (!canInstall) { if (info.url) void shell.openExternal(info.url); return { state: 'opened' }; }

  opts.toast(`Downloading ${info.version}…`);
  const file = join(app.getPath('temp'), msi!.name);
  try {
    const r = await fetch(`${base}/api/app-update/download/${encodeURIComponent(msi!.name)}`, { headers });
    if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
    await pipeline(Readable.fromWeb(r.body as import('node:stream/web').ReadableStream), createWriteStream(file));
  } catch (e) {
    await dialog.showMessageBox(win as Electron.BaseWindow, { type: 'error', title: 'Update failed', message: "Couldn't download the update", detail: (e as Error).message });
    return { state: 'error', error: (e as Error).message };
  }
  // A helper waits until the reader has fully exited (a running exe can't be replaced, #10),
  // runs the MSI with a progress bar only, then starts the reader again. The MSI's fixed
  // upgrade code replaces the current version in place.
  const args = installScriptArgs({ msiPath: file, pid: process.pid, exePath: process.execPath, logPath: join(app.getPath('temp'), 'ArchiveTrackReader-update.log') });
  spawn('powershell.exe', args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  setTimeout(() => app.quit(), 500);
  return { state: 'installing' };
}
