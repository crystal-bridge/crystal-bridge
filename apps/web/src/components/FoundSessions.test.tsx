import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FoundSessions } from './FoundSessions.js';

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const found = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    cwd: '/home/me/code/app',
    title: 'Fix the login test',
    updatedAt: NOW - 30_000,
    messages: 12,
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    cwd: '/home/me/code/site',
    title: 'Write the README',
    updatedAt: NOW - 3 * 60 * MIN,
    messages: 4,
  },
];

describe('FoundSessions', () => {
  afterEach(() => cleanup());

  it('lists sessions found outside the bridge with their folder and age', () => {
    render(<FoundSessions name="node-b" sessions={found} connected onAdopt={vi.fn()} now={NOW} />);
    expect(screen.getByText('Found on node-b')).toBeTruthy();
    expect(screen.getByText('Fix the login test')).toBeTruthy();
    expect(screen.getByText('app · just now')).toBeTruthy();
    expect(screen.getByText('site · 3h00m ago')).toBeTruthy();
  });

  it('asks before adopting, and warns when a session changed in the last two minutes', () => {
    const onAdopt = vi.fn();
    render(<FoundSessions name="node-b" sessions={found} connected onAdopt={onAdopt} now={NOW} />);

    fireEvent.click(screen.getByText('Fix the login test'));
    expect(screen.getByText(/may still be open in a terminal/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Adopt' }));
    expect(onAdopt).toHaveBeenCalledWith(found[0]!.id);

    fireEvent.click(screen.getByText('Write the README'));
    expect(screen.queryByText(/may still be open in a terminal/)).toBeNull();
  });

  it('offers the Kingdom-s engines when it runs more than one, and adopts on the chosen one', () => {
    const onAdopt = vi.fn();
    render(
      <FoundSessions
        name="mac"
        sessions={found}
        connected
        engines={['stream', 'interactive']}
        onAdopt={onAdopt}
        now={NOW}
      />,
    );
    fireEvent.click(screen.getByText('Write the README'));
    fireEvent.change(screen.getByLabelText('Engine'), { target: { value: 'interactive' } });
    fireEvent.click(screen.getByRole('button', { name: 'Adopt' }));
    expect(onAdopt).toHaveBeenCalledWith(found[1]!.id, 'interactive');
  });

  it('adopts on the default engine with no choice when the Kingdom runs only one', () => {
    const onAdopt = vi.fn();
    render(<FoundSessions name="vm" sessions={found} connected onAdopt={onAdopt} now={NOW} />);
    fireEvent.click(screen.getByText('Write the README'));
    expect(screen.queryByLabelText('Engine')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Adopt' }));
    expect(onAdopt).toHaveBeenCalledWith(found[1]!.id);
  });

  it('disables adopting while the Kingdom is offline', () => {
    render(<FoundSessions name="node-b" sessions={found} connected={false} onAdopt={vi.fn()} now={NOW} />);
    fireEvent.click(screen.getByText('Fix the login test'));
    expect((screen.getByRole('button', { name: 'Adopt' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('renders nothing when there are none', () => {
    const { container } = render(<FoundSessions name="x" sessions={[]} connected onAdopt={vi.fn()} now={NOW} />);
    expect(container.textContent).toBe('');
  });
});
