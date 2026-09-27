import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installScript, installScriptArgs } from '../apps/reader/src/main/installscript.ts';

const o = {
  msiPath: "C:\\Users\\O'Brien\\AppData\\Local\\Temp\\ArchiveTrackReader-2.2.1-x64.msi",
  pid: 4242,
  exePath: 'C:\\Program Files\\Archive Track Reader\\ArchiveTrackReader.exe',
  logPath: "C:\\Users\\O'Brien\\AppData\\Local\\Temp\\ArchiveTrackReader-update.log",
};

test('update helper waits for every reader process before installing, then reopens it (#10)', () => {
  const lines = installScript(o).split('\n');
  const at = (re: RegExp) => lines.findIndex((l) => re.test(l));
  const waitPid = at(/^Wait-Process -Id 4242\b/);
  const waitAll = at(/^Get-Process -Name 'ArchiveTrackReader' \| Wait-Process/);
  const install = at(/msiexec\.exe/);
  const reopen = at(/Start-Process -FilePath 'C:\\Program Files\\Archive Track Reader\\ArchiveTrackReader\.exe'/);
  assert.ok(waitPid >= 0 && waitAll > waitPid && install > waitAll && reopen > install, installScript(o));
  assert.match(lines[install], /-Wait\b/, 'reopen only after the installer has finished');
  assert.match(lines[install], /'\/passive', '\/norestart'/);
});

test('update helper quotes paths with spaces and apostrophes safely', () => {
  const s = installScript(o);
  assert.ok(s.includes(`'"C:\\Users\\O''Brien\\AppData\\Local\\Temp\\ArchiveTrackReader-2.2.1-x64.msi"'`), s);
  const args = installScriptArgs(o);
  const enc = args[args.indexOf('-EncodedCommand') + 1];
  assert.equal(Buffer.from(enc, 'base64').toString('utf16le'), s);
});
