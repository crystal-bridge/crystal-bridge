import type { LibraryEntry } from '@crystal-bridge/protocol';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HubClient } from './hub.js';
import {
  backlinks,
  LIBRARY_TONE,
  quickOpen,
  readTome,
  recentTomes,
  rememberTome,
  tomeFileUrl,
  tomePageUrl,
  useLibrary,
  writeTome,
} from './library.js';

const file = (path: string, kind: LibraryEntry['kind'] = 'md'): LibraryEntry => ({ path, kind });
const VERSION = { size: 3, mtimeMs: 1, hash: 'a'.repeat(64) };

function fakeHub() {
  const changed = new Set<(frame: { node: string }) => void>();
  const reconnects = new Set<() => void>();
  const watches: [string, boolean][] = [];
  const hub = {
    onLibraryChanged(listener: (frame: { node: string }) => void) {
      changed.add(listener);
      return () => changed.delete(listener);
    },
    onReconnect(listener: () => void) {
      reconnects.add(listener);
      return () => reconnects.delete(listener);
    },
    watchLibrary(node: string) {
      watches.push([node, true]);
      return () => watches.push([node, false]);
    },
  } as unknown as HubClient;
  return {
    hub,
    watches,
    change: (node: string) => changed.forEach((listener) => listener({ node })),
    reconnect: () => reconnects.forEach((listener) => listener()),
  };
}

function reply(body: unknown, status = 200) {
  return { ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

describe('the Library data', () => {
  let fetches: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetches = vi.fn(async () => reply({ entries: [file('a.md')], truncated: false }));
    vi.stubGlobal('fetch', fetches);
    localStorage.clear();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('useLibrary lists, refetches on a change for its node, and watches while mounted', async () => {
    const { hub, watches, change } = fakeHub();
    const { result, unmount } = renderHook(() => useLibrary(hub, 'node-a'));
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.entries).toEqual([file('a.md')]));
    expect(result.current.loading).toBe(false);
    expect(result.current.truncated).toBe(false);
    expect(fetches.mock.calls[0]?.[0]).toBe('/api/nodes/node-a/library');
    expect(watches).toEqual([['node-a', true]]);

    fetches.mockImplementation(async () => reply({ entries: [file('b.md')], truncated: true }));
    act(() => change('other'));
    expect(fetches).toHaveBeenCalledTimes(1);
    act(() => change('node-a'));
    await waitFor(() => expect(result.current.entries).toEqual([file('b.md')]));
    expect(result.current.truncated).toBe(true);

    unmount();
    expect(watches).toEqual([
      ['node-a', true],
      ['node-a', false],
    ]);
  });

  it('useLibrary says when the Kingdom is offline or has no Library', async () => {
    const { hub } = fakeHub();
    fetches.mockImplementation(async () => reply({ error: 'that Kingdom is offline' }, 404));
    const offline = renderHook(() => useLibrary(hub, 'node-a'));
    await waitFor(() => expect(offline.result.current.error).toBe('that Kingdom is offline'));
    expect(offline.result.current.loading).toBe(false);
    fetches.mockImplementation(async () =>
      reply({ error: 'this Kingdom has no Library: it is turned off there' }, 409),
    );
    const none = renderHook(() => useLibrary(hub, 'node-b'));
    await waitFor(() => expect(none.result.current.error).toMatch(/no Library/));
  });

  it('builds the routes, with each path escaped', async () => {
    expect(tomeFileUrl('node-a', 'ops/a b.png')).toBe('/api/nodes/node-a/library/file?path=ops%2Fa%20b.png');
    expect(tomePageUrl('node-a', 'x.html')).toBe('/api/nodes/node-a/library/page?path=x.html');

    fetches.mockImplementation(async () => reply({ tome: { path: 'a.md', content: 'hi' } }));
    expect((await readTome('node-a', 'a.md')).path).toBe('a.md');
    expect(fetches.mock.calls[0]?.[0]).toBe('/api/nodes/node-a/library/tome?path=a.md');

    fetches.mockImplementation(async () => reply({ backlinks: [{ path: 'b.md', line: 'see [[a]]' }] }));
    expect(await backlinks('node-a', 'a.md')).toEqual([{ path: 'b.md', line: 'see [[a]]' }]);
    expect(fetches.mock.calls[1]?.[0]).toBe('/api/nodes/node-a/library/backlinks?path=a.md');
  });

  it('writeTome sends the base and tells a conflict from any other refusal', async () => {
    fetches.mockImplementation(async () => reply({ version: VERSION }));
    expect(await writeTome('node-a', 'a.md', 'hi', null)).toEqual({ saved: true, version: VERSION });
    const [url, init] = fetches.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/nodes/node-a/library/tome');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({ path: 'a.md', content: 'hi', base: null });

    const newer = { ...VERSION, hash: 'b'.repeat(64) };
    fetches.mockImplementation(async () => reply({ error: 'changed', version: newer }, 409));
    expect(await writeTome('node-a', 'a.md', 'hi', VERSION)).toEqual({ saved: false, conflict: newer });

    fetches.mockImplementation(async () => reply({ error: 'the Kingdom did not answer in time' }, 409));
    await expect(writeTome('node-a', 'a.md', 'hi', VERSION)).rejects.toThrow('did not answer');
  });

  it('quickOpen ranks prefix, then word start, then substring, files only, stably', () => {
    const entries = [
      file('docs', 'folder'),
      file('notes/resummon.md'),
      file('ops/How Summons.md'),
      file('ops/summary.md'),
      file('summit.html', 'html'),
      file('docs/summons/readme.md'),
      file('logo.png', 'image'),
    ];
    expect(quickOpen(entries, 'summ').map((e) => e.path)).toEqual([
      'ops/summary.md',
      'summit.html',
      'ops/How Summons.md',
      'notes/resummon.md',
    ]);
    expect(quickOpen(entries, 'SUMM')).toHaveLength(4);
    expect(quickOpen(entries, '')).toEqual([]);
    expect(quickOpen(entries, 'zzz')).toEqual([]);
  });

  it('recentTomes keeps ten per Kingdom, most recent first', () => {
    expect(recentTomes('node-a')).toEqual([]);
    for (let i = 0; i < 12; i++) rememberTome('node-a', `t${i}.md`);
    rememberTome('node-a', 't5.md');
    rememberTome('node-b', 'other.md');
    const recent = recentTomes('node-a');
    expect(recent).toHaveLength(10);
    expect(recent[0]).toBe('t5.md');
    expect(recent.filter((p) => p === 't5.md')).toHaveLength(1);
    expect(recentTomes('node-b')).toEqual(['other.md']);
    expect(localStorage.getItem('crystal-bridge.library-recent.node-b')).toBeTruthy();
  });

  it('has a purple tone, written out whole', () => {
    expect(Object.values(LIBRARY_TONE).join(' ')).toMatch(/purple|violet/);
  });
});
