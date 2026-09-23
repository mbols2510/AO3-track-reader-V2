// Bundle a service (and every dependency) into dist/server.js + dist/cli.js.
import { build } from 'esbuild';
import { cp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const name = process.argv[2];
const root = resolve(import.meta.dirname, '..', 'services', name);
await rm(resolve(root, 'dist'), { recursive: true, force: true });
await build({
  entryPoints: [resolve(root, 'src/server.ts'), ...(existsSync(resolve(root, 'src/cli.ts')) ? [resolve(root, 'src/cli.ts')] : [])],
  outdir: resolve(root, 'dist'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  // Self-contained: the Docker image then needs no node_modules at all.
  // node:sqlite etc. are builtins and stay external automatically.
  plugins: [{
    name: 'workspace-inline',
    setup(b) {
      b.onResolve({ filter: /^@ao3track\// }, (a) => {
        const [, pkg, sub] = a.path.match(/^@ao3track\/([^/]+)(?:\/(.+))?$/);
        const file = sub ? `${sub}.ts` : 'index.ts';
        return { path: resolve(import.meta.dirname, '..', 'packages', pkg, 'src', file) };
      });
    },
  }],
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});
if (existsSync(resolve(root, 'src/web'))) await cp(resolve(root, 'src/web'), resolve(root, 'dist/web'), { recursive: true });
console.log(`built services/${name}/dist`);
