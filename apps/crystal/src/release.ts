import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, posix } from 'node:path';
import { kingdomTarballUrl } from '@crystal-bridge/protocol';

/** The package's start file, inside a release folder. */
export const ENTRY = 'node_modules/@crystal-bridge/kingdom/dist/main.js';
const MANIFEST = 'node_modules/@crystal-bridge/kingdom/package.json';
const MAX_TARBALL = 50 * 1024 * 1024;
const HELD = 'held-version';

/**
 * What this Crystal reports as its release: the version a packaged build carries, else the commit a deploy named its
 * release folder after (releases/<sha>). A checkout reports none.
 */
export function releaseId(version: string | undefined, releaseRoot: string): string | undefined {
  return version ?? /^[0-9a-f]{7,40}$/.exec(basename(releaseRoot))?.[0];
}

/** The folder holding the `node_modules` this package runs from; undefined when running from source. */
export function installRootOf(mainPath: string): string | undefined {
  const marker = '/node_modules/@crystal-bridge/kingdom/';
  mainPath = mainPath.replaceAll('\\', '/');
  const at = mainPath.lastIndexOf(marker);
  return at === -1 ? undefined : mainPath.slice(0, at);
}

/**
 * The folder `join` installed this copy into, or undefined for any install it didn't make. Those belong to whatever
 * made them: npm, a deploy script or a checkout.
 */
export function selfUpdateBase(mainPath: string, platform: NodeJS.Platform): string | undefined {
  const root = installRootOf(mainPath);
  if (!root) return undefined;
  if (platform === 'win32') return posix.basename(root) === 'current' ? posix.dirname(root) : undefined;
  const releases = posix.dirname(root);
  return posix.basename(releases) === 'releases' ? posix.dirname(releases) : undefined;
}

/**
 * Where this process stages a release. A Crystal stopped mid-install can leave an npm running, since a restart stops
 * only Crystal, so each process gets its own folder and that npm can't write into the next one's.
 */
export function stagedDir(base: string): string {
  return join(base, `staged-${process.pid}`);
}

export interface ReleaseDeps {
  base: string;
  platform: NodeJS.Platform;
  nodeBin: string;
  fetch: typeof fetch;
  /** Throws unless this tarball really is this release (`verifyRelease`). */
  verify: (tarball: Uint8Array, version: string) => Promise<void>;
  /** Runs a program without a shell and with no secrets in its environment, and resolves with its output. */
  exec: (file: string, args: string[], cwd?: string) => Promise<string>;
}

/** npm's own script through node: on Windows `npm` is a `.cmd`, which can't be started without a shell. */
function npmCommand({ platform, nodeBin }: ReleaseDeps): [string, string[]] {
  if (platform !== 'win32') return ['npm', []];
  return [nodeBin, [join(dirname(nodeBin), 'node_modules', 'npm', 'bin', 'npm-cli.js')]];
}

/**
 * Downloads a release, checks it, installs it in `staged` beside the running one and runs it far enough to load every
 * module it needs. Nothing the running Kingdom uses changes, so any failure here just leaves it as it was.
 */
export async function stageRelease(version: string, deps: ReleaseDeps): Promise<void> {
  const { base } = deps;
  const staged = stagedDir(base);
  const download = `${staged}.tgz`;
  for (const name of readdirSync(base)) {
    if (name.startsWith('staged-')) rmSync(join(base, name), { recursive: true, force: true });
  }
  const response = await deps.fetch(kingdomTarballUrl(version), { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`release ${version} could not be downloaded: status ${response.status}`);
  const tarball = new Uint8Array(await response.arrayBuffer());
  if (tarball.length > MAX_TARBALL) throw new Error(`release ${version} is larger than a Kingdom package can be`);
  await deps.verify(tarball, version);

  try {
    mkdirSync(staged, { recursive: true });
    writeFileSync(join(staged, 'package.json'), '{"private":true}\n');
    writeFileSync(download, tarball);
    const [npm, npmArgs] = npmCommand(deps);
    const install = ['install', '--no-audit', '--no-fund', '--omit=dev', '--ignore-scripts', download];
    await deps.exec(npm, [...npmArgs, ...install], staged);
    const said = (await deps.exec(deps.nodeBin, [join(staged, ENTRY), '--version'], base)).trim();
    if (said !== version) throw new Error(`release ${version} says it is ${said}`);
  } catch (error) {
    rmSync(staged, { recursive: true, force: true });
    throw error;
  } finally {
    rmSync(download, { force: true });
  }
}

/** Points a link somewhere in one step, so it's never missing. */
function pointAt(link: string, target: string): void {
  const next = `${link}.next`;
  rmSync(next, { force: true });
  symlinkSync(target, next);
  renameSync(next, link);
}

/** Makes the staged release the one the next start runs, keeping the running one for rollback. */
export function activateRelease(
  version: string,
  { base, platform }: Pick<ReleaseDeps, 'base' | 'platform'>,
  remove: (path: string) => void = (path) => rmSync(path, { recursive: true, force: true }),
): void {
  const staged = stagedDir(base);
  if (platform === 'win32') {
    // Windows won't rename a folder a running program was loaded from, so `crystal.cmd` does it between runs.
    const next = join(base, 'next');
    rmSync(next, { recursive: true, force: true });
    renameSync(staged, next);
    return;
  }
  const release = join(base, 'releases', version);
  const running = readlinkSync(join(base, 'current'));
  rmSync(release, { recursive: true, force: true });
  renameSync(staged, release);
  pointAt(join(base, 'previous'), running);
  pointAt(join(base, 'current'), release);
  // The swap has happened, so this is only tidying: it must not read as a failed update, or a retry would undo it.
  const keep = new Set([version, basename(running)]);
  for (const name of readdirSync(join(base, 'releases'))) {
    try {
      if (!keep.has(name)) remove(join(base, 'releases', name));
    } catch {
      // Left for the next update.
    }
  }
}

/** The version of the release in a folder. */
function versionIn(root: string): string {
  return (JSON.parse(readFileSync(join(root, MANIFEST), 'utf8')) as { version: string }).version;
}

/**
 * Goes back to the release kept by the last update, and holds the one it left: the hub still names that one, and it
 * would otherwise come straight back. Returns the version going back to. The next start runs it.
 */
export function rollbackRelease({ base, platform }: Pick<ReleaseDeps, 'base' | 'platform'>): string {
  const current = join(base, 'current');
  const previous = join(base, 'previous');
  if (!existsSync(previous)) throw new Error('There is no earlier release here to go back to.');
  const leaving = versionIn(current);
  const target = versionIn(previous);
  if (platform === 'win32') {
    rmSync(join(base, 'next'), { recursive: true, force: true });
    renameSync(previous, join(base, 'next'));
  } else {
    const running = readlinkSync(current);
    pointAt(current, readlinkSync(previous));
    pointAt(previous, running);
  }
  writeFileSync(join(base, HELD), [...new Set([...heldVersions(base), leaving])].join('\n') + '\n');
  return target;
}

/** The versions `rollback` left. */
export function heldVersions(base: string): string[] {
  const file = join(base, HELD);
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
}
