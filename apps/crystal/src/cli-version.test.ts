import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_CLI_UPDATE_REASON } from '@crystal-bridge/protocol';
import { describe, expect, it, vi } from 'vitest';
import { cachedCliVersion, execCliUpdate, parseCliVersion } from './cli-version.js';

describe('parseCliVersion', () => {
  it('takes the version from what the CLI prints', () => {
    expect(parseCliVersion('2.1.314 (Claude Code)\n')).toBe('2.1.314');
  });

  it('is nothing for anything else', () => {
    expect(parseCliVersion('command not found')).toBeUndefined();
  });
});

describe('cachedCliVersion', () => {
  it('asks again when told the answer may have changed', async () => {
    const exec = vi.fn(async () => '2.1.314 (Claude Code)');
    exec.mockResolvedValueOnce('2.1.300 (Claude Code)');
    const version = cachedCliVersion({ exec, now: () => 0, ttlMs: 1000 });
    expect(await version()).toBe('2.1.300');
    expect(await version(true)).toBe('2.1.314');
  });

  it('runs the CLI once within the period, and again after it', async () => {
    let time = 0;
    const exec = vi.fn(async () => '2.1.314 (Claude Code)');
    const version = cachedCliVersion({ exec, now: () => time, ttlMs: 1000 });
    expect(await version()).toBe('2.1.314');
    expect(await version()).toBe('2.1.314');
    expect(exec).toHaveBeenCalledTimes(1);
    time = 1001;
    await version();
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('is nothing when the CLI cannot run', async () => {
    const version = cachedCliVersion({
      exec: async () => {
        throw new Error('ENOENT');
      },
    });
    expect(await version()).toBeUndefined();
  });
});

describe('execCliUpdate', () => {
  const script = (body: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'cb-cli-update-'));
    const bin = join(dir, 'fake-cli');
    writeFileSync(bin, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return bin;
  };

  it('runs the CLI-s own update command and nothing else', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cb-cli-update-'));
    const seen = join(dir, 'args');
    await execCliUpdate(script(`echo "$@" > ${seen}`), process.env)();
    expect(readFileSync(seen, 'utf8').trim()).toBe('update');
  });

  it('does not hang on a command that asks for input', async () => {
    await expect(execCliUpdate(script('read answer; exit 0'), process.env)()).resolves.toBeUndefined();
  });

  it('fails with the last of what the command said', async () => {
    const run = execCliUpdate(script('echo starting; echo "no permission to write" >&2; exit 1'), process.env);
    await expect(run()).rejects.toThrow('no permission to write');
  });

  it('keeps a long failure short enough for the frame that carries it', async () => {
    const run = execCliUpdate(
      script('i=0; while [ $i -lt 400 ]; do echo "line $i of a long failure"; i=$((i+1)); done; exit 1'),
      process.env,
    );
    const failure = await run().then(
      () => '',
      (error: Error) => error.message,
    );
    expect(failure.length).toBeLessThanOrEqual(MAX_CLI_UPDATE_REASON);
    expect(failure).toContain('line 399');
  });

  it('gives up on a command that never ends', async () => {
    const run = execCliUpdate(script('exec sleep 30'), process.env, 50);
    await expect(run()).rejects.toThrow(/did not finish/);
  });
});
