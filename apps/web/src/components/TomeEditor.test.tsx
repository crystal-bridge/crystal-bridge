import type { LibraryTome, TomeVersion } from '@crystal-bridge/protocol';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LibraryChangedFrame } from '../hub.js';
import { NewTome, TomeEditor } from './TomeEditor.js';
import { TomeReader } from './TomeReader.js';

const NODE = 'laptop';
const PATH = 'ops/Backups.md';
const DRAFT_KEY = `crystal-bridge.draft.tome:${NODE}:${PATH}`;
const v = (n: number): TomeVersion => ({ size: n, mtimeMs: n, hash: String(n % 10).repeat(64) });
const V1 = v(1);
const V2 = v(2);
const V3 = v(3);

const tome = (content: string, more: Partial<LibraryTome> = {}): LibraryTome => ({
  path: PATH,
  kind: 'md',
  content,
  encoding: 'utf8',
  truncated: false,
  version: V1,
  ...more,
});

type Answer = { status: number; body: unknown };
const json = ({ status, body }: Answer) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** The hub as fetch sees it: each PUT and GET answered from its queue, in order, with every call kept. */
function hubFetch() {
  const puts: Answer[] = [];
  const gets: Answer[] = [];
  const calls: { method: string; url: string; body?: { path: string; content: string; base: TomeVersion | null } }[] =
    [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({
      method,
      url,
      ...(init?.body ? { body: JSON.parse(String(init.body)) as (typeof calls)[number]['body'] } : {}),
    });
    const answer = (method === 'PUT' ? puts : gets).shift();
    if (!answer) throw new Error(`no answer queued for ${method} ${url}`);
    return json(answer);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { puts, gets, calls, writes: () => calls.filter((one) => one.method === 'PUT') };
}

function fakeHub() {
  const listeners = new Set<(frame: LibraryChangedFrame) => void>();
  return {
    hub: {
      onLibraryChanged: (listener: (frame: LibraryChangedFrame) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      watchLibrary: () => () => {},
    },
    changed: (paths: string[]) =>
      act(() => listeners.forEach((listener) => listener({ kind: 'library-changed', node: NODE, paths }))),
  };
}

function edit(content: string, more: Partial<LibraryTome> = {}) {
  const { hub, changed } = fakeHub();
  const onSaved = vi.fn();
  const onClose = vi.fn();
  const view = render(
    <TomeEditor
      hub={hub}
      node={NODE}
      path={PATH}
      tome={tome(content, more)}
      paths={[PATH]}
      onSaved={onSaved}
      onClose={onClose}
    />,
  );
  return { ...view, onSaved, onClose, changed };
}

const box = () => screen.getByRole('textbox', { name: /Markdown/ }) as HTMLTextAreaElement;
const type = (text: string) => fireEvent.change(box(), { target: { value: text } });
const save = () => fireEvent.click(screen.getByRole('button', { name: /^Save/ }));
const banner = () => screen.getByRole('alert', { name: /Changed on disk/ });

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the Tome editor', () => {
  it('shows the text in a labelled box beside a live preview, with Write, Split and Preview', () => {
    edit('# Backups\n\nNightly.\n');
    expect(box().value).toBe('# Backups\n\nNightly.\n');
    expect(screen.getByRole('heading', { level: 1, name: 'Backups' })).toBeTruthy();
    type('# Restores\n');
    expect(screen.getByRole('heading', { level: 1, name: 'Restores' })).toBeTruthy();
    expect(screen.getByText('unsaved')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'Restores' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Write' }));
    expect(box()).toBeTruthy();
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Split' }));
    expect(box()).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 })).toBeTruthy();
  });

  it('numbers the lines beside the text', () => {
    const { container } = edit('one\ntwo\nthree');
    expect(container.querySelector('[data-gutter]')!.textContent).toBe('123');
  });

  it('on a narrow screen offers Write and Preview as tabs, without Split', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    edit('# Backups\n');
    expect(screen.queryByRole('button', { name: 'Split' })).toBeNull();
    expect(box()).toBeTruthy();
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'Backups' })).toBeTruthy();
  });

  it('saves with PUT naming the version it was edited from', async () => {
    const hub = hubFetch();
    hub.puts.push({ status: 200, body: { version: V2 } });
    const { onSaved } = edit('# Backups\n');
    type('# Backups\n\nNightly.\n');
    save();
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(V2));
    expect(hub.writes()[0]).toEqual({
      method: 'PUT',
      url: `/api/nodes/${NODE}/library/tome`,
      body: { path: PATH, content: '# Backups\n\nNightly.\n', base: V1 },
    });
    expect(screen.queryByText('unsaved')).toBeNull();
  });

  it('saves on Ctrl+S and Cmd+S', async () => {
    const hub = hubFetch();
    hub.puts.push({ status: 200, body: { version: V2 } }, { status: 200, body: { version: V3 } });
    const { onSaved } = edit('a\n');
    type('b\n');
    fireEvent.keyDown(box(), { key: 's', ctrlKey: true });
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(V2));
    type('c\n');
    fireEvent.keyDown(box(), { key: 's', metaKey: true });
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(V3));
    expect(hub.writes()[1]!.body!.base).toEqual(V2);
  });

  it('shows a refusal from the hub in plain words, in place', async () => {
    const hub = hubFetch();
    hub.puts.push({ status: 409, body: { error: 'too large to edit here' } });
    edit('a\n');
    type('b\n');
    save();
    expect((await screen.findByRole('alert')).textContent).toMatch(/too large to edit here/);
    expect(box().value).toBe('b\n');
  });

  it('keeps the line endings of a file written with \\r\\n', async () => {
    const hub = hubFetch();
    hub.puts.push({ status: 200, body: { version: V2 } });
    const { onSaved } = edit('# Backups\r\n\r\nNightly.\r\n');
    expect(box().value).toBe('# Backups\n\nNightly.\n');
    type('# Backups\n\nNightly.\nWeekly.\n');
    save();
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(hub.writes()[0]!.body!.content).toBe('# Backups\r\n\r\nNightly.\r\nWeekly.\r\n');
  });

  it('asks before Cancel drops unsaved text', () => {
    const { onClose } = edit('a\n');
    type('b\n');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Yes, discard/ }));
    expect(onClose).toHaveBeenCalled();
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
  });
});

