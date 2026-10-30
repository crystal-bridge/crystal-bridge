import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Envelope } from '@crystal-bridge/protocol';
import { SessionView } from './SessionView.js';

const SESSION = '11111111-1111-4111-8111-111111111111';
let seq = 0;
const env = (type: Envelope['type'], payload: unknown): Envelope => ({
  node: 'n',
  session: SESSION,
  seq: seq++,
  ts: 0,
  type,
  payload,
});
const raw = (r: unknown) => env('claude.event', { engine: 'claude', raw: r });

function quest(): Envelope[] {
  seq = 0;
  return [
    env('session.started', { cwd: '/r', prompt: 'p', label: 'p' }),
    raw({
      type: 'assistant',
      message: {
        id: 'm1',
        content: [{ type: 'tool_use', id: 't1', name: 'Write', input: { file_path: '/r/src/new.ts', content: 'x' } }],
      },
    }),
    raw({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }),
    raw({
      type: 'assistant',
      message: {
        id: 'm2',
        content: [
          {
            type: 'text',
            text: 'Read `docs/OPEN-SOURCE.md`, see [the handoff](docs/HANDOFF.md), [the web](https://example.com), and run `pnpm test`.',
          },
        ],
      },
    }),
  ];
}

function view(onOpenFile = vi.fn(), fileViewer?: React.ReactNode) {
  render(
    <SessionView
      session={SESSION}
      envelopes={quest()}
      onAnswer={vi.fn()}
      onSend={vi.fn()}
      onInterrupt={vi.fn()}
      onMode={vi.fn()}
      subscribeErrors={() => () => {}}
      onOpenFile={onOpenFile}
      fileViewer={fileViewer}
    />,
  );
  return onOpenFile;
}

describe('SessionView file entry points', () => {
  afterEach(() => cleanup());

  it('opens file names in replies and relative links, but leaves other code and web links alone', () => {
    const onOpenFile = view();
    fireEvent.click(screen.getByRole('button', { name: 'docs/OPEN-SOURCE.md' }));
    fireEvent.click(screen.getByRole('button', { name: 'the handoff' }));
    expect(onOpenFile.mock.calls).toEqual([['docs/OPEN-SOURCE.md'], ['docs/HANDOFF.md']]);
    expect(screen.queryByRole('button', { name: 'pnpm test' })).toBeNull();
    expect(screen.getByRole('link', { name: 'the web' }).getAttribute('target')).toBe('_blank');
  });

  it('opens the file a tool wrote from its card, and from Loot in the side panel', () => {
    const onOpenFile = view();
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    const details = screen.getByRole('complementary', { name: 'Session details' });
    fireEvent.click(within(details).getByRole('button', { name: 'src/new.ts' }));
    expect(onOpenFile.mock.calls).toEqual([['/r/src/new.ts'], ['/r/src/new.ts']]);
  });

  it('shows the open file in place of the side panel', () => {
    view(vi.fn(), <div>the viewer</div>);
    expect(screen.getByText('the viewer').closest('aside')).toBeTruthy();
    expect(screen.queryByRole('complementary', { name: 'Session details' })).toBeNull();
  });

  it('shows file names as plain code when nothing can open them', () => {
    render(
      <SessionView
        session={SESSION}
        envelopes={quest()}
        onAnswer={vi.fn()}
        onSend={vi.fn()}
        onInterrupt={vi.fn()}
        onMode={vi.fn()}
        subscribeErrors={() => () => {}}
      />,
    );
    expect(screen.queryByRole('button', { name: 'docs/OPEN-SOURCE.md' })).toBeNull();
    expect(screen.getByText('docs/OPEN-SOURCE.md').tagName).toBe('CODE');
  });
});
