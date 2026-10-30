/**
 * Builds the installable hub into dist/: one file with the workspace's protocol bundled in, the web app beside it, and
 * the version written into both. Runtime dependencies are left to npm (better-sqlite3 has per-platform binaries).
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = new URL('..', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')) as {
  version: string;
  dependencies: Record<string, string>;
};
const dist = new URL('dist/', root);

execFileSync('pnpm', ['--filter', '@crystal-bridge/web', 'build'], {
  env: { ...process.env, CB_RELEASE: manifest.version },
  stdio: 'inherit',
});
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
  define: { __AIRSHIP_VERSION__: JSON.stringify(manifest.version) },
});
cpSync(new URL('../web/dist', root), new URL('web', dist), { recursive: true });
copyFileSync(new URL('../../LICENSE', root), new URL('LICENSE', dist));
copyFileSync(new URL('../../THIRD_PARTY_NOTICES.md', root), new URL('THIRD_PARTY_NOTICES.md', dist));