describe('changed on disk', () => {
  async function conflicted() {
    const hub = hubFetch();
    hub.puts.push({ status: 409, body: { error: 'changed', version: V2 } });
    hub.gets.push({ status: 200, body: { tome: tome('theirs\nshared\n', { version: V2 }) } });
    const view = edit('shared\n');
    type('mine\nshared\n');
    save();
    await screen.findByRole('alert', { name: /Changed on disk/ });
    return { hub, ...view };
  }

  it('a refused save shows the banner, and Show changes diffs the file against the text', async () => {
    await conflicted();
    expect(within(banner()).queryByText(/Quest/)).toBeNull();
    fireEvent.click(within(banner()).getByRole('button', { name: 'Show changes' }));
    const diff = await screen.findByRole('region', { name: /Changes/ });
    await waitFor(() => expect(diff.querySelector('[data-diff="removed"]')?.textContent).toBe('theirs'));
    expect(diff.querySelector('[data-diff="added"]')!.textContent).toBe('mine');
  });

  it('Reload asks first, then drops the edits for the file on disk', async () => {
    await conflicted();
    await waitFor(() => expect(within(banner()).getByRole('button', { name: /Reload/ })).toBeTruthy());
    fireEvent.click(within(banner()).getByRole('button', { name: /Reload/ }));
    expect(box().value).toBe('mine\nshared\n');
    fireEvent.click(screen.getByRole('button', { name: /Yes, reload/ }));
    await waitFor(() => expect(box().value).toBe('theirs\nshared\n'));
    expect(screen.queryByRole('alert', { name: /Changed on disk/ })).toBeNull();
    expect(screen.queryByText('unsaved')).toBeNull();
  });

  it('Keep mine asks first, then reads the current version and saves over it', async () => {
    const { hub, onSaved } = await conflicted();
    hub.gets.push({ status: 200, body: { tome: tome('theirs again\n', { version: V3 }) } });
    hub.puts.push({ status: 200, body: { version: v(4) } });
    fireEvent.click(within(banner()).getByRole('button', { name: 'Keep mine' }));
    expect(hub.writes()).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: /Yes, keep mine/ }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(v(4)));
    expect(hub.writes()[1]!.body).toEqual({ path: PATH, content: 'mine\nshared\n', base: V3 });
    expect(screen.queryByRole('alert', { name: /Changed on disk/ })).toBeNull();
  });

  it('a library-changed for the open Tome shows the banner; one for another file does not', async () => {
    const hub = hubFetch();
    const { changed } = edit('shared\n');
    changed(['ops/Other.md']);
    expect(hub.calls).toHaveLength(0);
    hub.gets.push({ status: 200, body: { tome: tome('theirs\n', { version: V2 }) } });
    changed([PATH]);
    await screen.findByRole('alert', { name: /Changed on disk/ });
    expect(box().value).toBe('shared\n');
  });

  it('a library-changed that finds the version it already has shows nothing', async () => {
    const hub = hubFetch();
    const { changed } = edit('shared\n');
    hub.gets.push({ status: 200, body: { tome: tome('shared\n') } });
    changed([PATH]);
    await waitFor(() => expect(hub.calls).toHaveLength(1));
    await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a file removed while editing keeps the text, and Save asks before making it again', async () => {
    const hub = hubFetch();
    const { changed, onSaved } = edit('shared\n');
    type('mine\n');
    hub.gets.push({ status: 404, body: { error: 'not in the Library' } });
    changed([PATH]);
    expect((await screen.findByRole('alert', { name: /Removed/ })).textContent).toMatch(/removed/i);
    expect(box().value).toBe('mine\n');
    hub.puts.push({ status: 200, body: { version: V2 } });
    save();
    expect(hub.writes()).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: /Yes, make it again/ }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(V2));
    expect(hub.writes()[0]!.body).toEqual({ path: PATH, content: 'mine\n', base: null });
  });

  it('a save refused as gone does the same', async () => {
    const hub = hubFetch();
    hub.puts.push({ status: 404, body: { error: 'gone' } });
    edit('shared\n');
    type('mine\n');
    save();
    await screen.findByRole('alert', { name: /Removed/ });
    expect(box().value).toBe('mine\n');
  });
});

