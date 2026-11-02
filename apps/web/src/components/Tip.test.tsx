import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Tip } from './Tip.js';

describe('Tip', () => {
  afterEach(() => cleanup());

  it('describes its anchor with a themed tooltip instead of the browser title', () => {
    render(
      <Tip text="Fork: copy this conversation">
        <button type="button" aria-label="Fork" />
      </Tip>,
    );
    const button = screen.getByRole('button', { name: 'Fork' });
    const tip = screen.getByRole('tooltip');
    expect(tip.textContent).toBe('Fork: copy this conversation');
    expect(button.getAttribute('aria-describedby')).toBe(tip.id);
    expect(button.getAttribute('title')).toBeNull();
  });

  it('lines the tooltip up with its anchor as asked', () => {
    render(
      <Tip text="Close" align="end">
        <button type="button" aria-label="Close" />
      </Tip>,
    );
    expect(screen.getByRole('tooltip').getAttribute('data-align')).toBe('end');
  });

  describe('beside its anchor', () => {
    const place = (top: number, bottom: number) => {
      render(
        <Tip text="Words" beside>
          <button type="button">Row</button>
        </Tip>,
      );
      const anchor = screen.getByRole('button', { name: 'Row' }).parentElement!;
      anchor.getBoundingClientRect = () => ({ top, bottom, right: 200 }) as DOMRect;
      fireEvent.pointerEnter(anchor);
      return screen.getByRole('tooltip', { hidden: true });
    };

    it('lines up with the anchor-s top in the upper half of the screen', () => {
      const tip = place(100, 140);
      expect(tip.hasAttribute('data-beside')).toBe(true);
      expect(tip.style.left).toBe('208px');
      expect(tip.style.top).toBe('100px');
      expect(tip.style.bottom).toBe('');
    });

    it('opens upward from the anchor-s bottom in the lower half', () => {
      const tip = place(window.innerHeight - 60, window.innerHeight - 20);
      expect(tip.style.bottom).toBe('20px');
      expect(tip.style.top).toBe('');
    });
  });
});
