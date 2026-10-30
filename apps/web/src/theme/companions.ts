/**
 * Side Quest companions (#20): original 16x16 pixel familiars drawn for Crystal Bridge, like the Kingdom icons, so they
 * carry no licence strings. Each is written as its left half and mirrored. Letters are palette keys; `.` is clear.
 * Picked in the "Quest UI Audition": a Monitor gets the Owl (it keeps watch); a background command gets one of the
 * others, the same one every time for a given task. Data, so a theme can swap or add companions.
 */
import type { SessionTask } from '../info.js';

export interface Companion {
  name: string;
  palette: Record<string, string>;
  rows: readonly string[];
}

/** A row's left half, mirrored into the full 16 columns. */
function mirror(halves: string[]): string[] {
  return halves.map((half) => half + [...half].reverse().join(''));
}

const E = '........';

export const COMPANIONS: Record<string, Companion> = {
  owl: {
    name: 'Owl',
    palette: {
      o: '#1c1828',
      b: '#8a5a3a',
      B: '#5e3a22',
      c: '#ecd8ac',
      y: '#f6e7a0',
      k: '#1c1828',
      g: '#f0a830',
      f: '#f0a830',
    },
    rows: mirror([
      E,
      '...oo...',
      '...obo..',
      '...obboo',
      '..obbbbb',
      '..obyyyb',
      '..obykyb',
      '..obyyyg',
      '..obbbbg',
      '..oBbccc',
      '.oBBbcBc',
      '.oBBbccc',
      '..oBbcBc',
      '...oBccc',
      '....ofoo',
      E,
    ]),
  },
  fox: {
    name: 'Fox',
    palette: { o: '#1c1828', r: '#e0702c', R: '#a8461a', w: '#f6eee2' },
    rows: mirror([
      E,
      '.o......',
      '.oo.....',
      '.oRo....',
      '.oRro...',
      '.orrrooo',
      '..orrrrr',
      '..orrorr',
      '..owrrrr',
      '...owwrr',
      '....owww',
      '.....owo',
      '......oo',
      E,
      E,
      E,
    ]),
  },
  cat: {
    name: 'Cat',
    palette: { o: '#1c1828', a: '#7a7486', A: '#4e4a5a', w: '#eeeaf2', e: '#8ee06a', n: '#f08aa0' },
    rows: mirror([
      E,
      '..o.....',
      '..oo....',
      '..oAo...',
      '..oaaooo',
      '..oaaaaa',
      '..oaeoaa',
      '..oaeeaa',
      '..oawwwn',
      '...oawww',
      '....oaaa',
      '...oaaww',
      '...oaaww',
      '...oAaoo',
      E,
      E,
    ]),
  },
  bat: {
    name: 'Bat',
    palette: { o: '#1c1828', p: '#7a5cb0', P: '#4a3478', e: '#ffd75e', f: '#ffffff' },
    rows: mirror([
      E,
      E,
      '.....o..',
      '....opo.',
      'o...oppo',
      'oo..oppp',
      'opo.opep',
      'oppoPppp',
      'opppPPpp',
      'oPPoPppf',
      'oP..oPpp',
      'o....oPP',
      '......oo',
      E,
      E,
      E,
    ]),
  },
  slime: {
    name: 'Slime',
    palette: { o: '#1c1828', g: '#5ec46e', G: '#3a8a4a', l: '#c2f5ae', e: '#ffffff', k: '#1c1828' },
    rows: mirror([
      E,
      E,
      E,
      E,
      '......oo',
      '....oogl',
      '...oggll',
      '..oggggl',
      '.oggeekg',
      '.oggeekg',
      '.oGggggg',
      '.oGGgggg',
      '..oGGGGG',
      '...ooooo',
      E,
      E,
    ]),
  },
  wisp: {
    name: 'Wisp',
    palette: { o: '#1c1828', c: '#6ec8ff', C: '#3278dc', x: '#e6f8ff' },
    rows: mirror([
      E,
      '.......o',
      '......oc',
      '......ox',
      '.....ocx',
      '....occx',
      '...occxx',
      '...ocxxx',
      '..occxox',
      '..ocxxxx',
      '..oCcxxx',
      '...oCccc',
      '....oCCc',
      '.....ooo',
      E,
      E,
    ]),
  },
};

/** Who keeps watch on a Monitor. */
const WATCHER = 'owl';
/** Who can go along on a background command. */
const ERRAND = ['wisp', 'fox', 'cat', 'bat', 'slime'];

/** A small stable hash of a task id. */
function hash(id: string): number {
  let h = 2166136261;
  for (const ch of id) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

/** The companion that goes along on a Side Quest. */
export function companionFor(task: Pick<SessionTask, 'id' | 'kind'>): string {
  if (task.kind === 'monitor') return WATCHER;
  return ERRAND[hash(task.id) % ERRAND.length]!;
}
