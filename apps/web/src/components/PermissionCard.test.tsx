import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionCard } from './PermissionCard.js';

afterEach(cleanup);

const input = { command: 'touch crystal.txt' };

describe('PermissionCard', () => {
  it('says when it expired, with its buttons off', () => {
    render(<PermissionCard toolName="Bash" input={input} pending={false} expired onAnswer={() => {}} />);
    expect(screen.getByText(/^Expired/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('wraps a long command, so a phone shows all of what is being approved', () => {
    render(<PermissionCard toolName="Bash" input={input} pending onAnswer={() => {}} />);
    const shown = screen.getByText(/touch crystal\.txt/);
    expect(shown.className).toContain('whitespace-pre-wrap');
    expect(shown.className).toContain('[overflow-wrap:anywhere]');
    expect(shown.className).not.toContain('overflow-x-auto');
  });

  it('shows the tool name and input', () => {
    render(<PermissionCard toolName="Bash" input={input} pending onAnswer={() => {}} />);
    expect(screen.getByText('Bash')).toBeTruthy();
    expect(screen.getByText(/touch crystal\.txt/)).toBeTruthy();
  });

  it('calls onAnswer("allow") on Approve', () => {
    const onAnswer = vi.fn();
    render(<PermissionCard toolName="Bash" input={input} pending onAnswer={onAnswer} />);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onAnswer).toHaveBeenCalledWith('allow');
  });

  it('calls onAnswer("deny") on Deny', () => {
    const onAnswer = vi.fn();
    render(<PermissionCard toolName="Bash" input={input} pending onAnswer={onAnswer} />);
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    expect(onAnswer).toHaveBeenCalledWith('deny');
  });

  it('disables both buttons when not pending', () => {
    const onAnswer = vi.fn();
    render(<PermissionCard toolName="Bash" input={input} pending={false} behavior="allow" onAnswer={onAnswer} />);
    const approve = screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement;
    const deny = screen.getByRole('button', { name: 'Deny' }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    expect(deny.disabled).toBe(true);
    fireEvent.click(approve);
    fireEvent.click(deny);
    expect(onAnswer).not.toHaveBeenCalled();
  });
});
