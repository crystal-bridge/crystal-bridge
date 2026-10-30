import { joinCommand } from '@crystal-bridge/protocol';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AddKingdom } from './AddKingdom.js';

const hub = 'https://hub.example.com';

function name(value: string) {
  fireEvent.change(screen.getByLabelText('Name for the new Kingdom'), { target: { value } });
  fireEvent.click(screen.getByRole('button', { name: 'Add Kingdom' }));
}

describe('AddKingdom', () => {
  afterEach(() => cleanup());

  it('makes a code and shows the one command to run on the new machine', async () => {
    const onCreate = vi.fn(async () => ({ code: 'CODE', expiresAt: 0 }));
    render(<AddKingdom hub={hub} onCreate={onCreate} />);
    name('forge');
    expect(onCreate).toHaveBeenCalledWith('forge');
    expect((await screen.findByLabelText('Install command')).textContent).toBe(joinCommand(hub, 'CODE'));
    expect(screen.getByText(/10 minutes/)).toBeTruthy();
  });

  it('copies the command', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<AddKingdom hub={hub} onCreate={async () => ({ code: 'CODE', expiresAt: 0 })} />);
    name('forge');
    fireEvent.click(await screen.findByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith(joinCommand(hub, 'CODE'));
  });

  it('refuses a name that could not be a node id, before asking the hub', () => {
    const onCreate = vi.fn();
    render(<AddKingdom hub={hub} onCreate={onCreate} />);
    name('bad name!');
    expect(onCreate).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(/letters, digits and dashes/);
  });

  it('shows what the hub said when it refuses', async () => {
    render(<AddKingdom hub={hub} onCreate={async () => Promise.reject(new Error('that name is taken'))} />);
    name('forge');
    expect((await screen.findByRole('alert')).textContent).toContain('that name is taken');
  });
});
