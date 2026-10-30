import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { HeroManifest } from '../heroes.js';
import { HeroSprite } from './HeroSprite.js';

const manifest: HeroManifest = {
  leader: 'paladin',
  fallback: 'paladin',
  classes: {
    paladin: {
      name: 'Paladin',
      match: [],
      work: 'slash',
      verb: 'Smite',
      victory: 'emote',
      anims: { idle: { frames: 2, size: 64 }, slash: { frames: 6, size: 128 } },
    },
  },
};

describe('HeroSprite', () => {
  afterEach(() => cleanup());

  it('names the Hero and its state for assistive tech, and marks what it draws', () => {
    render(<HeroSprite manifest={manifest} classId="paladin" state="working" size={28} />);
    const sprite = screen.getByRole('img', { name: 'Paladin, Smite' });
    expect(sprite.getAttribute('data-class')).toBe('paladin');
    expect(sprite.getAttribute('data-state')).toBe('working');
    expect(sprite.getAttribute('width')).toBe('28');
  });

  it('describes resting, needing you, victory and KO plainly', () => {
    const { rerender } = render(<HeroSprite manifest={manifest} classId="paladin" state="alert" />);
    expect(screen.getByRole('img', { name: 'Paladin, needs you' })).toBeTruthy();
    rerender(<HeroSprite manifest={manifest} classId="paladin" state="ko" />);
    expect(screen.getByRole('img', { name: 'Paladin, failed' })).toBeTruthy();
  });

  it('draws nothing for a Class the pack doesn-t have', () => {
    const { container } = render(<HeroSprite manifest={manifest} classId="nobody" state="resting" />);
    expect(container.innerHTML).toBe('');
  });
});
