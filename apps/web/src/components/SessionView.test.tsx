import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Envelope } from '@crystal-bridge/protocol';
import { SessionView } from './SessionView.js';

const SESSION = '11111111-1111-4111-8111-111111111111';
const REQUEST_ID = 'req-1';

function envelope(seq: number, type: Envelope['type'], payload: unknown): Envelope {
  return { node: 'node-a', session: SESSION, seq, ts: 0, type, payload };
}

const requested: Envelope[] = [
  envelope(0, 'session.started', { cwd: '/tmp/FIXTURE', prompt: 'touch it', label: 'touch it' }),
  envelope(1, 'permission.request', {
    requestId: REQUEST_ID,
    toolName: 'Bash',
    input: { command: 'touch crystal.txt' },
  }),
];
const resolved: Envelope[] = [
  ...requested,
  envelope(2, 'permission.resolved', { requestId: REQUEST_ID, behavior: 'allow' }),
];

/** A fake hub error source: `fire` delivers a message to every current listener. */
function errorSource() {
  const listeners = new Set<(message: string) => void>();
  return {
    subscribe: (listener: (message: string) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    fire: (message: string) => {
      for (const listener of listeners) listener(message);
    },
  };
}

function approve(): HTMLButtonElement {
  return screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement;
}

function renderView(envelopes: Envelope[], errors = errorSource(), onAnswer = vi.fn(), onSend = vi.fn()) {
  const props = {
    onAnswer,
    onSend,
    onInterrupt: () => {},
    onMode: () => {},
    subscribeErrors: errors.subscribe,
  };
  const view = render(<SessionView envelopes={envelopes} {...props} />);
  return { ...view, rerenderWith: (next: Envelope[]) => view.rerender(<SessionView envelopes={next} {...props} />) };
}

describe('SessionView permission answers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('disables the buttons while sending, and re-enables them when the hub replies with an error', () => {
    const errors = errorSource();
    const onAnswer = vi.fn();
    renderView(requested, errors, onAnswer);

    fireEvent.click(approve());
    expect(onAnswer).toHaveBeenCalledWith(REQUEST_ID, 'allow');
    expect(approve().disabled).toBe(true);

    act(() => errors.fire('node offline'));
    expect(approve().disabled).toBe(false);
  });

  it('re-enables the buttons after 10 s with no resolution', () => {
    renderView(requested);

    fireEvent.click(approve());
    act(() => vi.advanceTimersByTime(9_999));
    expect(approve().disabled).toBe(true);
    act(() => vi.advanceTimersByTime(1));
    expect(approve().disabled).toBe(false);
  });

  it('keeps the buttons disabled once permission.resolved arrives, even after an error or the timeout', () => {
    const errors = errorSource();
    const { rerenderWith } = renderView(requested, errors);

    fireEvent.click(approve());
    rerenderWith(resolved);
    act(() => errors.fire('something else failed'));
    act(() => vi.advanceTimersByTime(10_000));

    expect(approve().disabled).toBe(true);
    expect(screen.getByText('Approved')).toBeTruthy();
  });
});

describe('SessionView follow-ups', () => {
  afterEach(() => {
    cleanup();
  });

  const stopped: Envelope[] = [
    envelope(0, 'session.started', { cwd: '/tmp/FIXTURE', prompt: 'sleep', label: 'sleep' }),
    envelope(1, 'session.ended', { exitCode: 0, signal: null, reason: 'exit' }),
  ];

  for (const reason of ['exit', 'idle', 'error'] as const) {
    it(`keeps the follow-up box enabled after a session.ended with reason ${reason}, so a send can resume it`, () => {
      const onSend = vi.fn();
      renderView(
        [stopped[0]!, envelope(1, 'session.ended', { exitCode: 0, signal: null, reason })],
        errorSource(),
        vi.fn(),
        onSend,
      );

      const box = screen.getByPlaceholderText(/follow-up/i) as HTMLTextAreaElement;
      expect(box.disabled).toBe(false);
      fireEvent.change(box, { target: { value: 'pick it back up' } });
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));

      expect(onSend).toHaveBeenCalledWith('pick it back up');
    });
  }

  it('keeps an unsent follow-up per Quest when the Quest is left and reopened, until it is sent', () => {
    const props = {
      onAnswer: vi.fn(),
      onSend: vi.fn(),
      onInterrupt: () => {},
      onMode: () => {},
      subscribeErrors: errorSource().subscribe,
    };
    const open = () => render(<SessionView session={SESSION} envelopes={stopped} {...props} />);
    const box = () => screen.getByPlaceholderText(/follow-up/i) as HTMLTextAreaElement;
    open();
    fireEvent.change(box(), { target: { value: 'half a thought' } });
    cleanup();
    open();
    expect(box().value).toBe('half a thought');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    cleanup();
    open();
    expect(box().value).toBe('');
    cleanup();
    localStorage.clear();
  });

  it('offers no Stop while no process runs, and Stop again once the session resumes', () => {
    const ended = [stopped[0]!, envelope(1, 'session.ended', { exitCode: 0, signal: null, reason: 'idle' })];
    const { rerenderWith } = renderView(ended);
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);

    rerenderWith([...ended, envelope(2, 'user.message', { text: 'back' }), envelope(3, 'session.resumed', {})]);
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
  });
});

