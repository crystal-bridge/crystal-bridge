import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mermaid = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn() }));
vi.mock('mermaid', () => ({ default: mermaid }));

const { handleMessage, mermaidConfig } = await import('./mermaidFrame.js');

/** Mermaid's own `secure` keys, from the installed release, so an upgrade that adds one fails here until it's copied. */
const actual = await vi.importActual<typeof import('mermaid')>('mermaid');
const MERMAID_SECURE = actual.default.mermaidAPI.defaultConfig.secure ?? [];

describe('mermaidConfig', () => {
  it("knows Mermaid's own secure keys", () => {
    expect(MERMAID_SECURE).toContain('securityLevel');
  });

  it("runs Mermaid at its strict level, and a diagram's init block can't set styles or fonts", () => {
    const config = mermaidConfig('light');
    expect(config.securityLevel).toBe('strict');
    expect(config.startOnLoad).toBe(false);
    expect(config.secure).toEqual(
      expect.arrayContaining([
        ...MERMAID_SECURE,
        'themeCSS',
        'themeVariables',
        'fontFamily',
        'altFontFamily',
        'fontSize',
      ]),
    );
  });

  it('draws with the dark theme in the dark', () => {
    expect(mermaidConfig('dark').theme).toBe('dark');
    expect(mermaidConfig('light').theme).toBe('default');
  });
});

describe('handleMessage', () => {
  let posted: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    mermaid.initialize.mockReset();
    mermaid.render.mockReset();
    posted = vi.spyOn(window.parent, 'postMessage').mockImplementation(() => undefined);
  });
  afterEach(() => {
    posted.mockRestore();
    document.body.innerHTML = '';
  });

  const render = { type: 'render', id: 'd1', source: 'graph TD; A-->B', theme: 'light' };

  it('ignores a message from anything but the parent', async () => {
    const frame = document.createElement('iframe');
    document.body.append(frame);
    await handleMessage(new MessageEvent('message', { data: render, source: frame.contentWindow }));
    await handleMessage(new MessageEvent('message', { data: render, source: null }));
    expect(mermaid.render).not.toHaveBeenCalled();
    expect(posted).not.toHaveBeenCalled();
  });

  it("ignores the parent's messages that aren't a render", async () => {
    await handleMessage(new MessageEvent('message', { data: { type: 'render', id: 'd1' }, source: window.parent }));
    await handleMessage(new MessageEvent('message', { data: 'graph TD; A-->B', source: window.parent }));
    expect(mermaid.render).not.toHaveBeenCalled();
    expect(posted).not.toHaveBeenCalled();
  });

  it('draws the source in its own page and tells the parent only the height', async () => {
    mermaid.render.mockResolvedValue({ svg: '<svg id="drawn"></svg>' });
    await handleMessage(new MessageEvent('message', { data: render, source: window.parent }));
    expect(mermaid.initialize).toHaveBeenCalledWith(mermaidConfig('light'));
    expect(mermaid.render).toHaveBeenCalledWith(expect.any(String), 'graph TD; A-->B');
    expect(document.getElementById('drawn')).not.toBeNull();
    expect(posted).toHaveBeenCalledWith({ type: 'height', id: 'd1', height: expect.any(Number) }, '*');
  });

  it("reports the diagram's own height, so the frame shrinks after a smaller diagram", async () => {
    // The page's height never goes below the frame's viewport: a frame grown for a tall diagram would stay tall.
    const scrollHeight = vi.spyOn(document.documentElement, 'scrollHeight', 'get').mockReturnValue(680);
    const target = document.createElement('div');
    target.id = 'diagram';
    document.body.append(target);
    const heights = [64.2, 680, 64.2];
    const rect = vi
      .spyOn(target, 'getBoundingClientRect')
      .mockImplementation(() => ({ height: heights.shift() ?? 0 }) as DOMRect);
    mermaid.render.mockResolvedValue({ svg: '<svg></svg>' });
    try {
      for (const id of ['d1', 'd2', 'd3'])
        await handleMessage(new MessageEvent('message', { data: { ...render, id }, source: window.parent }));
      expect(posted.mock.calls.map(([message]: unknown[]) => (message as { height: number }).height)).toEqual([
        65, 680, 65,
      ]);
    } finally {
      scrollHeight.mockRestore();
      rect.mockRestore();
    }
  });

  it("tells the parent a diagram's error", async () => {
    mermaid.render.mockRejectedValue(new Error('Parse error on line 1'));
    await handleMessage(new MessageEvent('message', { data: render, source: window.parent }));
    expect(posted).toHaveBeenCalledWith({ type: 'error', id: 'd1', message: 'Parse error on line 1' }, '*');
  });
});
