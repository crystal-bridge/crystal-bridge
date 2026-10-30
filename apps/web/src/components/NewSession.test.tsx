import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NewSession } from './NewSession.js';

describe('NewSession', () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it('puts the prompt in the prompt box, with Permission Mode and Engine side by side in its bar', () => {
    render(
      <NewSession
        node="mac"
        name="mac"
        connected
        projects={[]}
        engines={['stream', 'interactive']}
        onStart={vi.fn()}
      />,
    );
    const box = screen.getByLabelText('Prompt').closest('.cb-prompt');
    expect(box).toBeTruthy();
    expect(screen.getByLabelText('Permission mode').closest('.cb-prompt')).toBe(box);
    expect(screen.getByLabelText('Engine').closest('.cb-prompt')).toBe(box);
    expect(screen.getByRole('button', { name: 'Start' }).closest('.cb-prompt')).toBe(box);
  });

  describe('starting from the keyboard', () => {
    const ready = () => {
      const onStart = vi.fn();
      render(<NewSession node="mac" name="mac" connected projects={[]} initialCwd="/w" onStart={onStart} />);
      fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Fix the test' } });
      return { onStart, box: screen.getByLabelText('Prompt') };
    };

    for (const key of ['metaKey', 'ctrlKey']) {
      it(`starts the Quest on ${key} and Enter, and only once`, () => {
        const { onStart, box } = ready();
        fireEvent.keyDown(box, { key: 'Enter', [key]: true });
        expect(onStart).toHaveBeenCalledOnce();
        expect(onStart.mock.calls[0]![0]).toMatchObject({ cwd: '/w', prompt: 'Fix the test' });
      });
    }

    it('leaves plain Enter and Shift+Enter as new lines', () => {
      const { onStart, box } = ready();
      expect(fireEvent.keyDown(box, { key: 'Enter' })).toBe(true);
      expect(fireEvent.keyDown(box, { key: 'Enter', shiftKey: true })).toBe(true);
      expect(onStart).not.toHaveBeenCalled();
    });

    it('does nothing until Start can', () => {
      const onStart = vi.fn();
      render(<NewSession node="mac" name="mac" connected projects={[]} onStart={onStart} />);
      fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'No project yet' } });
      fireEvent.keyDown(screen.getByLabelText('Prompt'), { key: 'Enter', metaKey: true });
      expect(onStart).not.toHaveBeenCalled();
    });

    it('lets an input method confirm its text without starting', () => {
      const { onStart, box } = ready();
      fireEvent.keyDown(box, { key: 'Enter', metaKey: true, isComposing: true });
      expect(onStart).not.toHaveBeenCalled();
    });

    it('names the shortcut on Start, as this platform writes it', () => {
      const platform = vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
      render(<NewSession node="mac" name="mac" connected projects={[]} onStart={vi.fn()} />);
      expect(screen.getByRole('button', { name: 'Start' }).title).toBe('Start (⌘ Enter)');
      cleanup();
      platform.mockReturnValue('Win32');
      render(<NewSession node="mac" name="mac" connected projects={[]} onStart={vi.fn()} />);
      expect(screen.getByRole('button', { name: 'Start' }).title).toBe('Start (Ctrl Enter)');
      platform.mockRestore();
    });
  });

  it('labels its fields in the theme style', () => {
    render(<NewSession node="mac" name="mac" connected projects={[]} onStart={vi.fn()} />);
    expect(screen.getByText('Project', { selector: 'span' }).className).toContain('cb-label');
    expect(screen.getByText('Prompt', { selector: 'span' }).className).toContain('cb-label');
  });

  it('keeps the unsent prompt and folder when the view is left and reopened, per Kingdom, until Start', () => {
    const onStart = fill();
    cleanup(); // e.g. switching to another tab in the app unmounts the form
    render(<NewSession node="node-b" name="node-b" connected projects={[]} onStart={onStart} />);
    expect((screen.getByLabelText('Prompt') as HTMLTextAreaElement).value).toBe('Fix the login test');
    expect((screen.getByLabelText('Project') as HTMLInputElement).value).toBe('/home/me/code/app');
    cleanup();

    render(<NewSession node="node-c" name="node-c" connected projects={[]} onStart={onStart} />);
    expect((screen.getByLabelText('Prompt') as HTMLTextAreaElement).value).toBe('');
    cleanup();

    render(<NewSession node="node-b" name="node-b" connected projects={[]} onStart={onStart} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    cleanup();
    render(<NewSession node="node-b" name="node-b" connected projects={[]} onStart={onStart} />);
    expect((screen.getByLabelText('Prompt') as HTMLTextAreaElement).value).toBe('');
  });

  function fill(onStart = vi.fn()) {
    render(<NewSession node="node-b" name="node-b" connected projects={[]} onStart={onStart} />);
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: '/home/me/code/app' } });
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Fix the login test' } });
    return onStart;
  }

  it('starts at the CLI default effort unless one is picked, and remembers the pick on this device', () => {
    const onStart = fill();
    expect(screen.getByLabelText('Effort').closest('.cb-prompt')).toBe(
      screen.getByLabelText('Prompt').closest('.cb-prompt'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(onStart.mock.calls[0]![0]).not.toHaveProperty('effort');
    cleanup();

    const onHigh = fill();
    fireEvent.change(screen.getByLabelText('Effort'), { target: { value: 'high' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(onHigh).toHaveBeenCalledWith(expect.objectContaining({ effort: 'high' }));
    cleanup();
    fill();
    expect((screen.getByLabelText('Effort') as HTMLSelectElement).value).toBe('high');
  });

  it('starts with the files attached to the prompt', async () => {
    const onStart = fill();
    const log = new File(['boom'], 'error.log', { type: 'text/plain' });
    fireEvent.change(screen.getByLabelText('Attach files'), { target: { files: [log] } });
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(onStart).toHaveBeenCalled());
    expect(onStart).toHaveBeenCalledWith(
      expect.objectContaining({ attachments: [{ name: 'error.log', type: 'text/plain', data: btoa('boom') }] }),
    );
  });

  it('starts in the project folder itself by default', () => {
    const onStart = fill();
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/home/me/code/app', worktree: false }));
  });

  it('offers the interactive engine only on a Kingdom that runs it, and sends the choice', () => {
    const onStart = fill();
    expect(screen.queryByLabelText('Engine')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(onStart.mock.calls[0]![0]).not.toHaveProperty('engine');
    cleanup();

    const onInteractive = vi.fn();
    render(
      <NewSession
        node="mac"
        name="mac"
        connected
        projects={[]}
        engines={['stream', 'interactive']}
        onStart={onInteractive}
      />,
    );
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: '/w' } });
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'p' } });
    fireEvent.change(screen.getByLabelText('Engine'), { target: { value: 'interactive' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(onInteractive).toHaveBeenCalledWith(expect.objectContaining({ engine: 'interactive' }));
  });

  it('can start in a separate worktree instead', () => {
    const onStart = fill();
    fireEvent.click(screen.getByLabelText(/Separate worktree/));
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ worktree: true }));
  });
});
