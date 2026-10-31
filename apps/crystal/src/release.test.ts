import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { kingdomTarballUrl } from '@crystal-bridge/protocol';
import {
  ENTRY,
  activateRelease,
  stagedDir,
  heldVersions,
  releaseId,
  rollbackRelease,
  selfUpdateBase,
  stageRelease,
  type ReleaseDeps,
} from './release.js';

const MANIFEST = ENTRY.replace('dist/main.js', 'package.json');
const dirs: string[] = [];
function tempBase(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crystal-release-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** What a real `join` leaves on Unix, with `version` running. */
function installed(base: string, version: string): void {
  const release = join(base, 'releases', version);
  writeRelease(release, version);
  symlinkSync(release, join(base, 'current'));
}

function writeRelease(root: string, version: string): void {
  mkdirSync(join(root, 'node_modules/@crystal-bridge/kingdom/dist'), { recursive: true });
  writeFileSync(join(root, 'node_modules/@crystal-bridge/kingdom/package.json'), JSON.stringify({ version }));
}

function deps(base: string, over: Partial<ReleaseDeps> = {}): ReleaseDeps {
  return {
    base,
    platform: 'linux',
    nodeBin: '/usr/bin/node',
    fetch: vi.fn(async () => new Response('tarball')) as unknown as typeof fetch,
    verify: vi.fn(async () => undefined),
    exec: vi.fn(async (file: string, args: string[], cwd?: string) => {
      if (args.includes('install')) writeRelease(cwd!, '1.1.0');
      return args.includes('--version') ? '1.1.0\n' : '';
    }),
    ...over,
  };
}

describe('releaseId', () => {
  it('is the version a packaged build carries', () => {
    expect(releaseId('0.2.0', '/home/me/.npm/_npx/abc123/node_modules/@crystal-bridge/kingdom')).toBe('0.2.0');
  });

  it('is the commit a deploy named its release folder after', () => {
    expect(releaseId(undefined, '/home/me/.local/share/crystal-bridge/releases/38d1f792cd78')).toBe('38d1f792cd78');
  });

  it('is nothing for a checkout', () => {
    expect(releaseId(undefined, '/home/me/code/crystal-bridge')).toBeUndefined();
  });
});

describe('selfUpdateBase', () => {
  const main = `node_modules/@crystal-bridge/kingdom/dist/main.js`;

  it('finds the folder a join installed into, only where a join installs', () => {
    expect(selfUpdateBase(`/h/.local/share/crystal-bridge/releases/1.0.0/${main}`, 'linux')).toBe(
      '/h/.local/share/crystal-bridge',
    );
    expect(selfUpdateBase(`D:\\me\\AppData\\Local\\crystal-bridge\\current\\${main}`, 'win32')).toBe(
      'D:/me/AppData/Local/crystal-bridge',
    );
  });

  it('leaves alone an install it didn’t make: npx, npm -g, a deploy or a checkout', () => {
    expect(selfUpdateBase(`/h/.npm/_npx/abc/${main}`, 'linux')).toBeUndefined();
    expect(selfUpdateBase(`/usr/lib/${main}`, 'linux')).toBeUndefined();
    expect(selfUpdateBase('/h/code/crystal-bridge/apps/crystal/src/main.ts', 'linux')).toBeUndefined();
    expect(selfUpdateBase(`D:/me/AppData/Roaming/npm/${main}`, 'win32')).toBeUndefined();
  });
});

describe('stageRelease', () => {
  it('downloads from the project’s release, verifies, installs without scripts and runs what it installed', async () => {
    const base = tempBase();
    installed(base, '1.0.0');
    const d = deps(base);
    await stageRelease('1.1.0', d);

    expect(vi.mocked(d.fetch).mock.calls[0]?.[0]).toBe(kingdomTarballUrl('1.1.0'));
    expect(vi.mocked(d.verify).mock.calls[0]?.[1]).toBe('1.1.0');
    const calls = vi.mocked(d.exec).mock.calls;
    expect(calls[0]?.[1]).toEqual(expect.arrayContaining(['install', '--ignore-scripts', '--omit=dev']));
    expect(calls[1]).toEqual(['/usr/bin/node', [join(stagedDir(base), ENTRY), '--version'], base]);
    expect(existsSync(join(stagedDir(base), MANIFEST))).toBe(true);
    expect(readdirSync(base).filter((name) => name.endsWith('.tgz'))).toEqual([]);
  });

  it('installs nothing that fails verification, and leaves the running release alone', async () => {
    const base = tempBase();
    installed(base, '1.0.0');
    const d = deps(base, { verify: vi.fn(async () => Promise.reject(new Error('failed its provenance check'))) });
    await expect(stageRelease('1.1.0', d)).rejects.toThrow('provenance');
    expect(d.exec).not.toHaveBeenCalled();
    expect(existsSync(stagedDir(base))).toBe(false);
    expect(readlinkSync(join(base, 'current'))).toBe(join(base, 'releases/1.0.0'));
  });

  it('refuses a download that failed, or a package that says it’s another version', async () => {
    const base = tempBase();
    installed(base, '1.0.0');
    const missing = vi.fn(async () => new Response('', { status: 404 })) as unknown as typeof fetch;
    await expect(stageRelease('1.1.0', deps(base, { fetch: missing }))).rejects.toThrow('404');

    const wrong = vi.fn(async (_: string, args: string[], cwd?: string) => {
      if (args.includes('install')) writeRelease(cwd!, '1.0.5');
      return '1.0.5\n';
    });
    await expect(stageRelease('1.1.0', deps(base, { exec: wrong }))).rejects.toThrow('1.0.5');
    expect(existsSync(stagedDir(base))).toBe(false);
  });

  it('runs npm through node on Windows, where a .cmd can’t be started directly', async () => {
    const base = tempBase();
    const d = deps(base, { platform: 'win32', nodeBin: 'C:\\node\\node.exe' });
    await stageRelease('1.1.0', d);
    const [file, args] = vi.mocked(d.exec).mock.calls[0]!;
    expect(file).toBe('C:\\node\\node.exe');
    expect(args[0]?.replaceAll('\\', '/')).toMatch(/node_modules\/npm\/bin\/npm-cli\.js$/);
  });
});

const onUnix = it.skipIf(process.platform === 'win32');

describe('activateRelease', () => {
  onUnix('swaps to the new release, keeps the last for rollback and removes any older', async () => {
    const base = tempBase();
    installed(base, '1.0.0');
    writeRelease(join(base, 'releases/0.9.0'), '0.9.0');
    symlinkSync(join(base, 'releases/0.9.0'), join(base, 'previous'));
    const d = deps(base);
    await stageRelease('1.1.0', d);
    activateRelease('1.1.0', d);

    expect(readlinkSync(join(base, 'current'))).toBe(join(base, 'releases/1.1.0'));
    expect(readlinkSync(join(base, 'previous'))).toBe(join(base, 'releases/1.0.0'));
    expect(readdirSync(join(base, 'releases')).sort()).toEqual(['1.0.0', '1.1.0']);
    expect(existsSync(stagedDir(base))).toBe(false);
  });

  it('clears what an earlier process left staged, not just its own', async () => {
    const base = tempBase();
    mkdirSync(join(base, 'staged-1'));
    writeFileSync(join(base, 'staged-1.tgz'), '');
    await stageRelease('1.1.0', deps(base));
    expect(readdirSync(base).filter((name) => name.startsWith('staged'))).toEqual([basename(stagedDir(base))]);
  });

  onUnix('counts as done once swapped, even if an old release can’t be removed', async () => {
    const base = tempBase();
    installed(base, '1.0.0');
    writeRelease(join(base, 'releases/0.9.0'), '0.9.0');
    const d = deps(base);
    await stageRelease('1.1.0', d);
    const refuse = () => {
      throw new Error('busy');
    };
    expect(() => activateRelease('1.1.0', d, refuse)).not.toThrow();
    expect(readlinkSync(join(base, 'current'))).toBe(join(base, 'releases/1.1.0'));
    expect(readlinkSync(join(base, 'previous'))).toBe(join(base, 'releases/1.0.0'));
  });

  it('hands the swap to the start script on Windows: Crystal can’t rename its own folder', async () => {
    const base = tempBase();
    writeRelease(join(base, 'current'), '1.0.0');
    const d = deps(base, { platform: 'win32' });
    await stageRelease('1.1.0', d);
    activateRelease('1.1.0', d);
    expect(existsSync(join(base, 'next', MANIFEST))).toBe(true);
    expect(existsSync(stagedDir(base))).toBe(false);
    expect(lstatSync(join(base, 'current')).isDirectory()).toBe(true);
  });
});

describe('rollbackRelease', () => {
  onUnix('swaps back, and holds the version so the hub can’t push it straight back', async () => {
    const base = tempBase();
    installed(base, '1.0.0');
    const d = deps(base);
    await stageRelease('1.1.0', d);
    activateRelease('1.1.0', d);

    expect(heldVersions(base)).toEqual([]);
    expect(rollbackRelease(d)).toBe('1.0.0');
    expect(readlinkSync(join(base, 'current'))).toBe(join(base, 'releases/1.0.0'));
    expect(readlinkSync(join(base, 'previous'))).toBe(join(base, 'releases/1.1.0'));
    expect(heldVersions(base)).toEqual(['1.1.0']);
  });

  onUnix('keeps holding every release it left, across rollbacks', async () => {
    const base = tempBase();
    installed(base, '1.0.0');
    for (const version of ['1.1.0', '1.2.0']) {
      const exec = vi.fn(async (_: string, args: string[], cwd?: string) => {
        if (args.includes('install')) writeRelease(cwd!, version);
        return args.includes('--version') ? `${version}\n` : '';
      });
      const d = deps(base, { exec });
      await stageRelease(version, d);
      activateRelease(version, d);
      rollbackRelease(d);
    }
    expect(heldVersions(base)).toEqual(['1.1.0', '1.2.0']);
  });

  it('on Windows queues the earlier release for the start script to swap in', () => {
    const base = tempBase();
    writeRelease(join(base, 'current'), '1.1.0');
    writeRelease(join(base, 'previous'), '1.0.0');
    const d = deps(base, { platform: 'win32' });
    expect(rollbackRelease(d)).toBe('1.0.0');
    expect(existsSync(join(base, 'previous'))).toBe(false);
    expect(JSON.parse(readFileSync(join(base, 'next', MANIFEST), 'utf8'))).toEqual({ version: '1.0.0' });
    expect(heldVersions(base)).toEqual(['1.1.0']);
  });

  it('says so when there is nothing to go back to', () => {
    const base = tempBase();
    writeRelease(join(base, 'current'), '1.0.0');
    expect(() => rollbackRelease(deps(base, { platform: 'win32' }))).toThrow(/no earlier release/i);
  });
});
