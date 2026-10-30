import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NewSession } from './NewSession.js';

describe('NewSession', () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
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