describe('drafts', () => {
  it('keeps unsaved text as a draft and offers it back on reopening', async () => {
    edit('a\n');
    type('a\nb\n');
    await waitFor(() => expect(localStorage.getItem(DRAFT_KEY)).not.toBeNull());
    expect(JSON.parse(localStorage.getItem(DRAFT_KEY)!)).toEqual({ text: 'a\nb\n', base: V1 });
    cleanup();

    edit('a\n');
    expect(box().value).toBe('a\n');
    fireEvent.click(screen.getByRole('button', { name: 'Restore draft' }));
    expect(box().value).toBe('a\nb\n');
    expect(screen.queryByRole('alert', { name: /Changed on disk/ })).toBeNull();
  });

  it('Discard draft forgets it', () => {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ text: 'old\n', base: V1 }));
    edit('a\n');
    fireEvent.click(screen.getByRole('button', { name: 'Discard draft' }));
    expect(box().value).toBe('a\n');
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Restore draft' })).toBeNull();
  });

  it('a draft from an older version comes back with the changed-on-disk banner', async () => {
    const hub = hubFetch();
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ text: 'old edit\n', base: V1 }));
    edit('newer\n', { version: V2 });
    fireEvent.click(screen.getByRole('button', { name: 'Restore draft' }));
    expect(box().value).toBe('old edit\n');
    banner();
    hub.puts.push({ status: 409, body: { error: 'changed', version: V2 } });
    hub.gets.push({ status: 200, body: { tome: tome('newer\n', { version: V2 }) } });
    save();
    await waitFor(() => expect(hub.writes()[0]!.body!.base).toEqual(V1));
  });

  it('a successful save clears the draft', async () => {
    const hub = hubFetch();
    hub.puts.push({ status: 200, body: { version: V2 } });
    const { onSaved } = edit('a\n');
    type('b\n');
    await waitFor(() => expect(localStorage.getItem(DRAFT_KEY)).not.toBeNull());
    save();
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    await act(async () => await new Promise((resolve) => setTimeout(resolve, 500)));
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
  });
});

