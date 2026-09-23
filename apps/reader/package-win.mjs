// Package the Windows app folder (win32-x64). Runs on Linux/macOS too: resource editing is pure JS.
import { packager } from '@electron/packager';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

const here = import.meta.dirname;
const pkg = JSON.parse(readFileSync(resolve(here, 'package.json'), 'utf8'));
const [appPath] = await packager({
  dir: here,
  name: 'ArchiveTrackReader',
  executableName: 'ArchiveTrackReader',
  platform: 'win32',
  arch: 'x64',
  out: resolve(here, 'out'),
  overwrite: true,
  asar: true,
  prune: false,
  icon: resolve(here, '../../assets/icon.ico'),
  appVersion: pkg.version,
  buildVersion: pkg.version,
  appCopyright: 'Copyright 2017 Alexis Ryan; 2026 Ao3Track contributors. Apache-2.0.',
  win32metadata: { CompanyName: 'Ao3Track', FileDescription: 'Archive Track Reader', ProductName: 'Archive Track Reader', InternalName: 'ArchiveTrackReader' },
  // Only ship the built app, not sources or dev tooling.
  ignore: (p) => p !== '' && !/^\/(dist(\/|$)|package\.json$)/.test(p) || /\.map$/.test(p),
});
console.log(appPath);
