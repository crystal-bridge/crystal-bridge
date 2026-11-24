import type { LibraryEntry, LibraryTome } from '@crystal-bridge/protocol';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LibraryChangedFrame } from '../hub.js';
import { recentTomes } from '../library.js';
import { w } from '../theme/words.js';
import { LibraryRoom } from './LibraryRoom.js';

const NODE = 'laptop';
const VERSION = { size: 3, mtimeMs: 1, hash: 'a'.repeat(64) };
const ENTRIES: LibraryEntry[] = [
  { path: 'Home.md', kind: 'md', mtimeMs: 1 },
  { path: 'ops', kind: 'folder' },
  { path: 'ops/Backups.md', kind: 'md', mtimeMs: 3 },
  { path: 'ops/Summons.md', kind: 'md', mtimeMs: 2 },
  { path: 'sketches', kind: 'folder' },
  { path: 'sketches/curve.html', kind: 'html', mtimeMs: 4 },
  { path: 'sketches/flow.png', kind: 'image', mtimeMs: 5 },
];
const SUMMONS = '# Summons\n\nSee [[Backups]] and [[Nowhere]].\n\n## The path\n\nText.\n\n## Retry\n\nMore.';

const tome = (path: string, content: string, more: Partial<LibraryTome> = {}): LibraryTome => ({
  path,
  kind: path.endsWith('.html') ? 'html' : 'md',
  content,
  encoding: 'utf8',
  truncated: false,
  version: VERSION,
  ...more,
});

type Answer = { status: number; body: unknown };
const ok = (body: unknown): Answer => ({ status: 200, body });

