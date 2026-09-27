/**
 * The small PowerShell helper that installs an update for "Install now" (#10).
 *
 * The installer must not start while any reader process is still running: Windows can't
 * replace a running exe, so it postpones the swap and the reader is left without one.
 * The helper waits for this process and every other ArchiveTrackReader process (Electron's
 * renderer and GPU helpers share the exe) to exit, runs the MSI, then starts the reader again.
 */
export interface InstallScriptOptions {
  msiPath: string;
  pid: number;
  exePath: string;
  logPath: string;
}

/** Quote for a single-quoted PowerShell string. */
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

export function installScript(o: InstallScriptOptions): string {
  const name = o.exePath.split(/[\\/]/).pop()!.replace(/\.exe$/i, '');
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `Wait-Process -Id ${Math.trunc(o.pid)} -Timeout 60`,
    `Get-Process -Name ${q(name)} | Wait-Process -Timeout 30`,
    `$p = Start-Process -FilePath 'msiexec.exe' -ArgumentList @('/i', ${q(`"${o.msiPath}"`)}, '/passive', '/norestart', '/l*v', ${q(`"${o.logPath}"`)}) -Wait -PassThru`,
    // Reopen the reader whether the update succeeded or was cancelled (the old version is still there then).
    `if (Test-Path -LiteralPath ${q(o.exePath)}) { Start-Process -FilePath ${q(o.exePath)} }`,
  ].join('\n');
}

/** Arguments for powershell.exe; -EncodedCommand avoids every quoting problem with paths. */
export function installScriptArgs(o: InstallScriptOptions): string[] {
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
    '-EncodedCommand', Buffer.from(installScript(o), 'utf16le').toString('base64')];
}