describe('what the editor never opens', () => {
  it.each([
    ['a truncated Tome', { truncated: true }],
    ['an HTML Tome', { kind: 'html' as const, path: 'a.html' }],
    ['a Tome that is a link', { link: true as const }],
  ])('%s', (_, more) => {
    edit('x', more);
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Save/ })).toBeNull();
  });

  it('the reader says a link Tome is edited where it points', () => {
    render(<TomeReader node={NODE} tome={tome('# Hi', { link: true })} paths={[PATH]} onOpen={() => {}} />);
    expect(screen.getByText('This Tome is a link; edit the file it points to.')).toBeTruthy();
  });
});

describe('a new Tome', () => {
  function create(more: { folder?: string; name?: string } = {}) {
    const { hub } = fakeHub();
    const onSaved = vi.fn();
    const onClose = vi.fn();
    render(
      <NewTome
        hub={hub}
        node={NODE}
        folder={more.folder ?? 'ops'}
        {...(more.name ? { name: more.name } : {})}
        paths={[PATH]}
        onSaved={onSaved}
        onClose={onClose}
      />,
    );
    return { onSaved, onClose };
  }
  const nameBox = () => screen.getByRole('textbox', { name: /Name/ });

  it('shows the full path, then creates it with no base', async () => {
    const hub = hubFetch();
    hub.puts.push({ status: 200, body: { version: V1 } });
    const { onSaved } = create();
    fireEvent.change(nameBox(), { target: { value: 'Restores' } });
    expect(screen.getByText('ops/Restores.md')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Write it/ }));
    type('# Restores\n\nFrom the nightly copy.\n');
    save();
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('ops/Restores.md', V1));
    expect(hub.writes()[0]!.body).toEqual({
      path: 'ops/Restores.md',
      content: '# Restores\n\nFrom the nightly copy.\n',
      base: null,
    });
  });

  it('starts from a missing link’s name, in the linking Tome’s folder', () => {
    create({ folder: 'reference', name: 'Kingdom tokens' });
    expect(screen.getByText('reference/Kingdom tokens.md')).toBeTruthy();
  });

  it.each(['CLAUDE.md', 'agents.md', 'Claude', 'AGENTS'])('refuses %s before sending anything', (name) => {
    const hub = hubFetch();
    create();
    fireEvent.change(nameBox(), { target: { value: name } });
    expect(screen.getByRole('alert').textContent).toMatch(/coding agents load/);
    expect((screen.getByRole('button', { name: /Write it/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(hub.calls).toHaveLength(0);
  });

  it('refuses a name already in the Library, and one starting with a dot', () => {
    create();
    fireEvent.change(nameBox(), { target: { value: 'Backups' } });
    expect(screen.getByRole('alert').textContent).toMatch(/already/);
    fireEvent.change(nameBox(), { target: { value: '.hidden' } });
    expect(screen.getByRole('alert').textContent).toMatch(/dot/);
  });
});
