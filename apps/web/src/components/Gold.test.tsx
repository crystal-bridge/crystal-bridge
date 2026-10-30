import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { goldText } from '../format.js';
import { Gold } from './Gold.js';

describe('goldText', () => {
  it('counts one coin per US cent, grouped by locale', () => {
    expect(goldText(1.18, 'en-US')).toBe('118');
    expect(goldText(100.82, 'en-US')).toBe('10,082');
    expect(goldText(0, 'en-US')).toBe('0');
  });

  it("says under one coin rather than zero, so a cheap turn doesn't read as free", () => {
    expect(goldText(0.004, 'en-US')).toBe('<1');
  });
});

describe('Gold', () => {
  afterEach(() => cleanup());

  it('shows coins, with the dollar figure behind a small info button that also works by tap', () => {
    render(<Gold usd={100.82} />);
    expect(screen.getByText(/10,082/)).toBeTruthy();
    const info = screen.getByRole('button', { name: 'Gold in US dollars' });
    expect(screen.getByRole('tooltip').textContent).toContain('$100.82');
    expect(info.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(info);
    expect(info.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('$100.82', { selector: '.cb-gold-usd' })).toBeTruthy();
  });

  it('can leave out the info button where space is tight, keeping the dollars in the tooltip text', () => {
    render(<Gold usd={1.18} compact />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('118 Gold').getAttribute('title')).toContain('$1.18');
  });
});
