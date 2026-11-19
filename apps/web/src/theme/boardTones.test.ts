import { describe, expect, it } from 'vitest';
import {
  actionTone,
  CHIP_CLASSES,
  markToneClass,
  MARK_TONES,
  projectTone,
  SENDER_TONES,
  senderTone,
  toneChipClass,
} from './boardTones.js';

describe('senderTone', () => {
  it('gives one address the same colour every time, whatever its case or spacing', () => {
    expect(senderTone('ada@example.com')).toBe(senderTone(' Ada@Example.com '));
  });

  it('spreads addresses across the palette', () => {
    const tones = new Set(Array.from({ length: 60 }, (_, i) => senderTone(`person${i}@example.com`)));
    expect(tones.size).toBeGreaterThanOrEqual(SENDER_TONES.length - 2);
  });
});

describe('actionTone', () => {
  it('colours an action by its key where the palette names one, else by its kind', () => {
    expect(actionTone('archive', 'run')).toBe('slate');
    expect(actionTone('spam', 'run')).toBe('red');
    expect(actionTone('follow-up', 'quest')).toBe('violet');
    expect(actionTone('later', 'snooze')).toBe('amber');
    expect(actionTone('done', 'done')).toBe('emerald');
    expect(actionTone('open', 'link')).toBe('sky');
    expect(actionTone('tidy', 'run')).toBe('blue');
    // A key that names something on Object.prototype is no tone.
    expect(actionTone('constructor', 'dismiss')).toBe('rose');
  });
});

describe('mark tones', () => {
  it('colours a mark as text, with slate for an unknown tone', () => {
    expect(markToneClass('red')).toContain('text-red-');
    expect(markToneClass('nope')).toBe(markToneClass('slate'));
    expect(markToneClass('constructor')).toBe(markToneClass('slate'));
    expect(markToneClass(undefined)).toBe(markToneClass('slate'));
  });

  it('colours a project like a sender, by its name', () => {
    expect(projectTone('acme/lantern')).toBe(senderTone('acme/lantern'));
  });

  it('has a chip for every tone, with slate for an unknown one', () => {
    expect(toneChipClass('nope')).toBe(toneChipClass('slate'));
    for (const tone of MARK_TONES) expect(toneChipClass(tone), tone).toBeTruthy();
    expect(new Set(MARK_TONES).size).toBe(MARK_TONES.length);
    expect(CHIP_CLASSES.slate).toBe(toneChipClass('slate'));
  });
});
