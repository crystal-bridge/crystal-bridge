import { LEAVE_COMMAND, LEAVE_COMMAND_WINDOWS } from '@crystal-bridge/protocol';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemovedKingdom } from './RemovedKingdom.js';

describe('RemovedKingdom', () => {
  afterEach(() => cleanup());

  it('says how to uninstall the Kingdom from its machine, until dismissed', () => {
    const onDismiss = vi.fn();
    render(<RemovedKingdom name="forge" onDismiss={onDismiss} />);
    expect(screen.getByRole('status').textContent).toContain('forge');
    expect(screen.getByRole('status').textContent).toContain(LEAVE_COMMAND);
    expect(screen.getByRole('status').textContent).toContain(LEAVE_COMMAND_WINDOWS);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalled();
  });
});
