import { cleanup, render, screen } from '@testing-library/react';
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
});
