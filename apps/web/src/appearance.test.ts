import { afterEach, describe, expect, it, vi } from 'vitest';
import { BANNER_COLOURS, KINGDOM_ICONS, iconPixels } from './theme/kingdomIcons.js';
import {
  fetchAppearance,
  loadCachedAppearance,
  lookFor,
  saveAppearance,
  tabStyle,
  withLook,
  withTabStyle,
} from './appearance.js';

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
    key: () => null,
    get length() {
      return data.size;
    },
  } as Storage;
}

describe('Kingdom icons', () => {
  it('are 16x16 grids using only palette keys', () => {
    expect(KINGDOM_ICONS.length).toBeGreaterThanOrEqual(8);
    for (const icon of KINGDOM_ICONS) {
      expect(icon.rows).toHaveLength(16);
      for (const row of icon.rows) expect(row).toMatch(/^[.osdlwbBgrRtTcCxmMnfF]{16}$/);
    }
  });

  it('paint banner and roof cells in the Kingdom colour, shaded cells darker', () => {
    const castle = KINGDOM_ICONS.find((i) => i.id === 'castle')!;
    const pixels = iconPixels(castle, '#3550c8');
    expect(pixels.some((p) => p.fill === '#3550c8')).toBe(true);
    expect(pixels.every((p) => p.x >= 0 && p.x < 16 && p.y >= 0 && p.y < 16)).toBe(true);
    const tower = KINGDOM_ICONS.find((i) => i.id === 'tower')!;
    expect(iconPixels(tower, '#ffffff').some((p) => p.fill === '#adadad')).toBe(true);
  });
});

describe('Kingdom looks', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('default to a stable look from the Kingdom id', () => {
    const a = lookFor({}, 'node-one');
    expect(lookFor({}, 'node-one')).toEqual(a);
    expect(KINGDOM_ICONS.some((i) => i.id === a.icon)).toBe(true);
    expect(BANNER_COLOURS.some((c) => c.hex === a.colour)).toBe(true);
  });

  it('use the user-s choices, falling back per field and for unknown icons or colours', () => {
    const appearance = { looks: { n: { icon: 'ship', colour: '#8a4fd0' }, m: { icon: 'nope' } } };
    expect(lookFor(appearance, 'n')).toEqual({ icon: 'ship', colour: '#8a4fd0' });
    expect(lookFor(appearance, 'm').icon).toBe(lookFor({}, 'm').icon);
    expect(tabStyle({})).toBe('underline');
    expect(tabStyle({ tabStyle: 'odd' })).toBe('underline');
  });

  it('change one field at a time', () => {
    const one = withLook({ tabStyle: 'tinted' }, 'n', { icon: 'spire' });
    const two = withLook(one, 'n', { colour: '#3550c8' });
    expect(withTabStyle(two, 'pennant')).toEqual({
      tabStyle: 'pennant',
      looks: { n: { icon: 'spire', colour: '#3550c8' } },
    });
  });

  it('caches locally so the UI draws before the hub answers, and saves to the hub', async () => {
    const storage = memoryStorage();
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    await saveAppearance({ tabStyle: 'tinted' }, storage);
    expect(loadCachedAppearance(storage)).toEqual({ tabStyle: 'tinted' });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/appearance',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ tabStyle: 'tinted' }) }),
    );
    storage.setItem('crystal-bridge.appearance', '{"looks":5}');
    expect(loadCachedAppearance(storage)).toEqual({});
  });

  it('loads the user-s appearance from the hub, ignoring a bad answer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ tabStyle: 'pennant' }))),
    );
    expect(await fetchAppearance()).toEqual({ tabStyle: 'pennant' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"looks":[1]}')),
    );
    expect(await fetchAppearance()).toBeUndefined();
  });
});
