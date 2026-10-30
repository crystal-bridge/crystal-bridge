import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileViewer, type FileViewState } from './FileViewer.js';

const SESSION = '11111111-1111-4111-8111-111111111111';
const REQ = '22222222-2222-4222-8222-222222222222';

function file(requested: string, reply?: Partial<NonNullable<FileViewState['reply']>>): FileViewState {
  return {
    session: SESSION,
    requested,
    reply: reply ? { kind: 'file', requestId: REQ, ok: true, ...reply } : undefined,
  };
}

describe('FileViewer', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows the file is opening, then renders markdown with its size', () => {
    const { rerender } = render(<FileViewer file={file('docs/A.md')} onClose={vi.fn()} />);
    expect(screen.getByText('Opening…')).toBeTruthy();
    rerender(
      <FileViewer
        file={file('docs/A.md', { path: 'docs/A.md', content: '# Title\n\nBody', size: 2048 })}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Title' })).toBeTruthy();
    expect(screen.getByText('2.0 KB')).toBeTruthy();
  });

  it('shows other text as a code block named by its language, and says when it was cut', () => {
    render(
      <FileViewer
        file={file('src/a.ts', { path: 'src/a.ts', content: 'export const a = 1;', size: 900_000, truncated: true })}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText('export const a = 1;')).toBeTruthy();
    expect(screen.getByText('ts').closest('[data-code-header]')).toBeTruthy();
    expect(screen.getByText(/showing the start only/)).toBeTruthy();
  });

  it('says plainly why a file can-t be opened', () => {
    render(<FileViewer file={file('../x', { ok: false, reason: "outside this Quest's folder" })} onClose={vi.fn()} />);
    expect(screen.getByText(/Can't open this file: outside this Quest's folder/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Copy contents' })).toBeNull();
  });

  it('copies the path and the contents', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    render(<FileViewer file={file('a.txt', { path: 'a.txt', content: 'hello', size: 5 })} onClose={vi.fn()} />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Copy path' })));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Copy contents' })));
    expect(writeText.mock.calls).toEqual([['a.txt'], ['hello']]);
  });

  it('takes focus when it opens, gives it back when it closes, and closes on Esc', () => {
    const before = document.createElement('button');
    document.body.append(before);
    before.focus();
    const onClose = vi.fn();
    const { unmount } = render(<FileViewer file={file('a.txt')} onClose={onClose} />);
    expect(document.activeElement?.getAttribute('role')).toBe('region');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
    unmount();
    expect(document.activeElement).toBe(before);
    before.remove();
  });

  it('opens a markdown link relative to the file it is in', () => {
    const onOpen = vi.fn();
    render(
      <FileViewer
        file={file('docs/guide/A.md', { path: 'docs/guide/A.md', content: 'See [B](../B.md).', size: 18 })}
        onClose={vi.fn()}
        onOpen={onOpen}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'B' }));
    expect(onOpen).toHaveBeenCalledWith('docs/B.md');
  });
});