describe('SessionView permission mode', () => {
  afterEach(() => cleanup());

  it('shows the mode the CLI reported and switches it', () => {
    const onMode = vi.fn();
    const envelopes = [
      envelope(0, 'session.started', { cwd: '/w', prompt: 'p', label: 'p' }),
      envelope(1, 'claude.event', {
        engine: 'claude',
        raw: { type: 'system', subtype: 'init', permissionMode: 'auto' },
      }),
    ];
    render(
      <SessionView
        envelopes={envelopes}
        onAnswer={vi.fn()}
        onSend={vi.fn()}
        onInterrupt={vi.fn()}
        onMode={onMode}
        subscribeErrors={() => () => {}}
      />,
    );
    const select = screen.getByLabelText('Permission mode') as HTMLSelectElement;
    expect(select.value).toBe('auto');
    fireEvent.change(select, { target: { value: 'plan' } });
    expect(onMode).toHaveBeenCalledWith('plan');
  });

  it('changes effort from the prompt bar, starting from what the Quest uses', () => {
    const onEffort = vi.fn();
    const started: Envelope = {
      node: 'n',
      session: 's',
      seq: 0,
      ts: 0,
      type: 'session.started',
      payload: { cwd: '/w', prompt: 'p', label: 'p', effort: 'high' },
    };
    render(
      <SessionView
        session="s"
        envelopes={[started]}
        onAnswer={vi.fn()}
        onSend={vi.fn()}
        onInterrupt={vi.fn()}
        onMode={vi.fn()}
        onEffort={onEffort}
        subscribeErrors={() => () => {}}
      />,
    );
    const select = screen.getByLabelText('Effort') as HTMLSelectElement;
    expect(select.value).toBe('high');
    fireEvent.change(select, { target: { value: 'low' } });
    expect(onEffort).toHaveBeenCalledWith('low');
    fireEvent.change(select, { target: { value: '' } });
    expect(onEffort).toHaveBeenLastCalledWith(undefined);
  });
});

describe('SessionView worktree', () => {
  afterEach(() => cleanup());

  it('shows the branch of a session running in its own worktree', () => {
    const envelopes = [
      envelope(0, 'session.started', {
        cwd: '/r/.worktrees/0123abcd',
        prompt: 'p',
        label: 'p',
        worktree: { root: '/r', branch: 'cb/0123abcd' },
      }),
    ];
    render(
      <SessionView
        envelopes={envelopes}
        onAnswer={vi.fn()}
        onSend={vi.fn()}
        onInterrupt={vi.fn()}
        onMode={vi.fn()}
        subscribeErrors={() => () => {}}
      />,
    );
    // In the header, and again in the side panel's Environment.
    expect(screen.getAllByText('cb/0123abcd').length).toBeGreaterThan(0);
    expect(screen.getByRole('complementary', { name: 'Session details' }).textContent).toContain('cb/0123abcd');
  });
});

