import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const here = import.meta.dirname;
const out = resolve(here, 'dist');
const root = resolve(here, '../..');
await rm(out, { recursive: true, force: true });
await mkdir(resolve(out, 'ui'), { recursive: true });

const workspace = {
  name: 'workspace',
  setup(b) {
    b.onResolve({ filter: /^@ao3track\// }, (a) => {
      const [, pkg, sub] = a.path.match(/^@ao3track\/([^/]+)(?:\/(.+))?$/);
      return { path: resolve(root, 'packages', pkg, 'src', sub ? `${sub}.ts` : 'index.ts') };
    });
  },
};
const common = { bundle: true, sourcemap: 'linked', target: 'chrome140', plugins: [workspace], logLevel: 'warning', legalComments: 'none' };

await Promise.all([
  // Main process: Node, CommonJS (Electron's default), everything bundled (cheerio included).
  build({ ...common, entryPoints: ['src/main/main.ts'], outfile: 'dist/main.cjs', platform: 'node', format: 'cjs', external: ['electron'], target: 'node22', absWorkingDir: here }),
  // Preloads are sandboxed: a single file that may only require('electron').
  build({ ...common, entryPoints: ['src/preload/page.ts'], outfile: 'dist/preload-page.js', platform: 'browser', format: 'cjs', external: ['electron'], absWorkingDir: here, minify: true }),
  build({ ...common, entryPoints: ['src/preload/ui.ts'], outfile: 'dist/preload-ui.js', platform: 'browser', format: 'cjs', external: ['electron'], absWorkingDir: here }),
  build({ ...common, entryPoints: ['src/ui/ui.ts'], outfile: 'dist/ui/ui.js', platform: 'browser', format: 'iife', absWorkingDir: here }),
]);
await cp(resolve(here, 'src/ui/index.html'), resolve(out, 'ui/index.html'));
await cp(resolve(here, 'src/ui/ui.css'), resolve(out, 'ui/ui.css'));
await cp(resolve(root, 'packages/content/src/tracker.css'), resolve(out, 'tracker.css'));
await cp(resolve(root, 'assets/icon-512.png'), resolve(out, 'icon.png'));
console.log('built apps/reader/dist');
