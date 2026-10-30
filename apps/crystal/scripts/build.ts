/**
 * Builds the installable Kingdom package into dist/: one file with the workspace's protocol bundled in, its runtime
 * dependencies left to npm (node-pty has per-platform binaries), and the version written in.
 */
import { copyFileSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = new URL('..', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')) as {
  version: string;
  dependencies: Record<string, string>;
};
const dist = new URL('dist/', root);

rmSync(dist, { recursive: true, force: true });
await build({
  absWorkingDir: fileURLToPath(root),
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: Object.keys(manifest.dependencies),
  banner: { js: '#!/usr/bin/env node' },
  define: { __KINGDOM_VERSION__: JSON.stringify(manifest.version) },
});
copyFileSync(new URL('../../LICENSE', root), new URL('LICENSE', dist));
