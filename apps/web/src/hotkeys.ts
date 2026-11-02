import { w } from './theme/words.js';

/**
 * The app's global keys: one table, so a customisable keymap can replace it later. Browsers keep Ctrl+1-9, Cmd+1-9,
 * Ctrl+Tab, Ctrl+W and Alt+Left, Chrome keeps Alt+D, Alt+E and Alt+F, and the app already uses Alt+1-8 for the Belt and
 * Alt+arrows to move a focused tab, so none of those are here.
 */
export type HotkeyAction =
  | 'next-quest'
  | 'prev-quest'
  | 'next-kingdom'
  | 'prev-kingdom'
  | 'kingdom'
  | 'needs-you'
  | 'new-quest'
  | 'home'
  | 'keys';

export interface Hotkey {
  action: HotkeyAction;
  /** `KeyboardEvent.code`: by position, since on a Mac Alt and a letter types a character, and layouts differ. */
  code: string;
  shift?: boolean;
  /** For `kingdom`: which one, from 0. */
  index?: number;
  /** What it does, in the theme's words. */
  what: () => string;
}

export const HOTKEYS: readonly Hotkey[] = [
  { action: 'next-quest', code: 'KeyJ', what: () => `Next ${w('quest')} in this ${w('kingdom')}` },
  { action: 'prev-quest', code: 'KeyK', what: () => `Previous ${w('quest')} in this ${w('kingdom')}` },
  { action: 'next-kingdom', code: 'KeyJ', shift: true, what: () => `Next ${w('kingdom')}` },
  { action: 'prev-kingdom', code: 'KeyK', shift: true, what: () => `Previous ${w('kingdom')}` },
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((digit): Hotkey => ({
    action: 'kingdom',
    code: `Digit${digit}`,
    shift: true,
    index: digit - 1,
    what: () => `${w('kingdom')} ${digit}`,
  })),
  { action: 'needs-you', code: 'KeyA', what: () => `Next ${w('quest')} needing you, on any ${w('kingdom')}` },
  { action: 'new-quest', code: 'KeyN', what: () => w('newQuest') },
  { action: 'home', code: 'KeyH', what: () => w('home') },
  { action: 'keys', code: 'Slash', what: () => 'List these keys' },
];

/** What open dialogs and pickers are made of: the keys stand down while one has the user's attention. */
const OPEN_PICKER = '[role="dialog"], [role="listbox"]';

export function pickerOpen(): boolean {
  return document.querySelector(OPEN_PICKER) !== null;
}

/**
 * The table's entry for a key press, if any. AltGr types characters on many layouts and arrives as Ctrl+Alt on Windows,
 * so it's checked by name as well as by the Ctrl check; composition belongs to the IME.
 */
export function hotkeyFor(event: KeyboardEvent): Hotkey | undefined {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return undefined;
  if (event.getModifierState('AltGraph')) return undefined;
  return HOTKEYS.find((key) => key.code === event.code && Boolean(key.shift) === event.shiftKey);
}

/** The next or previous id, wrapping at the ends; with nothing current, the end the direction starts from. */
export function step(ids: readonly string[], current: string | null, by: 1 | -1): string | undefined {
  const at = current === null ? -1 : ids.indexOf(current);
  if (at < 0) return by === 1 ? ids[0] : ids.at(-1);
  return ids[(at + by + ids.length) % ids.length];
}

/** The Quest that has waited longest, among those this device shows. */
export function needsYouNext(
  waiting: Readonly<Record<string, string>>,
  sessions: readonly { id: string; node: string; lastActivity?: number | undefined; createdAt: number }[],
  shown: ReadonlySet<string>,
): { node: string; session: string } | undefined {
  const oldest = sessions
    .filter((session) => session.id in waiting && shown.has(session.node))
    .sort((a, b) => (a.lastActivity ?? a.createdAt) - (b.lastActivity ?? b.createdAt))[0];
  return oldest && { node: oldest.node, session: oldest.id };
}

const isMac = (): boolean => /mac/i.test(navigator.platform);

/** The modifiers as this platform writes them. */
export function modifiers(shift: boolean | undefined, mac = isMac()): string {
  if (mac) return shift ? '⌥⇧' : '⌥';
  return shift ? 'Alt+Shift+' : 'Alt+';
}

/** A key as this platform writes it, such as `Alt+Shift+J` or `⌥⇧J`. */
export function hotkeyText(key: Pick<Hotkey, 'code' | 'shift'>, mac = isMac()): string {
  const name = key.code === 'Slash' ? '/' : key.code.replace(/^(Key|Digit)/, '');
  return `${modifiers(key.shift, mac)}${name}`;
}

/** An action's key, for a tooltip. */
export function keyHint(action: HotkeyAction): string {
  const key = HOTKEYS.find((entry) => entry.action === action);
  return key ? ` (${hotkeyText(key)})` : '';
}