/** The hub as fetch sees it: the listing, each Tome and its backlinks, all changeable mid-test. */
function library() {
  const state = {
    listing: ok({ entries: ENTRIES }) as Answer,
    tomes: new Map<string, Answer>([
      ['ops/Summons.md', ok({ tome: tome('ops/Summons.md', SUMMONS) })],
      ['ops/Backups.md', ok({ tome: tome('ops/Backups.md', '# Backups\n\nNightly.') })],
      ['Home.md', ok({ tome: tome('Home.md', '# Home') })],
      ['sketches/curve.html', ok({ tome: tome('sketches/curve.html', '<p>hi</p>') })],
    ]),
    backlinks: ok({ backlinks: [{ path: 'Home.md', line: 'Start at [[Summons]].' }] }) as Answer,
    reads: [] as string[],
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const parsed = new URL(url, 'http://hub');
      const path = parsed.searchParams.get('path') ?? '';
      let answer: Answer;
      if (parsed.pathname.endsWith('/library')) answer = state.listing;
      else if (parsed.pathname.endsWith('/library/tome')) {
        state.reads.push(path);
        answer = state.tomes.get(path) ?? { status: 404, body: { error: 'not in the Library' } };
      } else if (parsed.pathname.endsWith('/library/backlinks')) answer = state.backlinks;
      else answer = { status: 404, body: { error: 'no route' } };
      return new Response(JSON.stringify(answer.body), {
        status: answer.status,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return state;
}

function fakeHub() {
  const listeners = new Set<(frame: LibraryChangedFrame) => void>();
  return {
    hub: {
      onLibraryChanged: (listener: (frame: LibraryChangedFrame) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      watchLibrary: vi.fn(() => () => {}),
      onReconnect: () => () => {},
    },
    changed: (paths: string[]) =>
      act(() => listeners.forEach((listener) => listener({ kind: 'library-changed', node: NODE, paths }))),
  };
}

interface Options {
  path?: string;
  online?: boolean;
  dir?: string;
}

/** The room as App holds it: the path lives in the route, which `onPath` changes. */
function open({ path, online = true, dir = '/home/me/library' }: Options = {}) {
  const { hub, changed } = fakeHub();
  const onPath = vi.fn();
  let setOnline: (online: boolean) => void = () => {};
  function Harness() {
    const [at, setAt] = useState<string | undefined>(path);
    const [up, setUp] = useState(online);
    setOnline = setUp;
    return (
      <LibraryRoom
        hub={hub}
        node={NODE}
        kingdom={NODE}
        online={up}
        dir={dir}
        path={at}
        onPath={(next) => {
          onPath(next);
          setAt(next);
        }}
      />
    );
  }
  const view = render(<Harness />);
  return { ...view, hub, changed, onPath, goOffline: () => act(() => setOnline(false)) };
}

function phone(wide: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: wide,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })),
  );
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the Library room (#290)', () => {
  it('has quick-open, Recent and the tree on the left, the Tome in the middle, the outline and backlinks on the right', async () => {
    library();
    const { hub } = open({ path: 'ops/Summons.md' });
    expect(await screen.findByRole('heading', { level: 1, name: 'Summons' })).toBeTruthy();
    expect(hub.watchLibrary).toHaveBeenCalledWith(NODE);

    const left = screen.getByRole('complementary', { name: w('tomes') });
    expect(within(left).getByRole('combobox', { name: `Find a ${w('tome')}` })).toBeTruthy();
    expect(within(left).getByRole('region', { name: 'Recent' })).toBeTruthy();
    const tree = within(left).getByRole('tree');
    expect(within(tree).getByRole('treeitem', { name: /ops/ })).toBeTruthy();
    // An HTML Tome is marked; an image is listed.
    expect(within(tree).getByRole('treeitem', { name: /curve/ }).textContent).toContain('html');
    expect(within(tree).getByRole('treeitem', { name: /flow\.png/ })).toBeTruthy();

    const crumbs = screen.getByRole('navigation', { name: 'Path' });
    expect(crumbs.textContent).toMatch(/ops.*Summons\.md/);
    expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeTruthy();

    const outline = screen.getByRole('region', { name: 'Outline' });
    expect(
      within(outline)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Summons', 'The path', 'Retry']);
    const linked = screen.getByRole('region', { name: /Linked from/ });
    expect(await within(linked).findByText('Home')).toBeTruthy();

    // The header names the Library, its folder and how many Tomes it holds.
    expect(screen.getByText('/home/me/library')).toBeTruthy();
    expect(screen.getByText(`4 ${w('tomes')}`)).toBeTruthy();
    expect(recentTomes(NODE)).toEqual(['ops/Summons.md']);
  });

  it('opens a Tome from the tree, from a wiki link and from quick-open, through the route', async () => {
    const hub = library();
    const { onPath } = open({ path: 'ops/Summons.md' });
    await screen.findByRole('heading', { level: 1, name: 'Summons' });
    fireEvent.click(screen.getByRole('button', { name: 'Backups' }));
    expect(onPath).toHaveBeenLastCalledWith('ops/Backups.md');
    expect(await screen.findByRole('heading', { level: 1, name: 'Backups' })).toBeTruthy();

    fireEvent.click(screen.getByRole('treeitem', { name: /Home/ }));
    expect(onPath).toHaveBeenLastCalledWith('Home.md');
    await screen.findByRole('heading', { level: 1, name: 'Home' });

    const find = screen.getByRole('combobox', { name: `Find a ${w('tome')}` });
    fireEvent.change(find, { target: { value: 'back' } });
    fireEvent.keyDown(find, { key: 'Enter' });
    expect(onPath).toHaveBeenLastCalledWith('ops/Backups.md');
    expect(hub.reads).toContain('Home.md');
    // Most recent first.
    await waitFor(() => expect(recentTomes(NODE).slice(0, 2)).toEqual(['ops/Backups.md', 'Home.md']));
  });

  it('collapses a folder, and Ctrl+K focuses quick-open', async () => {
    library();
    open({ path: 'ops/Summons.md' });
    await screen.findByRole('heading', { level: 1, name: 'Summons' });
    const folder = screen.getByRole('treeitem', { name: /^ops/ });
    expect(folder.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(within(folder).getAllByRole('button')[0]!);
    expect(screen.getByRole('treeitem', { name: /^ops/ }).getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('treeitem', { name: /Backups/ })).toBeNull();

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(document.activeElement).toBe(screen.getByRole('combobox', { name: `Find a ${w('tome')}` }));
  });

  it('scrolls to a heading from the outline', async () => {
    library();
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    open({ path: 'ops/Summons.md' });
    await screen.findByRole('heading', { level: 1, name: 'Summons' });
    fireEvent.click(within(screen.getByRole('region', { name: 'Outline' })).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(scroll).toHaveBeenCalled());
    expect((scroll.mock.contexts.at(-1) as HTMLElement).id).toBe('tome-retry');
  });

  it('copies a link to the Tome: the app address with its route', async () => {
    library();
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    open({ path: 'ops/Summons.md' });
    await screen.findByRole('heading', { level: 1, name: 'Summons' });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Copy link' })));
    expect(writeText).toHaveBeenCalledWith(
      `${window.location.origin}${window.location.pathname}#/k/laptop/l/ops/Summons.md`,
    );
  });

  it('opens the editor in place, and New Tome in the open folder', async () => {
    library();
    open({ path: 'ops/Summons.md' });
    await screen.findByRole('heading', { level: 1, name: 'Summons' });
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByRole('textbox')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await screen.findByRole('heading', { level: 1, name: 'Summons' });

    fireEvent.click(screen.getByRole('button', { name: `New ${w('tome')}` }));
    fireEvent.change(screen.getByRole('textbox', { name: /Name/ }), { target: { value: 'Restore' } });
    expect(screen.getByText('ops/Restore.md')).toBeTruthy();
  });

  it('offers a missing wiki link as a New Tome in the linking Tome-s folder', async () => {
    library();
    open({ path: 'ops/Summons.md' });
    await screen.findByRole('heading', { level: 1, name: 'Summons' });
    fireEvent.click(screen.getByRole('button', { name: /Nowhere/ }));
    expect((screen.getByRole('textbox', { name: /Name/ }) as HTMLInputElement).value).toBe('Nowhere');
    expect(screen.getByText('ops/Nowhere.md')).toBeTruthy();
  });

  it('shows an HTML Tome in its sandbox, without Edit', async () => {
    library();
    open({ path: 'sketches/curve.html' });
    await waitFor(() => expect(document.querySelector('iframe')).not.toBeNull());
    const frame = document.querySelector('iframe')!;
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  });

  describe('states', () => {
    it('Empty: names the folder, how to point it elsewhere, and offers New Tome', async () => {
      const hub = library();
      hub.listing = ok({ entries: [] });
      open({ dir: '/home/me/.crystal-bridge/library' });
      const card = (await screen.findByText(`The ${w('library')} is still empty`)).parentElement!;
      expect(within(card).getByText('/home/me/.crystal-bridge/library')).toBeTruthy();
      expect(within(card).getByText('CRYSTAL_LIBRARY_DIR')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: `New ${w('tome')}` }));
      expect(screen.getByRole('textbox', { name: /Name/ })).toBeTruthy();
    });

    it('Unreadable: says why', async () => {
      const hub = library();
      hub.listing = { status: 409, body: { error: 'the Library folder is gone' } };
      open();
      expect(await screen.findByText(/the Library folder is gone/)).toBeTruthy();
      expect(screen.getByText(`The ${w('library')} can't be read`)).toBeTruthy();
    });

    it('Offline: says the Library is closed, and keeps an open Tome read-only under the banner', async () => {
      const hub = library();
      const { goOffline } = open({ path: 'ops/Summons.md' });
      await screen.findByRole('heading', { level: 1, name: 'Summons' });
      hub.listing = { status: 404, body: { error: 'that Kingdom is offline' } };
      goOffline();
      expect(screen.getByText('The Library is closed: laptop is offline.')).toBeTruthy();
      expect(screen.getByRole('heading', { level: 1, name: 'Summons' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
      expect(screen.queryByRole('button', { name: `New ${w('tome')}` })).toBeNull();
    });

    it('Offline with nothing open: the closed card', async () => {
      const hub = library();
      hub.listing = { status: 404, body: { error: 'that Kingdom is offline' } };
      open({ online: false });
      expect(await screen.findByText('The Library is closed: laptop is offline.')).toBeTruthy();
    });

    it('Removed: a Tome deleted while open stays on screen, marked gone', async () => {
      const hub = library();
      const { changed } = open({ path: 'ops/Summons.md' });
      await screen.findByRole('heading', { level: 1, name: 'Summons' });
      hub.tomes.delete('ops/Summons.md');
      await changed(['ops/Summons.md']);
      expect(await screen.findByText(`This ${w('tome')} is gone from the ${w('library')}.`)).toBeTruthy();
      expect(screen.getByRole('heading', { level: 1, name: 'Summons' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    });

    it('re-reads the open Tome when it changes on disk', async () => {
      const hub = library();
      const { changed } = open({ path: 'ops/Summons.md' });
      await screen.findByRole('heading', { level: 1, name: 'Summons' });
      hub.tomes.set('ops/Summons.md', ok({ tome: tome('ops/Summons.md', '# Summoned') }));
      await changed(['ops/Summons.md']);
      expect(await screen.findByRole('heading', { level: 1, name: 'Summoned' })).toBeTruthy();
    });
  });

  describe('on a phone', () => {
    beforeEach(() => phone(false));

    it('is read-only: no Edit, no New Tome, no offer to write a missing Tome; the tree is in a drawer', async () => {
      library();
      open({ path: 'ops/Summons.md' });
      await screen.findByRole('heading', { level: 1, name: 'Summons' });
      expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
      expect(screen.queryByRole('button', { name: `New ${w('tome')}` })).toBeNull();
      expect(screen.queryByRole('button', { name: /Nowhere/ })).toBeNull();
      expect(document.querySelector('[data-missing="Nowhere"]')!.tagName).toBe('SPAN');
      // Outline and backlinks come after the Tome.
      const heading = screen.getByRole('heading', { level: 1, name: 'Summons' });
      const outline = screen.getByRole('region', { name: 'Outline' });
      expect(heading.compareDocumentPosition(outline) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

      expect(screen.queryByRole('tree')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: `Browse the ${w('library')}` }));
      const drawer = screen.getByRole('dialog', { name: w('library') });
      fireEvent.click(within(drawer).getByRole('treeitem', { name: /Backups/ }));
      expect(await screen.findByRole('heading', { level: 1, name: 'Backups' })).toBeTruthy();
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('offers no New Tome when empty', async () => {
      const hub = library();
      hub.listing = ok({ entries: [] });
      open();
      expect(await screen.findByText(`The ${w('library')} is still empty`)).toBeTruthy();
      expect(screen.queryByRole('button', { name: `New ${w('tome')}` })).toBeNull();
    });
  });
});
