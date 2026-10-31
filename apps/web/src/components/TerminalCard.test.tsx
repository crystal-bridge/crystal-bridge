import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TerminalCard } from './TerminalCard.js';

describe('TerminalCard', () => {
  afterEach(() => cleanup());

  it('shows the screen with its layout', () => {
    render(<TerminalCard text={'  Pick one\n  1. Yes'} held={false} onKeys={vi.fn()} />);
    expect(screen.getByLabelText('Terminal screen').textContent).toBe('  Pick one\n  1. Yes');
  });

  it.each([
    ['Up', '\x1b[A'],
    ['Down', '\x1b[B'],
    ['Left', '\x1b[D'],
    ['Right', '\x1b[C'],
    ['Enter', '\r'],
    ['Esc', '\x1b'],
    ['2', '2'],
  ])('sends %s as the terminal expects it', (name, keys) => {
    const onKeys = vi.fn();
    render(<TerminalCard text="x" held={false} onKeys={onKeys} />);
    fireEvent.click(screen.getByRole('button', { name }));
    expect(onKeys).toHaveBeenCalledWith({ keys });
  });

  it('types text and presses Enter, then clears the field', () => {
    const onKeys = vi.fn();
    render(<TerminalCard text="x" held={false} onKeys={onKeys} />);
    const field = screen.getByLabelText('Type into the terminal') as HTMLInputElement;
    fireEvent.change(field, { target: { value: 'my-token' } });
    fireEvent.click(screen.getByRole('button', { name: 'Type' }));
    expect(onKeys).toHaveBeenCalledWith({ keys: 'my-token\r' });
    expect(field.value).toBe('');
  });

  it('sends nothing for an empty field', () => {
    const onKeys = vi.fn();
    render(<TerminalCard text="x" held={false} onKeys={onKeys} />);
    fireEvent.click(screen.getByRole('button', { name: 'Type' }));
    expect(onKeys).not.toHaveBeenCalled();
  });

  it('offers the held message only when there is one', () => {
    const onKeys = vi.fn();
    const { rerender } = render(<TerminalCard text="x" held={false} onKeys={onKeys} />);
    expect(screen.queryByRole('button', { name: 'Send my message again' })).toBeNull();
    rerender(<TerminalCard text="x" held onKeys={onKeys} />);
    fireEvent.click(screen.getByRole('button', { name: 'Send my message again' }));
    expect(onKeys).toHaveBeenCalledWith({ retype: true });
  });
});
