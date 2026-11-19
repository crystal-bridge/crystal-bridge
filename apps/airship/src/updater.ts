import { spawn, spawnSync } from 'node:child_process';
import {
  closeSync,
  constants,
  cpSync,
  fstatSync,
  openSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { isOlderVersion, ReleaseVersion, releaseTarballUrl } from '@crystal-bridge/protocol';
import { verifyRelease, whyFailed } from '@crystal-bridge/release';

/**
 * The hub's updater (docs/OPERATIONS.md, Updating the hub from the app). The hub runs as its own user and can't write
 * the code it runs, so it only names the release it wants, in a file in its data folder. This runs as a separate
 * service when that file changes: it checks the release's provenance itself, only ever moves forward, installs it beside
 * the running one, swaps, restarts the hub, and goes back if the new hub doesn't come up. A hub that was taken over can
 * ask for no more than a genuine, newer release, as with a Kingdom.
 */

/** Where an update stands, written for the hub to show in the Ship's Log. */
export interface UpdateStatus {
  version: string;
  state: 'installing' | 'restarting' | 'done' | 'failed';
  /** The release it moved from, once it has. */
  from?: string;
  reason?: string;
  at: number;
}

export interface UpdaterSteps {
  /** What the hub asked for, if anything. */
  wanted: () => { version: unknown } | undefined;
  /** The release running now. */
  current: () => string | undefined;
  download: (version: string) => Promise<Uint8Array>;
  /** Throws unless the tarball is the hub's package for that version, attested by this project's release workflow. */
  verify: (tarball: Uint8Array, version: string) => Promise<void>;
  /** Installs it beside the running release; nothing that runs changes yet. */
  install: (version: string, tarball: Uint8Array) => Promise<void>;
  /** Throws unless the installed release starts and says it's that version. */
  loads: (version: string) => Promise<void>;
  /** Makes a release the one the hub's service runs. */
  activate: (version: string) => void;
  restart: () => Promise<void>;
  /** Whether the hub answers as this release, after a restart. */
  healthy: (version: string) => Promise<boolean>;
  /** Removes old releases, keeping the running one and the one before it. */
  prune: () => void;
  report: (status: UpdateStatus) => void;
  now?: () => number;
}

export async function applyUpdate(steps: UpdaterSteps): Promise<void> {
  const now = steps.now ?? Date.now;
  const asked = steps.wanted();
  if (!asked) return;
  const parsed = ReleaseVersion.safeParse(asked.version);
  const version = parsed.success ? parsed.data : String(asked.version).slice(0, 64);
  const fail = (reason: string) => steps.report({ version, state: 'failed', reason, at: now() });
  if (!parsed.success) return fail(`${version} is not a release version`);
  const from = steps.current();
  // Asked again for what runs (a restart, a repeated press): nothing to do, and how the last one went stays.
  if (from === version) return;
  // Only forward, as a Kingdom: going back is a local act (`rollback` in docs/OPERATIONS.md).
  if (!from || !isOlderVersion(from, version)) return fail(`${version} is not newer than ${from ?? 'this hub'}`);

  steps.report({ version, state: 'installing', at: now() });
  try {
    const tarball = await steps.download(version);
    await steps.verify(tarball, version);
    await steps.install(version, tarball);
    await steps.loads(version);
  } catch (error) {
    return fail(whyFailed(error));
  }

  steps.report({ version, state: 'restarting', from, at: now() });
  let why: string;
  try {
    steps.activate(version);
    await steps.restart();
    if (await steps.healthy(version)) {
      steps.prune();
      steps.report({ version, state: 'done', from, at: now() });
      return;
    }
    why = `${version} did not come up`;
  } catch (error) {
    why = whyFailed(error);
  }
  // Back to what ran, and look: a release that migrated the database may leave the old one unable to start.
  let back = false;
  try {
    steps.activate(from);
    await steps.restart();
    back = await steps.healthy(from);
  } catch {
    // Said below.
  }
  fail(back ? `${why}, so the hub is back on ${from}` : `${why}, and ${from} did not answer either: check the host`);
}

const KEEP_RELEASES = 3;
const HEALTH_WAIT_MS = 60_000;

/** Runs a command, rejecting with the end of what it wrote when it fails. */
function run(command: string, args: string[], options: Parameters<typeof spawn>[2] = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve(out.trim()) : reject(new Error(`${basename(command)} failed: ${out.trim().slice(-500)}`)),
    );
  });
}

/** A user's numeric ids, for running the new release as the hub's own user. */
function idsOf(user: string): { uid: number; gid: number } {
  const id = (flag: string) => Number(spawnSync('id', [flag, user], { encoding: 'utf8' }).stdout.trim());
  const ids = { uid: id('-u'), gid: id('-g') };
  if (!Number.isInteger(ids.uid) || !Number.isInteger(ids.gid)) throw new Error(`no user ${user}`);
  return ids;
}