describe('SessionView closing', () => {
  afterEach(() => cleanup());
  const base = [
    envelope(0, 'session.started', {
      cwd: '/r/.worktrees/0123abcd',
      prompt: 'p',
      label: 'p',
      worktree: { root: '/r', branch: 'cb/0123abcd' },
    }),
  ];
  const view = (envelopes: Envelope[], onClose = vi.fn()) => {
    render(
      <SessionView
        envelopes={envelopes}
        onAnswer={vi.fn()}
        onSend={vi.fn()}
        onInterrupt={vi.fn()}
        onMode={vi.fn()}
        onClose={onClose}
        subscribeErrors={() => () => {}}
      />,
    );
    return onClose;
  };

  it('asks before closing, and offers to remove the worktree', () => {
    const onClose = view(base);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    // Removing is the default: a worktree with uncommitted changes is kept anyway, and the branch always stays.
    expect((screen.getByLabelText(/Remove its worktree/) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Close session' }));
    expect(onClose).toHaveBeenCalledWith(true);
  });

  it('takes no follow-ups once closed', () => {
    view([...base, envelope(1, 'session.closed', { worktree: { removed: true } })]);
    expect((screen.getByPlaceholderText('Session closed') as HTMLTextAreaElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
    expect(screen.getByText(/Worktree removed/)).toBeTruthy();
  });
});

describe('SessionView slash commands', () => {
  afterEach(() => cleanup());
  const envelopes = [
    envelope(0, 'session.started', { cwd: '/w', prompt: 'p', label: 'p' }),
    envelope(1, 'claude.event', {
      engine: 'claude',
      raw: {
        type: 'system',
        subtype: 'init',
        slash_commands: ['compact', 'loadout:code-debug', 'loadout:code-review'],
        terminal_slash_commands: [],
      },
    }),
  ];

  it('suggests matching commands after a slash and completes the highlighted one with Enter, without sending', () => {
    const onSend = vi.fn();
    render(
      <SessionView
        envelopes={envelopes}
        onAnswer={vi.fn()}
        onSend={onSend}
        onInterrupt={vi.fn()}
        onMode={vi.fn()}
        subscribeErrors={() => () => {}}
      />,
    );
    const box = screen.getByPlaceholderText('Send a follow-up');
    fireEvent.change(box, { target: { value: '/code' } });
    const list = screen.getByRole('listbox', { name: 'Slash commands' });
    expect(
      within(list)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['/loadout:code-debug', '/loadout:code-review']);
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect((box as HTMLTextAreaElement).value).toBe('/loadout:code-review ');
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox', { name: 'Slash commands' })).toBeNull();
  });

  it('shows no suggestions once the message is more than a command name', () => {
    render(
      <SessionView
        envelopes={envelopes}
        onAnswer={vi.fn()}
        onSend={vi.fn()}
        onInterrupt={vi.fn()}
        onMode={vi.fn()}
        subscribeErrors={() => () => {}}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText('Send a follow-up'), { target: { value: '/compact now please' } });
    expect(screen.queryByRole('listbox', { name: 'Slash commands' })).toBeNull();
  });
});

describe('SessionView forking', () => {
  afterEach(() => cleanup());
  const SOURCE = '22222222-2222-4222-8222-222222222222';
  const view = (envelopes: Envelope[]) => {
    const onFork = vi.fn();
    const onOpen = vi.fn();
    render(
      <SessionView
        envelopes={envelopes}
        onAnswer={vi.fn()}
        onSend={vi.fn()}
        onInterrupt={vi.fn()}
        onMode={vi.fn()}
        onFork={onFork}
        onOpen={onOpen}
        subscribeErrors={() => () => {}}
      />,
    );
    return { onFork, onOpen };
  };

  it('forks the conversation with a first prompt for the copy', () => {
    const { onFork } = view([envelope(0, 'session.started', { cwd: '/w', prompt: 'p', label: 'p' })]);
    fireEvent.click(screen.getByRole('button', { name: 'Fork' }));
    fireEvent.change(screen.getByLabelText('First prompt for the fork'), { target: { value: ' try it another way ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start fork' }));
    expect(onFork).toHaveBeenCalledWith('try it another way');
    expect(screen.queryByLabelText('First prompt for the fork')).toBeNull();
  });

  it('links a fork back to the session it came from', () => {
    const { onOpen } = view([
      envelope(0, 'session.started', { cwd: '/w', prompt: 'p', label: 'p', forkedFrom: SOURCE }),
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Forked from…' }));
    expect(onOpen).toHaveBeenCalledWith(SOURCE);
  });

  it('names the source Quest on the fork link when its label is known', () => {
    render(
      <SessionView
        envelopes={[envelope(0, 'session.started', { cwd: '/w', prompt: 'p', label: 'p', forkedFrom: SOURCE })]}
        onAnswer={vi.fn()}
        onSend={vi.fn()}
        onInterrupt={vi.fn()}
        onMode={vi.fn()}
        onOpen={vi.fn()}
        labelOf={(id) => (id === SOURCE ? 'Refactor the login flow so the session token survives a reload' : undefined)}
        subscribeErrors={() => () => {}}
      />,
    );
    const link = screen.getByRole('button', { name: /^Forked from Refactor the login flow/ });
    expect(link.textContent!.length).toBeLessThan(60);
    expect(link.getAttribute('title')).toContain('survives a reload');
  });
});

describe('SessionView inventory', () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });
  const envelopes = [
    envelope(0, 'session.started', { cwd: '/w', prompt: 'p', label: 'p' }),
    envelope(1, 'claude.event', {
      engine: 'claude',
      raw: { type: 'system', subtype: 'init', slash_commands: ['code-review', 'compact'], skills: ['code-review'] },
    }),
  ];
  const view = () =>
    render(
      <SessionView
        envelopes={envelopes}
        onAnswer={vi.fn()}
        onSend={vi.fn()}
        onInterrupt={vi.fn()}
        onMode={vi.fn()}
        subscribeErrors={() => () => {}}
      />,
    );

  it('puts a Spell into the follow-up box without sending it', () => {
    view();
    const inventory = screen.getByRole('complementary', { name: 'Inventory' });
    fireEvent.click(within(inventory).getByRole('button', { name: 'code-review' }));
    expect((screen.getByPlaceholderText('Send a follow-up') as HTMLTextAreaElement).value).toBe('/code-review ');
  });

  it('folds the Inventory away, and remembers that on this device', () => {
    view();
    fireEvent.click(screen.getByRole('button', { name: 'Inventory' }));
    expect(screen.queryByRole('complementary', { name: 'Inventory' })).toBeNull();
    cleanup();
    view();
    expect(screen.queryByRole('complementary', { name: 'Inventory' })).toBeNull();
  });
});

describe('SessionView width', () => {
  afterEach(() => cleanup());

  it('wraps long text instead of scrolling the pane sideways; tables and code scroll in their own box', () => {
    render(
      <SessionView
        envelopes={[
          envelope(0, 'session.started', { cwd: '/w', prompt: 'p', label: 'p' }),
          envelope(1, 'claude.event', {
            engine: 'claude',
            raw: {
              type: 'assistant',
              message: { id: 'm1', content: [{ type: 'text', text: '| a | b |\n|---|---|\n| 1 | 2 |' }] },
            },
          }),
        ]}
        onAnswer={vi.fn()}
        onSend={vi.fn()}
        onInterrupt={vi.fn()}
        onMode={vi.fn()}
        subscribeErrors={() => () => {}}
      />,
    );
    const pane = screen.getByTestId('quest-scroll');
    expect(pane.className).toContain('overflow-x-hidden');
    const message = screen.getByTestId('assistant-text');
    expect(message.className).toContain('[overflow-wrap:anywhere]');
    expect(message.className).toContain('[&_table]:overflow-x-auto');
  });
});

describe('SessionView loading and scroll', () => {
  // A fresh Quest per test: scroll positions are remembered per Quest for the page's lifetime.
  let S = '';
  let n = 0;
  beforeEach(() => {
    S = `33333333-3333-4333-8333-${String(++n).padStart(12, '0')}`;
  });
  const at = (seq: number, text: string): Envelope => ({
    node: 'n',
    session: S,
    seq,
    ts: 0,
    type: seq === 0 ? 'session.started' : 'user.message',
    payload: seq === 0 ? { cwd: '/w', prompt: text, label: text } : { text },
  });
  // jsdom has no layout: give the scroll pane a fixed size.
  let height = 1000;
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => height });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 200 });
  });
  afterEach(() => {
    cleanup();
    height = 1000;
    delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
    delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
  });
  const view = (
    envelopes: Envelope[],
    progress = { received: envelopes.length, total: envelopes.length as number | null, synced: true },
  ) => (
    <SessionView
      session={S}
      envelopes={envelopes}
      progress={progress}
      onAnswer={vi.fn()}
      onSend={vi.fn()}
      onInterrupt={vi.fn()}
      onMode={vi.fn()}
      subscribeErrors={() => () => {}}
    />
  );

  it('shows a loading screen with progress until the history is synced, then the chat at the bottom', () => {
    const { rerender } = render(view([at(0, 'first')], { received: 1, total: 10, synced: false }));
    expect(screen.getByText(/Unrolling the Chronicle|Loading history/)).toBeTruthy();
    expect(screen.getByText('1 of 10')).toBeTruthy();
    expect(screen.queryByText('first')).toBeNull();

    rerender(view([at(0, 'first'), at(1, 'second')]));
    expect(screen.queryByText(/Unrolling the Chronicle|Loading history/)).toBeNull();
    expect(screen.getByText('second')).toBeTruthy();
    expect(screen.getByTestId('quest-scroll').scrollTop).toBe(1000);
  });

  it('remembers where you were in a Quest when you come back to it', () => {
    const history = [at(0, 'first'), at(1, 'second')];
    render(view(history));
    const pane = screen.getByTestId('quest-scroll');
    pane.scrollTop = 300;
    fireEvent.scroll(pane);
    cleanup();

    render(view(history));
    expect(screen.getByTestId('quest-scroll').scrollTop).toBe(300);
  });

  it('follows new messages only when at the bottom, and offers a jump when not', () => {
    const history = [at(0, 'first'), at(1, 'second')];
    const { rerender } = render(view(history));
    const pane = screen.getByTestId('quest-scroll');
    expect(pane.scrollTop).toBe(1000);

    height = 1200;
    rerender(view([...history, at(2, 'third')]));
    expect(pane.scrollTop).toBe(1200);

    pane.scrollTop = 100;
    fireEvent.scroll(pane);
    height = 1400;
    rerender(view([...history, at(2, 'third'), at(3, 'fourth')]));
    expect(pane.scrollTop).toBe(100);
    fireEvent.click(screen.getByRole('button', { name: 'Jump to latest' }));
    expect(pane.scrollTop).toBe(1400);
    expect(screen.queryByRole('button', { name: 'Jump to latest' })).toBeNull();
  });
});

