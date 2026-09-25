import { build } from 'esbuild';
import { cp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const here = import.meta.dirname;
const out = resolve(here, 'dist/unpacked');
await rm(resolve(here, 'dist'), { recursive: true, force: true });
await mkdir(out, { recursive: true });
await build({
  entryPoints: { background: 'src/background.ts', content: 'src/content.ts', options: 'src/options.ts' },
  absWorkingDir: here, outdir: out, bundle: true, format: 'esm', target: ['chrome120', 'firefox128'],
  minify: true, sourcemap: false, legalComments: 'none',
});
// Content scripts can't be ES modules; esbuild's esm output is fine because it has no imports left,
// but wrap it in an IIFE to keep variables out of the page's isolated world globals.
const content = await readFile(resolve(out, 'content.js'), 'utf8');
await writeFile(resolve(out, 'content.js'), `(()=>{${content}})();`);
await cp(resolve(here, 'src/manifest.json'), resolve(out, 'manifest.json'));
await cp(resolve(here, 'src/options.html'), resolve(out, 'options.html'));
await cp(resolve(here, 'src/options.css'), resolve(out, 'options.css'));
await cp(resolve(here, 'src/icons'), resolve(out, 'icons'), { recursive: true });
await cp(resolve(here, '../../packages/content/src/tracker.css'), resolve(out, 'tracker.css'));
// Name the zip after the manifest version so releases never ship a stale file name.
const { version } = JSON.parse(await readFile(resolve(here, 'src/manifest.json'), 'utf8'));
execFileSync('zip', ['-qr', `../ao3track-extension-${version}.zip`, '.'], { cwd: out });
console.log(`built apps/extension/dist/ao3track-extension-${version}.zip`);