export interface SystemOptions {
  /** The file the hub writes the wanted version to. */
  requestPath: string;
  /**
   * Where the updater writes how it's going, for the hub to read: in a folder only root may write
   * (`StateDirectory=airship-update`), never the hub's own, where a link the hub planted would steer root's writes.
   */
  statusPath: string;
  /** Where releases live, with `current` pointing at the running one (`deploy-airship-package.sh`'s layout). */
  root: string;
  /** The hub's port, to see that it came back. */
  port: number;
  /** The hub's user, which a new release is first run as. */
  user: string;
  /** The hub's service. */
  service: string;
}

/** The most a request may hold: one version, and when. */
const MAX_REQUEST_BYTES = 4096;

/**
 * The hub's request, read as root from a folder the hub's user owns: only a small, plain file, never through a link (to
 * a file only root may read) or from a pipe (which would hold the updater).
 */
export function readRequest(path: string): { version: unknown } | undefined {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : { version: 'unreadable request' };
  }
  try {
    const stat = fstatSync(fd);
    // One link only: a hard link could bring in a file only root may read.
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_REQUEST_BYTES) return { version: 'unreadable request' };
    return JSON.parse(readFileSync(fd, 'utf8')) as { version: unknown };
  } catch {
    return { version: 'unreadable request' };
  } finally {
    closeSync(fd);
  }
}

/** The steps on a real host: systemd, npm and the release layout `deploy-airship-package.sh` sets up. */
export function systemSteps(options: SystemOptions): UpdaterSteps {
  const { requestPath, statusPath, root, port, user, service } = options;
  const releases = join(root, 'releases');
  const current = join(root, 'current');
  const releaseDir = (version: string) => join(releases, version);
  const staging = (version: string) => join(releases, `.installing-${version}`);
  return {
    wanted: () => readRequest(requestPath),
    current: () => (existsSync(current) ? basename(realpathSync(current)) : undefined),
    download: async (version) => {
      const response = await fetch(releaseTarballUrl('airship', version), { signal: AbortSignal.timeout(120_000) });
      if (!response.ok)
        throw new Error(`release ${version} could not be downloaded: GitHub answered ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    },
    verify: (tarball, version) =>
      verifyRelease(
        tarball,
        version,
        {
          fetch,
          trustedRoot: async () =>
            (await import('@sigstore/tuf')).getTrustedRoot({ cachePath: join(root, '.tuf-cache') }),
        },
        'airship',
      ),
    install: async (version, tarball) => {
      const dir = staging(version);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `crystal-bridge-airship-${version}.tgz`);
      writeFileSync(file, tarball);
      writeFileSync(join(dir, 'package.json'), '{"private":true}\n');
      // As deploy-airship-package.sh installs it: better-sqlite3 needs its install step for its prebuilt binary.
      await run(
        'npm',
        ['install', '--omit=dev', '--no-audit', '--no-fund', '--cache', join(root, '.npm-cache'), file],
        {
          cwd: dir,
        },
      );
      rmSync(file);
      // The backup hook ships with the deploy, not the package: carry it over.
      const hook = join(current, 'push-backups.sh');
      if (existsSync(hook)) cpSync(hook, join(dir, 'push-backups.sh'));
      rmSync(releaseDir(version), { recursive: true, force: true });
      renameSync(dir, releaseDir(version));
    },
    loads: async (version) => {
      const said = await run(join(releaseDir(version), 'node_modules/.bin/crystal-bridge-airship'), ['--version'], {
        ...idsOf(user),
        cwd: '/',
      });
      if (said !== version) throw new Error(`release ${version} says it is ${said || 'nothing'}`);
    },
    activate: (version) => {
      // A new link renamed over the old one, so the service never sees no `current`.
      const link = join(root, `.current-${process.pid}`);
      rmSync(link, { force: true });
      symlinkSync(releaseDir(version), link);
      renameSync(link, current);
    },
    restart: async () => {
      await run('systemctl', ['restart', service]);
    },
    healthy: async (version) => {
      const deadline = Date.now() + HEALTH_WAIT_MS;
      while (Date.now() < deadline) {
        // As deploy-airship-package.sh checks: up, and saying it runs the new release.
        const ok = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(3000) })
          .then(
            async (response) => response.ok && ((await response.json()) as { release?: unknown }).release === version,
          )
          .catch(() => false);
        if (ok) return true;
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      return false;
    },
    prune: () => {
      const running = realpathSync(current);
      const old = readdirSync(releases)
        .filter((name) => !name.startsWith('.'))
        .map((name) => join(releases, name))
        // Both sides resolved, so a linked folder on the way (macOS's /var) can't hide the running release.
        .filter((dir) => realpathSync(dir) !== running)
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
      for (const dir of old.slice(KEEP_RELEASES - 1)) rmSync(dir, { recursive: true, force: true });
    },
    report: (status) => {
      const temp = `${statusPath}.${process.pid}.tmp`;
      writeFileSync(temp, `${JSON.stringify(status)}\n`, { mode: 0o644 });
      renameSync(temp, statusPath);
    },
  };
}