describe('SessionView code blocks', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('offers a copy button on each code block that copies its text', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    render(
      <SessionView
        envelopes={[
          envelope(0, 'session.started', { cwd: '/w', prompt: 'p', label: 'p' }),
          envelope(1, 'claude.event', {
            engine: 'claude',
            raw: {
              type: 'assistant',
              message: { id: 'm1', content: [{ type: 'text', text: 'Run:\n\n```sh\npnpm test\n```\n' }] },
            },
          }),
        ]}
        onAnswer={vi.fn()}
        onSend={vi.fn()}
        onInterrupt={vi.fn()}
        onMode={vi.fn()}
        subscribeErrors={() => () => {}}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy code' }));
    });
    expect(writeText).toHaveBeenCalledWith('pnpm test');
    const copied = screen.getByRole('button', { name: 'Copied' });
    expect(copied.getAttribute('data-copied')).toBe('true');
    // A header row above the code names its language, so the button never covers a one-liner.
    expect(screen.getByText('sh').closest('[data-code-header]')).toBeTruthy();
  });
});

describe('SessionView battle results', () => {
  afterEach(() => cleanup());

  it('puts a folded result card under each turn, and a Quest summary when it closes', () => {
    render(
      <SessionView
        envelopes={[
          envelope(0, 'session.started', { cwd: '/w', prompt: 'p', label: 'p' }),
          envelope(1, 'claude.event', {
            engine: 'claude',
            raw: { type: 'result', subtype: 'success', is_error: false, duration_ms: 3000, total_cost_usd: 0.12 },
          }),
          envelope(2, 'session.closed', {}),
        ]}
        onAnswer={vi.fn()}
        onSend={vi.fn()}
        onInterrupt={vi.fn()}
        onMode={vi.fn()}
        subscribeErrors={() => () => {}}
      />,
    );
    expect(screen.getByText('Battle won').closest('details')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Quest complete' })).toBeTruthy();
  });
});

describe('SessionView latest battle result', () => {
  afterEach(() => cleanup());

  const result = (seq: number) =>
    envelope(seq, 'claude.event', {
      engine: 'claude',
      raw: { type: 'result', subtype: 'success', is_error: false, duration_ms: 3000, total_cost_usd: 0.1 * seq },
    });
  const props = {
    onAnswer: vi.fn(),
    onSend: vi.fn(),
    onInterrupt: vi.fn(),
    onMode: vi.fn(),
    subscribeErrors: () => () => {},
  };
  const twoTurns = [
    envelope(0, 'session.started', { cwd: '/w', prompt: 'p', label: 'p' }),
    result(1),
    envelope(2, 'user.message', { text: 'more' }),
    result(3),
  ];

  it('ends a Quest between turns on its latest result, open; earlier turns stay folded', () => {
    render(<SessionView envelopes={twoTurns} {...props} />);
    const cards = screen.getAllByText('Battle won').map((el) => el.closest('details')!);
    expect(cards.map((card) => card.open)).toEqual([false, true]);
    expect(screen.getAllByRole('region', { name: 'Battle won' })).toHaveLength(1);
  });

  it('folds it again once a new turn starts', () => {
    render(<SessionView envelopes={[...twoTurns, envelope(4, 'user.message', { text: 'again' })]} {...props} />);
    expect(screen.queryByRole('region', { name: 'Battle won' })).toBeNull();
  });
});

describe('SessionView in a split', () => {
  afterEach(() => cleanup());

  it('drops the side panels and their toggles when compact, and offers the split only when asked', () => {
    const props = {
      envelopes: [envelope(0, 'session.started', { cwd: '/w', prompt: 'p', label: 'p' })],
      onAnswer: vi.fn(),
      onSend: vi.fn(),
      onInterrupt: vi.fn(),
      onMode: vi.fn(),
      subscribeErrors: () => () => {},
    };
    const onSplit = vi.fn();
    render(<SessionView {...props} onSplit={onSplit} />);
    fireEvent.click(screen.getByRole('button', { name: /Split/ }));
    expect(onSplit).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Details' })).toBeTruthy();
    cleanup();

    render(<SessionView {...props} compact />);
    expect(screen.queryByRole('button', { name: /Split/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Details' })).toBeNull();
  });
});

describe('SessionView shell mode', () => {
  afterEach(() => cleanup());

  const started = (engine?: string) =>
    envelope(0, 'session.started', { cwd: '/w', prompt: 'p', label: 'p', ...(engine ? { engine } : {}) });

  it('marks a draft starting with ! as a shell command on an interactive Quest', () => {
    renderView([started('interactive')]);
    const box = screen.getByPlaceholderText('Send a follow-up');
    expect(screen.queryByRole('status', { name: 'Shell mode' })).toBeNull();
    fireEvent.change(box, { target: { value: '! git status' } });
    expect(screen.getByRole('status', { name: 'Shell mode' }).textContent).toContain('Command Rune');
    expect(box.getAttribute('data-shell')).toBe('true');
    expect(screen.getByRole('button', { name: 'Run' })).toBeTruthy();
  });

  it('leaves the box alone where ! is just text', () => {
    renderView([started()]);
    fireEvent.change(screen.getByPlaceholderText('Send a follow-up'), { target: { value: '! git status' } });
    expect(screen.queryByRole('status', { name: 'Shell mode' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy();
  });
});

describe('SessionView toolbar', () => {
  afterEach(() => cleanup());

  it('shows Quest actions as named icons, and puts the permission mode in the prompt box', () => {
    render(
      <SessionView
        envelopes={[envelope(0, 'session.started', { cwd: '/w', prompt: 'p', label: 'p' })]}
        onAnswer={vi.fn()}
        onSend={vi.fn()}
        onInterrupt={vi.fn()}
        onMode={vi.fn()}
        onFork={vi.fn()}
        subscribeErrors={() => () => {}}
      />,
    );
    for (const name of ['Fork', 'Close']) {
      const button = screen.getByRole('button', { name });
      expect(button.querySelector('svg')).toBeTruthy();
      expect(button.textContent).toBe('');
      expect(button.getAttribute('title')).toBeNull();
      const tip = document.getElementById(button.getAttribute('aria-describedby') ?? '');
      expect(tip?.getAttribute('role')).toBe('tooltip');
      expect(tip?.textContent).toBeTruthy();
      expect(button.querySelector('svg')?.classList.contains(`cb-icon-${name.toLowerCase()}`)).toBe(true);
    }
    const prompt = screen.getByPlaceholderText('Send a follow-up').closest('form');
    expect(screen.getByLabelText('Permission mode').closest('form')).toBe(prompt);
  });
});

describe('SessionView follow-up draft', () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  const props = {
    session: SESSION,
    onAnswer: () => {},
    onSend: () => {},
    onInterrupt: () => {},
    onMode: () => {},
    subscribeErrors: () => () => {},
  };
  const box = () => screen.getByPlaceholderText('Send a follow-up') as HTMLTextAreaElement;

  it('keeps the draft when the Quest is left and opened again', () => {
    const first = render(<SessionView envelopes={[]} {...props} />);
    fireEvent.change(box(), { target: { value: 'a long prompt' } });
    first.unmount();
    render(<SessionView envelopes={[]} {...props} />);
    expect(box().value).toBe('a long prompt');
  });

  it("doesn't replay a split's earlier Inventory pick over the draft when the pane opens again", () => {
    const pick = { text: '/compact ', seq: 1 };
    const first = render(<SessionView envelopes={[]} {...props} />);
    first.rerender(<SessionView envelopes={[]} {...props} insertion={pick} />);
    expect(box().value).toBe('/compact ');
    fireEvent.change(box(), { target: { value: '/compact and a long prompt' } });
    first.unmount();
    const again = render(<SessionView envelopes={[]} {...props} insertion={pick} />);
    expect(box().value).toBe('/compact and a long prompt');
    again.rerender(<SessionView envelopes={[]} {...props} insertion={{ text: '/review ', seq: 2 }} />);
    expect(box().value).toBe('/review ');
  });
});

describe('SessionView skills', () => {
  afterEach(() => cleanup());

  const claude = (seq: number, raw: unknown) => envelope(seq, 'claude.event', { engine: 'claude', raw });
  const skill: Envelope[] = [
    envelope(0, 'session.started', { cwd: '/tmp/FIXTURE', prompt: 'greet me', label: 'greet me' }),
    claude(1, {
      type: 'assistant',
      message: {
        id: 'm1',
        content: [{ type: 'tool_use', id: 'toolu_s', name: 'Skill', input: { skill: 'demo-skill' } }],
      },
    }),
    claude(2, {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_s', content: 'Launching skill: demo-skill' }] },
    }),
    claude(3, {
      type: 'user',
      isSynthetic: true,
      message: {
        content: [{ type: 'text', text: 'Base directory for this skill: /tmp/FIXTURE\n\n# Demo skill body' }],
      },
    }),
  ];

  it('announces a skill in one line and keeps its text folded away', () => {
    renderView(skill);
    const line = screen.getByText('Hero casts demo-skill!');
    expect(line.closest('details')?.open).toBe(false);
    expect(line.closest('details')?.textContent).toContain('# Demo skill body');
    expect(screen.queryByText('Skill', { selector: '.font-mono' })).toBeNull();
  });
});

describe('SessionView attachments', () => {
  afterEach(() => cleanup());

  it('sends picked files with the follow-up, with a line of its own when there is no text', async () => {
    const onSend = vi.fn();
    renderView([envelope(0, 'session.started', { cwd: '/w', prompt: 'p', label: 'p' })], undefined, undefined, onSend);
    const shot = new File(['png'], 'shot.png', { type: 'image/png' });
    fireEvent.change(screen.getByLabelText('Attach files'), { target: { files: [shot] } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(onSend).toHaveBeenCalled());
    expect(onSend).toHaveBeenCalledWith('See the attached files.', [
      { name: 'shot.png', type: 'image/png', data: btoa('png') },
    ]);
    expect(screen.queryByText('shot.png')).toBeNull();
  });

  it('shows the files a prompt carried as chips, not as raw lines', () => {
    renderView([
      envelope(0, 'session.started', { cwd: '/w', prompt: 'p', label: 'p' }),
      envelope(1, 'user.message', { text: 'Look\n\n[Attached file: /tmp/x/123-1-shot.png]' }),
    ]);
    expect(screen.getByText('Look')).toBeTruthy();
    expect(screen.getByTitle('/tmp/x/123-1-shot.png').textContent).toContain('shot.png');
    expect(screen.queryByText(/\[Attached file/)).toBeNull();
  });
});
