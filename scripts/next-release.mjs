#!/usr/bin/env node
// What a merge to main publishes (docs/OPERATIONS.md, Publishing): a full release when a release PR raised the package
// version past the newest release, else an edge build of the next patch, numbered after the last edge build of it.
// Run with no arguments in a checkout with its tags, it prints `version=`, `tag=` and `channel=` lines for
// $GITHUB_OUTPUT.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const RELEASE = /^(\d+)\.(\d+)\.(\d+)$/;
const EDGE = /^v(\d+\.\d+\.\d+)-edge\.(\d+)$/;

function parts(version) {
  const match = RELEASE.exec(version);
  return match ? match.slice(1, 4).map(Number) : undefined;
}

function compare(a, b) {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/** The release a merge publishes, from the package version and the repository's tags. */
export function nextRelease(packageVersion, tags) {
  if (!parts(packageVersion)) throw new Error(`${packageVersion} is not a release version (x.y.z)`);
  const released = tags
    .map((tag) => tag.replace(/^v/, ''))
    .filter((version, i) => tags[i].startsWith('v') && parts(version))
    .sort(compare);
  const latest = released.at(-1);
  if (latest === undefined || compare(packageVersion, latest) > 0) {
    return { version: packageVersion, tag: `v${packageVersion}`, channel: 'stable' };
  }
  const [major, minor, patch] = parts(latest);
  const base = `${major}.${minor}.${patch + 1}`;
  const last = Math.max(
    0,
    ...tags.flatMap((tag) => {
      const match = EDGE.exec(tag);
      return match && match[1] === base ? [Number(match[2])] : [];
    }),
  );
  const version = `${base}-edge.${last + 1}`;
  return { version, tag: `v${version}`, channel: 'edge' };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { version } = JSON.parse(readFileSync('apps/crystal/package.json', 'utf8'));
  const tags = execFileSync('git', ['tag', '--list', 'v*'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  const next = nextRelease(version, tags);
  for (const [key, value] of Object.entries(next)) console.log(`${key}=${value}`);
}
