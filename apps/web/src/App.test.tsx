import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import type { HubClient } from './hub.js';

const sessions = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    node: 'node-b',
    cwd: '/w',
    label: 'fix the build',
    status: 'running',
    createdAt: 2,
    lastActivity: Date.now(),
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    node: 'node-a',
    cwd: '/m',
    label: 'private work',
    status: 'idle',
    createdAt: 1,
    lastActivity: Date.now(),
  },
];

let attentionListener: ((attention: unknown) => void) | undefined;
let appearanceListener: ((appearance: unknown) => void) | undefined;

const NO_EVENTS: never[] = [];
const LOADED = { received: 0, total: 0, synced: true };

function fakeHub(): HubClient {
  return {
    status: 'open',
    onChange: () => () => {},
    onError: () => () => {},
    onAttention: (listener: (attention: unknown) => void) => {
      attentionListener = listener;
      return () => {};
    },
    onAppearance: (listener: (appearance: unknown) => void) => {
      appearanceListener = listener;
      return () => {};
    },
    // A stable snapshot, as the real HubClient gives: useSyncExternalStore loops on a new array every call.
    events: () => NO_EVENTS,
    progress: () => LOADED,
    subscribe: vi.fn(),
    send: vi.fn(),
  } as unknown as HubClient;
}

