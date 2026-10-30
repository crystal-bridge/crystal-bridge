/**
 * Kingdom icons and banner colours: data, so new ones are a list entry. Each icon is an original 16x16 pixel grid
 * (source: tools/sprites/kingdoms/icons.py), drawn for Crystal Bridge, so it carries no licence strings. Letters are
 * palette keys; `b`/`r` (banner, roof) take the Kingdom's colour and `B`/`R` a darker shade of it.
 */
export interface KingdomIcon {
  id: string;
  label: string;
  rows: readonly string[];
}

export interface BannerColour {
  id: string;
  label: string;
  hex: string;
}

/** Fixed colours: outline, stone, windows, wood, crystal, mountain, snow, leaves. */
const PALETTE: Record<string, string> = {
  o: '#1c1828',
  s: '#b0b0be',
  d: '#808092',
  l: '#d6d6e0',
  w: '#2e283c',
  g: '#f0c846',
  t: '#aa7040',
  T: '#784c2c',
  c: '#6ec8ff',
  C: '#3278dc',
  x: '#dcf5ff',
  m: '#8c96aa',
  M: '#646c82',
  n: '#f5f8ff',
  f: '#5aaa50',
  F: '#387838',
};

export const KINGDOM_ICONS: readonly KingdomIcon[] = [
  {
    id: 'castle',
    label: 'Castle',
    rows: [
      '......ob........',
      '......obb.......',
      '......ob........',
      '......o.........',
      'o.o.oosoo.o.o...',
      'ososlsssdsososo.',
      'ossssssssdssso..',
      '.osssssssdsso...',
      '.oslsowwosdso...',
      '.osssowwossso...',
      '.oslsowwosdso...',
      '.osssowwossso...',
      '.osssowwosdso...',
      '.oooooooooooo...',
      '................',
      '................',
    ],
  },
  {
    id: 'tower',
    label: 'Tower',
    rows: [
      '......ob........',
      '......obbb......',
      '......obB.......',
      '......o.........',
      '.....oroo.......',
      '....orrRRo......',
      '...orrrRRRo.....',
      '..oooooooooo....',
      '...oslssdso.....',
      '...osswwsdo.....',
      '...oslwwsdo.....',
      '...ossssdso.....',
      '...oslswwdo.....',
      '...osssswwo.....',
      '...oooooooo.....',
      '................',
    ],
  },
  {
    id: 'fortress',
    label: 'Fortress',
    rows: [
      '...ob......ob...',
      '...obb.....obb..',
      '...ob......ob...',
      '..oso.....oso...',
      '.ossso...ossso..',
      '.oslso.o.oslso..',
      '.osssooooosdso..',
      '.oslsssssssdso..',
      '.osssssssssdso..',
      '.oslssowwosdso..',
      '.osssowwwwosso..',
      '.oslsowwwwosdo..',
      '.oooooooooooooo.',
      '................',
      '................',
      '................',
    ],
  },
  {
    id: 'spire',
    label: 'Crystal spire',
    rows: [
      '.......o........',
      '......oxo.......',
      '......oxco......',
      '.....oxccCo.....',
      '.....oxcCCo.....',
      '......oCCo......',
      '.......oo.......',
      '......osso......',
      '.....obsdbo.....',
      '.....oBsdBo.....',
      '.....oslsdo.....',
      '.....osssdo.....',
      '....oslwwsdo....',
      '....osswwsdo....',
      '....oooooooo....',
      '................',
    ],
  },
  {
    id: 'hold',
    label: 'Mountain hold',
    rows: [
      '................',
      '......oo........',
      '.....onno.......',
      '....onmmMo......',
      '...ommmmMMo.....',
      '..ommmobmMMo....',
      '..ommmobbMMMo...',
      '.ommmmobMMMMo...',
      '.ommmoosooMMMo..',
      'ommmmoswsoMMMMo.',
      'ommmmoswsoMMMMo.',
      'oooooooooooooooo',
      '................',
      '................',
      '................',
      '................',
    ],
  },
  {
    id: 'cottage',
    label: 'Cottage',
    rows: [
      '................',
      '..........oo....',
      '......oooooTo...',
      '.....orrrrrRo...',
      '....orrrrrrRRo..',
      '...orrrrrrrRRRo.',
      '..oooooooooooooo',
      '...otttttttTTo..',
      '...otwwtttwwTo..',
      '...otwwtotwwTo..',
      '...otttowotTTo..',
      '...otttowotTTo..',
      '...oooooooooooo.',
      '................',
      '................',
      '................',
    ],
  },
  {
    id: 'treefort',
    label: 'Tree fort',
    rows: [
      '.....ooooo......',
      '...ooffffFoo....',
      '..offfffffFFo...',
      '.offfffffffFFo..',
      '.offfobbofffFo..',
      '.offfotTofffFo..',
      '..offotTofffo...',
      '...oooooooooo...',
      '....otwwtTTo....',
      '....ottttTTo....',
      '....oooTToo.....',
      '......oTTo......',
      '......oTTo......',
      '.....oTTTTo.....',
      '....oooooooo....',
      '................',
    ],
  },
  {
    id: 'ship',
    label: 'Ship',
    rows: [
      '.......o........',
      '.......ob.......',
      '.......obb......',
      '......oobbb.....',
      '......o.bbbb....',
      '......o.BBBB....',
      '......o.........',
      '.oooooooooooooo.',
      '.otttttttttttTo.',
      '..otwtttwtttTo..',
      '...otttttttTo...',
      '....oooooooo....',
      '................',
      '................',
      '................',
      '................',
    ],
  },
];

export const BANNER_COLOURS: readonly BannerColour[] = [
  { id: 'crimson', label: 'Crimson', hex: '#d23c46' },
  { id: 'royal', label: 'Royal', hex: '#3550c8' },
  { id: 'emerald', label: 'Emerald', hex: '#2f9e5a' },
  { id: 'gold', label: 'Gold', hex: '#d9a020' },
  { id: 'violet', label: 'Violet', hex: '#8a4fd0' },
  { id: 'teal', label: 'Teal', hex: '#1f9aa6' },
  { id: 'ember', label: 'Ember', hex: '#e06a2a' },
  { id: 'rose', label: 'Rose', hex: '#d0508a' },
  { id: 'slate', label: 'Slate', hex: '#5a6478' },
];

/** A colour scaled towards black, for the shaded side of banners and roofs. */
export function shade(hex: string, k = 0.68): string {
  const n = parseInt(hex.slice(1), 16);
  const part = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v * k)))
      .toString(16)
      .padStart(2, '0');
  return `#${part(n >> 16)}${part((n >> 8) & 255)}${part(n & 255)}`;
}

/** The filled cells of an icon in a Kingdom's colour, ready to draw as 1x1 rects. */
export function iconPixels(icon: KingdomIcon, colour: string): { x: number; y: number; fill: string }[] {
  const dark = shade(colour);
  const pal: Record<string, string> = { ...PALETTE, b: colour, r: colour, B: dark, R: dark };
  const out: { x: number; y: number; fill: string }[] = [];
  icon.rows.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      const fill = pal[ch];
      if (fill) out.push({ x, y, fill });
    });
  });
  return out;
}
