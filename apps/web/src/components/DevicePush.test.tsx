import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DevicePush } from './DevicePush.js';

describe('DevicePush', () => {
  afterEach(() => cleanup());

  it('shows nothing where the browser has no Web Push', () => {
    const { container } = render(<DevicePush state="unsupported" onChange={vi.fn()} />);
    expect(container.textContent).toBe('');
  });

  it('turns push on and off for this device', () => {
    const onChange = vi.fn();
    const { rerender } = render(<DevicePush state="off" onChange={onChange} />);
    const toggle = screen.getByRole('checkbox', { name: 'Push to this device' }) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith(true);

    rerender(<DevicePush state="on" onChange={onChange} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Push to this device' }));
    expect(onChange).toHaveBeenLastCalledWith(false);
  });

  it('waits while a change is in flight, and says why one failed', () => {
    render(<DevicePush state="busy" error="Web Push is not set up on the hub" onChange={vi.fn()} />);
    expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText('Web Push is not set up on the hub')).toBeTruthy();
  });

  it('explains how to unblock notifications the browser blocked', () => {
    render(<DevicePush state="blocked" onChange={vi.fn()} />);
    expect(screen.getByText(/blocked/i)).toBeTruthy();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });
});