async function renderApp() {
  render(<App hub={fakeHub()} />);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('App Kingdom tabs', () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState(null, '', '/');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const body = url === '/api/sessions' ? sessions : url === '/api/nodes' ? ['node-b', 'node-a'] : [];
        return new Response(JSON.stringify(body), { status: 200 });
      }),
    );
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows the hub-s name in the app bar and the page title', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const body =
          url === '/api/sessions'
            ? sessions
            : url === '/api/nodes'
              ? ['node-b', 'node-a']
              : url === '/api/hub'
                ? { name: 'Home fleet' }
                : [];
        return new Response(JSON.stringify(body), { status: 200 });
      }),
    );
    await renderApp();
    await waitFor(() => expect(document.title).toBe('Home fleet'));
    expect(screen.getAllByText('Home fleet').length).toBeGreaterThan(0);
  });

  it('forgets a removed Kingdom: asks the hub, and its tab goes', async () => {
    let held = sessions;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        held = held.filter((session) => session.node !== 'node-a');
        return new Response(null, { status: 204 });
      }
      const body = url === '/api/sessions' ? held : url === '/api/nodes' ? ['node-b'] : [];
      return new Response(JSON.stringify(body), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    await renderApp();
    const tabs = screen.getByRole('tablist', { name: 'Kingdoms' });
    fireEvent.click(within(tabs).getByRole('tab', { name: /node-a/ }));

    fireEvent.click(await screen.findByRole('button', { name: 'Forget node-a' }));
    fireEvent.change(screen.getByRole('textbox', { name: /to confirm/ }), { target: { value: 'node-a' } });
    fireEvent.click(screen.getByRole('button', { name: 'Yes, forget it' }));

    await waitFor(() => expect(within(tabs).queryByRole('tab', { name: /node-a/ })).toBeNull());
    expect(fetchMock).toHaveBeenCalledWith('/api/nodes/node-a/quests', { method: 'DELETE' });
  });

  it('knows what is waiting on load, without having seen it happen', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const body =
          url === '/api/sessions'
            ? sessions
            : url === '/api/nodes'
              ? ['node-b', 'node-a']
              : url === '/api/waiting'
                ? [{ session: sessions[0]!.id, node: sessions[0]!.node }]
                : [];
        return new Response(JSON.stringify(body), { status: 200 });
      }),
    );
    await renderApp();
    expect(await screen.findByTitle(/waiting on you/)).toBeTruthy();
  });

  it('keeps showing what it knew when the hub stops answering, and says it is reconnecting', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      await renderApp();
      expect(screen.getByRole('tab', { name: /node-b/ })).toBeTruthy();
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new TypeError('Failed to fetch');
        }),
      );
      await act(async () => {
        vi.advanceTimersByTime(6000);
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(screen.getByRole('tab', { name: /node-b/ })).toBeTruthy();
      expect(screen.queryByText('No Kingdoms yet.')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows a plain banner while the link to the hub is down', async () => {
    const hub = fakeHub();
    (hub as unknown as { status: string }).status = 'closed';
    render(<App hub={hub} />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.getByRole('status').textContent).toMatch(/Lost the connection to the hub/);
  });

  it('shows only the active Kingdom-s Quests, and switches with the tab', async () => {
    await renderApp();
    // Sorted ids: node-a is first, so its Castle shows by default.
    expect(screen.getByRole('tab', { name: /private work/ })).toBeTruthy();
    expect(screen.queryByText('fix the build')).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: /node-b/ }));
    expect(screen.getByRole('tab', { name: /fix the build/ })).toBeTruthy();
    expect(screen.queryByText('private work')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'New Quest' }));
    expect(screen.getByText('New Quest on node-b')).toBeTruthy();
  });

  it('draws Kingdoms in the user-s synced look, takes changes from other devices live, and saves its own', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === '/api/appearance' && init?.method === 'PUT') return new Response(null, { status: 204 });
        const body =
          url === '/api/sessions'
            ? sessions
            : url === '/api/nodes'
              ? ['node-b', 'node-a']
              : url === '/api/appearance'
                ? { tabStyle: 'tinted', looks: { 'node-a': { icon: 'spire', colour: '#8a4fd0' } } }
                : [];
        return new Response(JSON.stringify(body), { status: 200 });
      }),
    );
    await renderApp();
    const tablist = screen.getByRole('tablist', { name: 'Kingdoms' });
    expect(tablist.getAttribute('data-tab-style')).toBe('tinted');
    const icon = () =>
      within(tablist)
        .getByRole('tab', { name: /node-a/ })
        .querySelector('svg')!
        .getAttribute('data-icon');
    expect(icon()).toBe('spire');

    act(() => appearanceListener!({ tabStyle: 'pennant', looks: { 'node-a': { icon: 'ship' } } }));
    expect(tablist.getAttribute('data-tab-style')).toBe('pennant');
    expect(icon()).toBe('ship');

    fireEvent.click(screen.getByRole('button', { name: 'Config' }));
    fireEvent.change(screen.getByLabelText('Tab style'), { target: { value: 'underline' } });
    expect(tablist.getAttribute('data-tab-style')).toBe('underline');
    const put = vi.mocked(fetch).mock.calls.find(([url, init]) => url === '/api/appearance' && init?.method === 'PUT');
    expect(JSON.parse(String(put![1]!.body))).toEqual({ tabStyle: 'underline', looks: { 'node-a': { icon: 'ship' } } });
  });

  it('returns to the Quest a Kingdom was showing when its tab is picked again', async () => {
    await renderApp();
    fireEvent.click(screen.getByRole('tab', { name: /private work/ }));
    expect(screen.getByRole('tab', { name: /private work/, selected: true })).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: /node-b/ }));
    expect(screen.queryByRole('tab', { name: /private work/ })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: /node-a/ }));
    expect(screen.getByRole('tab', { name: /private work/, selected: true })).toBeTruthy();
  });

  it('draws each Quest-s party leader in its tab once the Hero art pack loads', async () => {
    const manifest = {
      leader: 'paladin',
      fallback: 'paladin',
      classes: { paladin: { name: 'Paladin', match: [], work: 'slash', verb: 'Smite', victory: 'emote', anims: {} } },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const body =
          url === '/api/sessions'
            ? sessions
            : url === '/api/nodes'
              ? ['node-b', 'node-a']
              : url === '/heroes/manifest.json'
                ? manifest
                : [];
        return new Response(JSON.stringify(body), { status: 200 });
      }),
    );
    await renderApp();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const tab = screen.getByRole('tab', { name: 'private work' });
    expect(tab.querySelector('canvas[data-class="paladin"]')).not.toBeNull();
  });

  it('keeps where the user is in the address, and returns there on a reload', async () => {
    await renderApp();
    fireEvent.click(screen.getByRole('tab', { name: /private work/ }));
    expect(window.location.hash).toBe(`#/k/node-a/q/${sessions[1]!.id}`);
    cleanup();
    await renderApp();
    expect(screen.getByRole('tab', { name: /private work/, selected: true })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Crystal Bridge/ }));
    expect(window.location.hash).toBe('#/airship');
    cleanup();
    await renderApp();
    expect(screen.getByRole('region', { name: 'Tavern' })).toBeTruthy();
  });

  it('adds each view to the history, so Back returns to the one before (a phone back gesture too)', async () => {
    await renderApp();
    const start = window.history.length;
    fireEvent.click(screen.getByRole('tab', { name: /private work/ }));
    fireEvent.click(screen.getByRole('button', { name: /Crystal Bridge/ }));
    expect(window.history.length).toBe(start + 2);
    expect(window.location.hash).toBe('#/airship');
    await act(async () => {
      window.history.back();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(window.location.hash).toBe(`#/k/node-a/q/${sessions[1]!.id}`);
    expect(screen.getByRole('tab', { name: /private work/, selected: true })).toBeTruthy();
  });

  it('follows a change to the address while open (a link, or an edited address)', async () => {
    await renderApp();
    await act(async () => {
      window.location.hash = `#/k/node-a/q/${sessions[1]!.id}`;
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(screen.getByRole('tab', { name: /private work/, selected: true })).toBeTruthy();
    await act(async () => {
      window.location.hash = '#/airship';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(screen.getByRole('region', { name: 'Tavern' })).toBeTruthy();
  });

  it('reopens New Quest on its Kingdom from the address, not the default one', async () => {
    window.history.replaceState(null, '', '/#/k/node-b/new');
    await renderApp();
    expect(screen.getByRole('heading', { name: /on node-b/ })).toBeTruthy();
  });

  it('goes Home to the Airship from the logo, and into a Castle from its card', async () => {
    await renderApp();
    fireEvent.click(screen.getByRole('button', { name: /Crystal Bridge/ }));
    expect(screen.getByRole('region', { name: 'Tavern' })).toBeTruthy();
    expect(screen.queryByRole('tablist', { name: 'Quests' })).toBeNull();

    fireEvent.click(within(screen.getByRole('region', { name: 'Kingdoms' })).getByRole('button', { name: /^node-b/ }));
    expect(screen.getByRole('tab', { name: /fix the build/ })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Tavern' })).toBeNull();
  });

  it('reorders Kingdom tabs on this device, and remembers the order', async () => {
    await renderApp();
    const kingdoms = () =>
      within(screen.getByRole('tablist', { name: 'Kingdoms' }))
        .getAllByRole('tab')
        .map((tab) => tab.getAttribute('data-kingdom'));
    expect(kingdoms()).toEqual(['node-a', 'node-b']);
    fireEvent.keyDown(screen.getByRole('tab', { name: /node-b/ }), { key: 'ArrowLeft', altKey: true });
    expect(kingdoms()).toEqual(['node-b', 'node-a']);
    cleanup();
    await renderApp();
    expect(kingdoms()).toEqual(['node-b', 'node-a']);
  });

  it('puts a Quest-s tab away on this device, and remembers that', async () => {
    await renderApp();
    fireEvent.click(screen.getByRole('button', { name: 'Put away private work' }));
    expect(screen.queryByRole('tab', { name: /private work/ })).toBeNull();
    cleanup();
    await renderApp();
    expect(screen.queryByRole('tab', { name: /private work/ })).toBeNull();
  });

  it('keeps a hidden Kingdom off the page entirely, and remembers that on this device', async () => {
    await renderApp();
    fireEvent.click(screen.getByRole('button', { name: 'Config' }));
    fireEvent.click(screen.getByLabelText('Show node-a on this device'));

    expect(screen.queryByText('private work')).toBeNull();
    expect(screen.queryByRole('tab', { name: /node-a/ })).toBeNull();
    expect(screen.getByRole('tab', { name: /fix the build/ })).toBeTruthy();

    cleanup();
    await renderApp();
    expect(screen.queryByRole('tab', { name: /node-a/ })).toBeNull();
    expect(screen.queryByText('private work')).toBeNull();
  });

  it('picks up Kingdom settings another tab changed, so open tabs never disagree', async () => {
    await renderApp();
    expect(within(screen.getByRole('tablist', { name: 'Kingdoms' })).getByRole('tab', { name: /node-a/ })).toBeTruthy();

    localStorage.setItem('crystal-bridge.kingdoms', JSON.stringify({ names: {}, hidden: ['node-a'] }));
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'crystal-bridge.kingdoms' }));
    });
    expect(screen.queryByRole('tab', { name: /node-a/ })).toBeNull();
  });

  it('uses the current Discreet setting when a notification fires, even if this tab never heard of the change', async () => {
    const shown: { title: string; body: string }[] = [];
    class FakeNotification {
      static permission = 'granted';
      onclick: (() => void) | null = null;
      constructor(title: string, options: { body: string }) {
        shown.push({ title, body: options.body });
      }
      close() {}
    }
    vi.stubGlobal('Notification', FakeNotification);
    await renderApp();

    // Another tab switches node-a to Discreet; this tab gets no storage event.
    localStorage.setItem(
      'crystal-bridge.kingdoms',
      JSON.stringify({ names: {}, hidden: [], notify: { 'node-a': 'discreet' } }),
    );
    act(() => {
      attentionListener!({
        kind: 'attention',
        node: 'node-a',
        session: '33333333-3333-4333-8333-333333333333',
        label: 'private work',
        reason: 'needs-you',
        detail: 'Bash',
      });
    });

    expect(shown).toEqual([{ title: 'node-a needs you', body: 'Open Crystal Bridge to see it.' }]);
  });

  it('opens the session a notification click asked for, then tidies the address', async () => {
    window.history.replaceState(null, '', `/?node=node-b&session=${sessions[0]!.id}`);
    const hub = fakeHub();
    render(<App hub={hub} />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.getByRole('tab', { name: /fix the build/ }).getAttribute('aria-selected')).toBe('true');
    expect(hub.subscribe).toHaveBeenCalledWith(sessions[0]!.id);
    expect(window.location.search).toBe('');
  });

  it('never opens a hidden Kingdom-s session from a notification click', async () => {
    localStorage.setItem('crystal-bridge.kingdoms', JSON.stringify({ names: {}, hidden: ['node-a'] }));
    window.history.replaceState(null, '', `/?node=node-a&session=${sessions[1]!.id}`);
    const hub = fakeHub();
    render(<App hub={hub} />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.queryByText('private work')).toBeNull();
    expect(hub.subscribe).not.toHaveBeenCalledWith(sessions[1]!.id);
  });

  it('searches the active Kingdom only, and opens a session from a result', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (url) => {
      const u = String(url);
      const body =
        u === '/api/sessions'
          ? sessions
          : u === '/api/nodes'
            ? ['node-b', 'node-a']
            : u.startsWith('/api/search')
              ? [
                  {
                    session: sessions[0]!.id,
                    seq: 4,
                    label: 'fix the build',
                    event: {
                      node: 'node-b',
                      session: sessions[0]!.id,
                      seq: 4,
                      ts: 0,
                      type: 'user.message',
                      payload: { text: 'the flaky step' },
                    },
                  },
                ]
              : [];
      return new Response(JSON.stringify(body), { status: 200 });
    });
    await renderApp();
    fireEvent.click(screen.getByRole('tab', { name: /node-b/ }));
    fireEvent.click(screen.getByRole('button', { name: /Chronicle/ }));
    fireEvent.change(screen.getByPlaceholderText('Search this Kingdom'), { target: { value: 'flaky' } });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toContain('/api/search?node=node-b&q=flaky');
    fireEvent.click(await screen.findByText('the flaky step'));
    expect(screen.getByRole('tab', { name: /fix the build/ }).getAttribute('aria-selected')).toBe('true');
  });

  it('splits the view with a Quest from another Kingdom, keeps it across reloads, and closes the pane', async () => {
    await renderApp();
    fireEvent.click(screen.getByRole('tab', { name: /node-b/ }));
    fireEvent.click(screen.getByRole('tab', { name: /fix the build/ }));
    fireEvent.click(screen.getByRole('button', { name: /Split/ }));
    const picker = screen.getByRole('dialog', { name: /Split/ });
    // Any active Quest in any shown Kingdom, but not the one already open.
    expect(within(picker).queryByText('fix the build')).toBeNull();
    fireEvent.click(within(picker).getByRole('button', { name: /private work/ }));

    expect(screen.getByRole('region', { name: /fix the build/ })).toBeTruthy();
    const second = screen.getByRole('region', { name: /private work/ });
    expect(within(second).getByText(/node-a/)).toBeTruthy();

    cleanup();
    await renderApp();
    expect(screen.getByRole('region', { name: /private work/ })).toBeTruthy();

    fireEvent.click(
      within(screen.getByRole('region', { name: /private work/ })).getByRole('button', { name: 'Exit Split Party' }),
    );
    expect(screen.queryByRole('region', { name: /private work/ })).toBeNull();
    expect(screen.getByRole('tab', { name: /fix the build/, selected: true })).toBeTruthy();
  });

  it('shows the shared panels for the focused pane, inserts Inventory picks there, and exits from the toolbar', async () => {
    const init = (session: string, node: string, skill: string) => ({
      node,
      session,
      seq: 1,
      ts: 0,
      type: 'claude.event',
      payload: {
        engine: 'claude',
        raw: { type: 'system', subtype: 'init', cwd: '/w', skills: [skill], slash_commands: [skill] },
      },
    });
    const byId: Record<string, unknown[]> = {
      [sessions[0]!.id]: [init(sessions[0]!.id, 'node-b', 'build-skill')],
      [sessions[1]!.id]: [init(sessions[1]!.id, 'node-a', 'private-skill')],
    };
    render(<App hub={{ ...fakeHub(), events: (id: string) => byId[id] ?? NO_EVENTS } as unknown as HubClient} />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    fireEvent.click(screen.getByRole('tab', { name: /node-b/ }));
    fireEvent.click(screen.getByRole('tab', { name: /fix the build/ }));
    fireEvent.click(screen.getByRole('button', { name: /Split/ }));
    fireEvent.click(
      within(screen.getByRole('dialog', { name: /Split/ })).getByRole('button', { name: /private work/ }),
    );

    // The main pane is focused at first: the shared panels show its Quest.
    const details = () => screen.getByRole('complementary', { name: 'Session details' });
    const inventory = () => screen.getByRole('complementary', { name: 'Inventory' });
    expect(within(details()).getByText('node-b')).toBeTruthy();
    expect(within(inventory()).getByText('build-skill')).toBeTruthy();

    // Clicking into the second pane moves them to its Quest, and an Inventory pick lands in its follow-up box.
    const second = screen.getByRole('region', { name: /private work/ });
    fireEvent.pointerDown(second);
    expect(within(details()).getByText('node-a')).toBeTruthy();
    fireEvent.click(within(inventory()).getByRole('button', { name: 'private-skill' }));
    expect((within(second).getByPlaceholderText(/follow-up/i) as HTMLTextAreaElement).value).toBe('/private-skill ');
    const main = screen.getByRole('region', { name: /fix the build/ });
    expect((within(main).getByPlaceholderText(/follow-up/i) as HTMLTextAreaElement).value).toBe('');

    // Leaving the split from the main toolbar, with the same words as the second pane's header.
    fireEvent.click(within(main).getByRole('button', { name: 'Exit Split Party' }));
    expect(screen.queryByRole('region', { name: /private work/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Close pane|Unsplit/ })).toBeNull();
  });

  it('aims the shared Belt at the focused pane: its Kingdom-s slots, and its Quest for sending', async () => {
    const appearance = {
      belts: {
        'node-b': [{ label: 'build-slot', text: 'Build it', now: true }],
        'node-a': [{ label: 'private-slot', text: 'Keep it private', now: true }],
      },
    };
    const fetchMock = vi.mocked(fetch);
    const answer = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url, init) =>
      String(url) === '/api/appearance' && !init?.method
        ? ({ ok: true, json: async () => appearance } as Response)
        : answer(url, init),
    );
    const hub = fakeHub();
    render(<App hub={hub} />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    fireEvent.click(screen.getByRole('tab', { name: /node-b/ }));
    fireEvent.click(screen.getByRole('tab', { name: /fix the build/ }));
    fireEvent.click(screen.getByRole('button', { name: /Split/ }));
    fireEvent.click(
      within(screen.getByRole('dialog', { name: /Split/ })).getByRole('button', { name: /private work/ }),
    );
    const inventory = () => screen.getByRole('complementary', { name: 'Inventory' });
    const slot = (name: RegExp) => within(inventory()).getByRole('button', { name });

    // The main pane is focused at first. An editor left open must not carry over to the other Kingdom's Belt.
    fireEvent.click(within(inventory()).getByRole('button', { name: 'Edit slots' }));
    fireEvent.click(slot(/^build-slot/));
    expect(within(inventory()).getByLabelText('Prompt text')).toBeTruthy();
    fireEvent.pointerDown(screen.getByRole('region', { name: /private work/ }));
    expect(within(inventory()).queryByLabelText('Prompt text')).toBeNull();

    fireEvent.click(slot(/^private-slot/));
    expect(hub.send).toHaveBeenCalledWith({ type: 'session.send', session: sessions[1]!.id, text: 'Keep it private' });
    expect(within(inventory()).queryByRole('button', { name: /^build-slot/ })).toBeNull();
  });

  it('never offers a hidden Kingdom-s Quests for the split', async () => {
    localStorage.setItem('crystal-bridge.kingdoms', JSON.stringify({ names: {}, hidden: ['node-a'] }));
    await renderApp();
    fireEvent.click(screen.getByRole('tab', { name: /fix the build/ }));
    fireEvent.click(screen.getByRole('button', { name: /Split/ }));
    expect(within(screen.getByRole('dialog', { name: /Split/ })).queryByText('private work')).toBeNull();
  });

  it('shows each Quest-s project beside its Kingdom in the split picker', async () => {
    await renderApp();
    fireEvent.click(screen.getByRole('tab', { name: /node-b/ }));
    fireEvent.click(screen.getByRole('tab', { name: /fix the build/ }));
    fireEvent.click(screen.getByRole('button', { name: /Split/ }));
    const row = within(screen.getByRole('dialog', { name: /Split/ })).getByRole('button', { name: /private work/ });
    expect(row.querySelector('[data-project]')?.textContent).toBe('m');
    expect(row.querySelector('[data-project]')?.parentElement?.textContent).toContain('node-a');
  });

  it('leaves the project out of the split picker for a Discreet Kingdom', async () => {
    localStorage.setItem(
      'crystal-bridge.kingdoms',
      JSON.stringify({ names: {}, hidden: [], notify: { 'node-a': 'discreet' } }),
    );
    await renderApp();
    fireEvent.click(screen.getByRole('tab', { name: /node-b/ }));
    fireEvent.click(screen.getByRole('tab', { name: /fix the build/ }));
    fireEvent.click(screen.getByRole('button', { name: /Split/ }));
    const row = within(screen.getByRole('dialog', { name: /Split/ })).getByRole('button', { name: /private work/ });
    expect(row.querySelector('[data-project]')).toBeNull();
    expect(row.textContent).toContain('node-a');
  });
});

