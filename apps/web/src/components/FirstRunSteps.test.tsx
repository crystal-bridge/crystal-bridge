import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FirstRunSteps } from './FirstRunSteps.js';

function renderSteps() {
  const props = {
    onName: vi.fn(async () => undefined),
    onCreateJoinCode: vi.fn(async () => ({ code: 'join-code', expiresAt: 1 })),
    onDone: vi.fn(),
  };
  render(<FirstRunSteps {...props} />);
  return props;
}

describe('FirstRunSteps', () => {
  afterEach(() => cleanup());

  it('names the hub, then gives the command for the first Kingdom, then finishes', async () => {
    const props = renderSteps();
    fireEvent.change(screen.getByLabelText('Hub name'), { target: { value: 'Home fleet' } });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(props.onName).toHaveBeenCalledWith('Home fleet');

    fireEvent.change(await screen.findByLabelText(/Name for the new/), { target: { value: 'forge' } });
    fireEvent.click(screen.getByRole('button', { name: /^Add / }));
    expect((await screen.findByLabelText('Install command')).textContent).toContain('join-code');

    fireEvent.click(screen.getByRole('button', { name: 'Finish' }));
    expect(props.onDone).toHaveBeenCalled();
  });

  it('can skip both steps', async () => {
    const props = renderSteps();
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    expect(props.onName).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'Finish' }));
    expect(props.onDone).toHaveBeenCalled();
  });

  it('stays on the name step and says why when the hub refuses it', async () => {
    const props = renderSteps();
    props.onName.mockRejectedValueOnce(new Error('use at most 40 characters'));
    fireEvent.change(screen.getByLabelText('Hub name'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect((await screen.findByRole('alert')).textContent).toContain('40 characters');
    expect(screen.getByLabelText('Hub name')).toBeTruthy();
  });
});
