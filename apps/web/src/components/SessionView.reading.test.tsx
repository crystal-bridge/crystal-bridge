import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Envelope } from '@crystal-bridge/protocol';
import { SessionView } from './SessionView.js';

const SESSION = '11111111-1111-4111-8111-111111111111';
const TS = Date.UTC(2026, 9, 29, 14, 5);

function envelope(seq: number, type: Envelope['type'], payload: unknown): Envelope {
  return { node: 'node-a', session: SESSION, seq, ts: TS + seq * 1000, type, payload };
}
const started = envelope(0, 'session.started', { cwd: '/w', prompt: 'hello', label: 'hello' });
const assistant = (seq: number, text: string) =>
  envelope(seq, 'claude.event', {
    engine: 'claude',
    raw: { type: 'assistant', message: { id: `m${seq}`, content: [{ type: 'text', text }] } },
  });
const result = (seq: number) =>
  envelope(seq, 'claude.event', {
    engine: 'claude',
    raw: { type: 'result', subtype: 'success', is_error: false, result: 'ok', duration_ms: 10, total_cost_usd: 0.01 },
  });

function view(envelopes: Envelope[]) {
  return render(
    <SessionView
      envelopes={envelopes}
      onAnswer={vi.fn()}
      onSend={vi.fn()}
      onInterrupt={vi.fn()}
      onMode={vi.fn()}
      subscribeErrors={() => () => {}}
    />,
  );
}

describe('SessionView reading and controls', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders GitHub-flavoured markdown: tables, and links that open in a new tab', () => {
    view([started, assistant(1, '| a | b |\n|---|---|\n| 1 | 2 |\n\nSee https://example.com/docs')]);
    expect(screen.getByRole('table')).toBeTruthy();
    const link = screen.getByRole('link', { name: 'https://example.com/docs' });
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
  });

  it('copies a whole reply as its markdown', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    view([started, assistant(1, 'Hello **there**')]);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy reply' }));
    });
    expect(writeText).toHaveBeenCalledWith('Hello **there**');
  });

  it('shows when each message was sent, on hover', () => {
    view([started, assistant(1, 'hi back')]);
    const sent = new Date(TS).toLocaleString();
    expect(screen.getByText('hello').closest('[title]')?.getAttribute('title')).toBe(sent);
    expect(screen.getByText('hi back').closest('[title]')?.getAttribute('title')).toBe(
      new Date(TS + 1000).toLocaleString(),
    );
  });

  it('offers Stop only while a turn is running', () => {
    const stop = () => screen.queryByRole('button', { name: 'Stop' });
    view([started]);
    expect(stop()).toBeTruthy();
    cleanup();
    view([started, assistant(1, 'done'), result(2)]);
    expect(stop()).toBeNull();
    cleanup();
    view([started, assistant(1, 'done'), result(2), envelope(3, 'user.message', { text: 'more' })]);
    expect(stop()).toBeTruthy();
  });
});