describe('App file viewer', () => {
  const QUEST = '22222222-2222-4222-8222-222222222222';
  const REPLY: never[] = [
    {
      node: 'node-a',
      session: QUEST,
      seq: 0,
      ts: 0,
      type: 'claude.event',
      payload: {
        engine: 'claude',
        raw: { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'See `notes.md`.' }] } },
      },
    } as never,
  ];

  beforeEach(() => {
    window.history.replaceState(null, '', '/');
    localStorage.clear();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const body = url === '/api/sessions' ? sessions : url === '/api/nodes' ? ['node-b', 'node-a'] : [];
        return new Response(JSON.stringify(body), { status: 200 });
      }),
    );
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('asks the Quest-s Kingdom for a file named in a reply and shows it, then closes on Esc', async () => {
    const readFile = vi.fn(async () => ({
      kind: 'file' as const,
      requestId: '33333333-3333-4333-8333-333333333333',
      ok: true,
      path: 'notes.md',
      content: '# Notes',
      size: 7,
    }));
    const hub = { ...fakeHub(), events: (session: string) => (session === QUEST ? REPLY : NO_EVENTS), readFile };
    render(<App hub={hub as unknown as HubClient} />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    fireEvent.click(screen.getByRole('tab', { name: /private work/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'notes.md' }));
    });
    expect(readFile).toHaveBeenCalledWith(QUEST, 'notes.md');
    expect(screen.getByRole('heading', { name: 'Notes' })).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('heading', { name: 'Notes' })).toBeNull();
  });
});
