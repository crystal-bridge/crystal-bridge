import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Credits } from './Credits.js';

const CSV =
  'filename,notes,authors,licenses,urls\nbody/a.png,,"Ann One,Bob Two","OGA-BY 3.0,CC-BY-SA 3.0",https://x.example/a\n';

describe('Credits', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('loads the art credits only when opened, then names the artists, layers and fonts', async () => {
    const fetch = vi.fn(async () => new Response(CSV));
    vi.stubGlobal('fetch', fetch);
    render(<Credits />);
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Credits'));
    await waitFor(() => expect(screen.getAllByText(/Ann One, Bob Two/)).toHaveLength(2));
    expect(fetch).toHaveBeenCalledWith('/heroes/CREDITS.csv');
    expect(screen.getByText('body/a.png')).toBeTruthy();
    expect(screen.getByText(/used under OGA-BY 3.0/)).toBeTruthy();
    expect(screen.getByText(/offered as OGA-BY 3.0, CC-BY-SA 3.0/)).toBeTruthy();
    expect(screen.getByText(/JetBrains Mono/)).toBeTruthy();
  });

  it('credits the icon packs, naming each Game-icons artist', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(CSV)),
    );
    render(<Credits />);
    const icons = screen.getByRole('heading', { name: 'Icons' }).parentElement!;
    expect(icons.textContent).toContain('Game-icons, by Caro Asercion, Delapouite, Lorc and Skoll (CC BY 3.0)');
    expect(icons.textContent).toContain('Phosphor Icons (MIT)');
    expect(icons.querySelector('a[href="https://game-icons.net"]')).toBeTruthy();
  });
});
