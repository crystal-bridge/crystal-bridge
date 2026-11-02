import type { ComponentProps } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HeroManifest } from '../heroes.js';
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
    expect(screen.getByText('Project', { selector: 'span.cb-label' })).toBeTruthy();
  });

  it('keeps the prompt, folder and files after Start: the Quest may yet not start', async () => {
    const onStart = fill();
    const log = new File(['boom'], 'error.log', { type: 'text/plain' });
    fireEvent.change(screen.getByLabelText('Attach files'), { target: { files: [log] } });
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(onStart).toHaveBeenCalled());
    expect((screen.getByLabelText('Prompt') as HTMLTextAreaElement).value).toBe('Fix the login test');
    expect((screen.getByLabelText('Project') as HTMLInputElement).value).toBe('/home/me/code/app');
    expect(screen.getByText('error.log')).toBeTruthy();
    cleanup();
    render(<NewSession node="node-b" name="node-b" connected projects={[]} onStart={onStart} />);
    expect((screen.getByLabelText('Prompt') as HTMLTextAreaElement).value).toBe('Fix the login test');
    expect((screen.getByLabelText('Project') as HTMLInputElement).value).toBe('/home/me/code/app');
  });

  it('says it is starting, and takes no second start meanwhile', () => {
    const onStart = vi.fn();
    render(<NewSession node="mac" name="mac" connected projects={[]} initialCwd="/w" starting onStart={onStart} />);
    expect(screen.getByText(/Setting out|Starting/).getAttribute('role')).toBe('status');
    const box = screen.getByLabelText('Prompt') as HTMLTextAreaElement;
    expect(box.disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Start' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    expect(onStart).not.toHaveBeenCalled();
  });

  it('starts only once while files are being read', async () => {
    const onStart = fill();
    const log = new File(['boom'], 'error.log', { type: 'text/plain' });
    fireEvent.change(screen.getByLabelText('Attach files'), { target: { files: [log] } });
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    fireEvent.keyDown(screen.getByLabelText('Prompt'), { key: 'Enter', metaKey: true });
    await waitFor(() => expect(onStart).toHaveBeenCalled());
    expect(onStart).toHaveBeenCalledOnce();
  });

  it('keeps the unsent prompt and folder when the view is left and reopened, per Kingdom', () => {
    const onStart = fill();
    cleanup(); // e.g. switching to another tab in the app unmounts the form
    render(<NewSession node="node-b" name="node-b" connected projects={[]} onStart={onStart} />);
    expect((screen.getByLabelText('Prompt') as HTMLTextAreaElement).value).toBe('Fix the login test');
    expect((screen.getByLabelText('Project') as HTMLInputElement).value).toBe('/home/me/code/app');
    cleanup();

    render(<NewSession node="node-c" name="node-c" connected projects={[]} onStart={onStart} />);
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

  it('says so when a file can-t be read, rather than doing nothing', async () => {
    const onStart = fill();
    const log = new File(['boom'], 'error.log', { type: 'text/plain' });
    vi.spyOn(FileReader.prototype, 'readAsDataURL').mockImplementation(function (this: FileReader) {
      this.dispatchEvent(new ProgressEvent('error'));
    });
    fireEvent.change(screen.getByLabelText('Attach files'), { target: { files: [log] } });
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/couldn't be read/);
    expect(onStart).not.toHaveBeenCalled();
    vi.restoreAllMocks();
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

  describe('laid out like a running Quest', () => {
    const LISTED = [
      {
        engine: 'claude',
        raw: {
          type: 'system',
          subtype: 'init',
          skills: ['deploy'],
          slash_commands: ['deploy', 'compact'],
          agents: ['claude', 'reviewer'],
        },
      },
      { engine: 'claude', raw: { type: 'system', subtype: 'descriptions', descriptions: { deploy: 'Ship it' } } },
    ];
    const open = (props: Partial<ComponentProps<typeof NewSession>> = {}) => {
      const listInventory = vi.fn(async () => LISTED);
      render(
        <NewSession
          node="mac"
          name="mac"
          connected
          projects={[]}
          onStart={vi.fn()}
          belt={[{ text: '/deploy ', label: 'deploy', now: true }, ...Array.from({ length: 7 }, () => null)]}
          onBeltChange={vi.fn()}
          listInventory={listInventory}
          listDelayMs={0}
          {...props}
        />,
      );
      return { listInventory };
    };
    const prompt = () => screen.getByLabelText('Prompt') as HTMLTextAreaElement;

    it('draws the Inventory and Details panels, each with its toolbar toggle', () => {
      open();
      expect(screen.getByRole('complementary', { name: 'Inventory' })).toBeTruthy();
      expect(screen.getByRole('complementary', { name: 'Session details' })).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Details' }));
      expect(screen.queryByRole('complementary', { name: 'Session details' })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Details' }));
      fireEvent.click(screen.getByRole('button', { name: 'Inventory' }));
      expect(screen.queryByRole('complementary', { name: 'Inventory' })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Inventory' }));
    });

    it('lists the Kingdom live, for the project picked, and says where the list came from', async () => {
      const { listInventory } = open();
      expect(await screen.findByRole('button', { name: 'deploy' })).toBeTruthy();
      expect(listInventory).toHaveBeenCalledWith('', expect.any(AbortSignal));
      expect(screen.getByText(/Live from mac/)).toBeTruthy();
      fireEvent.change(screen.getByLabelText('Project'), { target: { value: '/w' } });
      await waitFor(() => expect(listInventory).toHaveBeenCalledWith('/w', expect.any(AbortSignal)));
    });

    it('says so when the Kingdom can-t list, and asks nothing of one that is offline', async () => {
      open({ listInventory: vi.fn(async () => Promise.reject(new Error('no'))) });
      expect(await screen.findByText(/appears once the/)).toBeTruthy();
      cleanup();
      const { listInventory } = open({ connected: false });
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(listInventory).not.toHaveBeenCalled();
    });

    it('puts a pick in front of the brief rather than over it', async () => {
      open();
      fireEvent.change(prompt(), { target: { value: 'a long brief' } });
      fireEvent.click(await screen.findByRole('button', { name: 'deploy' }));
      expect(prompt().value).toBe('/deploy a long brief');
      fireEvent.click(screen.getByRole('button', { name: 'deploy' }));
      expect(prompt().value).toBe('/deploy a long brief');
    });

    it('fills the prompt from a Belt slot set to send at once: it starts nothing', () => {
      const onStart = vi.fn();
      open({ onStart, initialCwd: '/w' });
      fireEvent.keyDown(window, { code: 'Digit1', altKey: true });
      expect(prompt().value).toBe('/deploy ');
      expect(onStart).not.toHaveBeenCalled();
    });

    it('suggests slash commands, and Enter takes one rather than making a new line', async () => {
      open();
      await screen.findByRole('button', { name: 'deploy' });
      fireEvent.change(prompt(), { target: { value: '/dep' } });
      expect(screen.getByRole('option', { name: '/deploy' })).toBeTruthy();
      expect(fireEvent.keyDown(prompt(), { key: 'Enter' })).toBe(false);
      expect(prompt().value).toBe('/deploy ');
      expect(fireEvent.keyDown(prompt(), { key: 'Enter' })).toBe(true);
    });

    it('names no leader on a Kingdom that picks one per Quest', () => {
      const manifest = { leader: 'paladin', classes: { paladin: { name: 'Paladin', verb: 'guarding' } } };
      open({ manifest: manifest as unknown as HeroManifest, variedLeader: true });
      const party = within(screen.getByRole('region', { name: 'Party' }));
      expect(party.getByText(/chosen when the .* starts/i)).toBeTruthy();
      expect(party.queryByText(/Paladin/)).toBeNull();
    });

    it('fills the side panel from the choices so far, and claims nothing yet', () => {
      open({ initialCwd: '/w' });
      const details = within(screen.getByRole('complementary', { name: 'Session details' }));
      expect(details.getByText('/w')).toBeTruthy();
      expect(details.getAllByText(/once the .* starts/).length).toBeGreaterThan(0);
      expect(details.queryByText('$0.00')).toBeNull();
      fireEvent.change(screen.getByLabelText('Effort'), { target: { value: 'high' } });
      expect(details.getByText('High')).toBeTruthy();
    });
  });
});
