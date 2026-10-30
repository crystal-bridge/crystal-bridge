/**
 * The colours your own prompts can wear in the chat. A short list instead of a free picker, so none can be unreadable (a
 * test checks each pair), and muted, because the bright blue means something needs your attention. A fork can change
 * them here.
 */
export interface PromptColour {
  id: string;
  label: string;
  background: string;
  text: string;
}

export const PROMPT_COLOURS: readonly PromptColour[] = [
  { id: 'dusk', label: 'Dusk', background: '#5f4b8b', text: '#ffffff' },
  { id: 'lavender', label: 'Lavender', background: '#b8a6e6', text: '#1e1b2e' },
  { id: 'dracula', label: 'Dracula', background: '#bd93f9', text: '#282a36' },
  { id: 'slate', label: 'Slate', background: '#475569', text: '#ffffff' },
  { id: 'teal', label: 'Teal', background: '#2f6f6f', text: '#ffffff' },
  { id: 'rose', label: 'Rose', background: '#8a4a63', text: '#ffffff' },
  { id: 'blue', label: 'Blue', background: '#2563eb', text: '#ffffff' },
];

export const DEFAULT_PROMPT_COLOUR = 'dusk';

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((at) => {
    const channel = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** The WCAG contrast ratio of two colours. */
export function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light! + 0.05) / (dark! + 0.05);
}
