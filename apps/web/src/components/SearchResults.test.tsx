import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SearchResults } from './SearchResults.js';

const hit = (session: string, seq: number, label: string, text: string) => ({
  session,
  seq,
  label,
  event: { node: 'n', session, seq, ts: 0, type: 'user.message' as const, payload: { text } },
});

describe('SearchResults', () => {
  afterEach(() => cleanup());

  it('lists readable matches with their session, drops plumbing-only ones, and opens a session on click', () => {
    const onOpen = vi.fn();
    const plumbing = {
      session: 'c',
      seq: 1,
      label: 'Other',
      event: {
        node: 'n',
        session: 'c',
        seq: 1,
        ts: 0,
        type: 'claude.event' as const,
        payload: { engine: 'claude', raw: { type: 'system', cwd: '/flaky' } },
      },
    };
    render(
      <SearchResults
        query="flaky"
        hits={[hit('a', 3, 'Fix tests', 'the flaky login test'), plumbing]}
        onOpen={onOpen}
      />,
    );
    expect(screen.getByText('Fix tests')).toBeTruthy();
    expect(screen.getByText('the flaky login test')).toBeTruthy();
    expect(screen.queryByText('Other')).toBeNull();
    fireEvent.click(screen.getByText('Fix tests'));
    expect(onOpen).toHaveBeenCalledWith('a');
  });

  it('says when nothing matched', () => {
    render(<SearchResults query="zzz" hits={[]} onOpen={vi.fn()} />);
    expect(screen.getByText('No matches for “zzz”')).toBeTruthy();
  });
});
