/**
 * The Library's sandboxes in a real browser (docs/LIBRARY.md, "Prove it first", item 3): an HTML Tome in the app's
 * frame reaches no other site and none of the app's storage, the same page opened directly downloads, a page answer
 * that keeps `frame-ancestors 'none'` leaves the frame blank, and a Mermaid diagram's `%%{init}%%` can't load styles or
 * fonts. The hubs, the fake Kingdom and the recording "elsewhere" server are in sandbox-hub.ts.
 */
import { expect, test, type Page } from '@playwright/test';
import { NODE, type SandboxWorld, type Seen } from './sandbox-hub.js';

const world = JSON.parse(process.env.SANDBOX_WORLD ?? 'null') as SandboxWorld;

/** Long enough for a late request (a preconnect, a font, a STUN retry) to arrive after the page says it's done. */
const SETTLE_MS = 2000;

const seen = async (): Promise<Seen> => (await fetch(world.control)).json() as Promise<Seen>;
const settled = async (): Promise<Seen> => {
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
  return seen();
};
const pageRoute = (file: string) => `/api/nodes/${NODE}/library/page?path=${encodeURIComponent(file)}`;

test.beforeEach(async () => {
  await fetch(`${world.control}/reset`, { method: 'POST' });
});

/**
 * Opens the hub's app, then frames `src` as the app will: `sandbox="allow-scripts"` and nothing else. Messages the frame
 * posts to its parent collect in `window.fromFrame`.
 */
async function frameOnHub(page: Page, hub: string, src: string): Promise<void> {
  await page.goto(hub);
  await page.evaluate((frameSrc) => {
    const frame = document.createElement('iframe');
    frame.id = 'under-test';
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.style.cssText = 'position:fixed;inset:0;width:800px;height:600px;z-index:9999;background:white';
    const messages: unknown[] = [];
    (window as unknown as { fromFrame: unknown[] }).fromFrame = messages;
    window.addEventListener('message', (event) => {
      if (event.source === frame.contentWindow) messages.push(event.data);
    });
    frame.src = frameSrc;
    document.body.append(frame);
  }, src);
}

/** The first message from the frame of this type, once it comes. */
async function fromFrame<T>(page: Page, type: string, timeout = 15_000): Promise<T> {
  const handle = await page.waitForFunction(
    (wanted) =>
      (window as unknown as { fromFrame: { type?: string }[] }).fromFrame.find((message) => message.type === wanted),
    type,
    { timeout },
  );
  return (await handle.jsonValue()) as T;
}

const framedFrom = (state: Seen, hub: string) =>
  state.pages.filter((request) => request.hub === hub).map(({ dest, site }) => ({ dest, site }));

test('the recorder sees what an unconfined page sends: HTTP, TCP and STUN', async ({ page }) => {
  // The control for every "no requests" below: the same attempts from the app's own page, which no sandbox confines.
  await page.goto(world.openHub);
  const candidates = await page.evaluate(
    async ({ elsewhere, stun }) => {
      await fetch(`${elsewhere}/control/fetch`, { mode: 'no-cors' }).catch(() => undefined);
      const peer = new RTCPeerConnection({ iceServers: [{ urls: `stun:${stun}` }] });
      const found: string[] = [];
      await new Promise<void>((resolve) => {
        peer.onicecandidate = (event) => {
          if (event.candidate) found.push(event.candidate.type ?? 'unknown');
          else resolve();
        };
        peer.createDataChannel('out');
        void peer.createOffer().then((offer) => peer.setLocalDescription(offer));
        setTimeout(resolve, 4000);
      });
      peer.close();
      return found;
    },
    { elsewhere: world.elsewhere, stun: world.stun },
  );
  const state = await settled();
  expect(state.requests).toContain('GET /control/fetch');
  expect(state.connections).toBeGreaterThan(0);
  expect(state.datagrams, `ICE candidates: ${candidates.join(',') || 'none'}`).toBeGreaterThan(0);
});

test("an HTML Tome in the app's frame makes no HTTP request and reaches no storage or popup", async ({ page }) => {
  await frameOnHub(page, world.openHub, pageRoute('reaching-out.html'));
  const { report } = await fromFrame<{ report: Record<string, unknown> }>(page, 'report');
  const state = await settled();

  expect(framedFrom(state, 'open')).toEqual([{ dest: 'iframe', site: 'same-origin' }]);
  expect(state.requests).toEqual([]);
  expect(report.origin).toBe('null');
  expect(report.localStorage).toMatchObject({ threw: true, error: 'SecurityError' });
  expect(report.cookie).toMatchObject({ threw: true, error: 'SecurityError' });
  expect(report.popup).toEqual({ threw: false, value: 'null' });
  expect(report.fetch).toMatch(/^failed/);
  expect(report.xhr).toBe('failed');
  expect(page.context().pages()).toHaveLength(1);
  // Known gaps, recorded rather than failed: docs/LIBRARY.md, "Open the sealed pages", says what a page can still reach.
  test
    .info()
    .annotations.push(
      { type: 'known-gap', description: `WebRTC STUN datagrams: ${state.datagrams} (${String(report.rtc)})` },
      { type: 'known-gap', description: `TCP connections without a request (preconnect): ${state.connections}` },
    );
});

test('the same page opened directly at its address downloads instead of rendering', async ({ page }) => {
  const download = page.waitForEvent('download');
  await page.goto(`${world.openHub}${pageRoute('reaching-out.html')}`).catch(() => undefined);
  expect((await download).suggestedFilename()).toBe('reaching-out.html');
  const state = await settled();

  expect(framedFrom(state, 'open')).toEqual([{ dest: 'document', site: 'none' }]);
  expect(state.requests).toEqual([]);
  expect(state.connections).toBe(0);
  expect(state.datagrams).toBe(0);
});

test("a page answer that keeps frame-ancestors 'none' leaves the frame blank", async ({ page }) => {
  // The shipped hub first, so the check below can tell a blocked frame from one that works.
  await frameOnHub(page, world.openHub, pageRoute('plain.html'));
  await fromFrame(page, 'loaded');
  await expect(page.frameLocator('#under-test').locator('#loaded')).toHaveText('A plain page');

  await frameOnHub(page, world.blockedHub, pageRoute('plain.html'));
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
  expect(await page.evaluate(() => (window as unknown as { fromFrame: unknown[] }).fromFrame)).toEqual([]);
  await expect(page.frameLocator('#under-test').locator('#loaded')).toHaveCount(0);
  // It was asked for as the app's frame, so the CSP, not the download path, is what kept it out.
  expect(framedFrom(await seen(), 'blocked')).toEqual([{ dest: 'iframe', site: 'same-origin' }]);
});

test("a Mermaid diagram's %%{init}%% can't load styles or fonts, and the diagram still draws", async ({ page }) => {
  await page.goto(world.openHub);
  const tome = await page.evaluate(
    async (route) => ((await (await fetch(route)).json()) as { tome: { content: string } }).tome.content,
    `/api/nodes/${NODE}/library/tome?path=diagram.md`,
  );
  const source = /```mermaid\n([\s\S]*?)```/.exec(tome)?.[1];
  expect(source).toContain('themeCSS');

  await frameOnHub(page, world.openHub, '/sandbox/mermaid-frame.html');
  await fromFrame(page, 'ready');
  await page.evaluate((diagram) => {
    const frame = document.getElementById('under-test') as HTMLIFrameElement;
    frame.contentWindow!.postMessage({ type: 'render', id: 'd1', source: diagram, theme: 'light' }, '*');
  }, source!);
  const answer = await page.waitForFunction(
    () =>
      (window as unknown as { fromFrame: { type?: string }[] }).fromFrame.find(
        (message) => message.type === 'height' || message.type === 'error',
      ),
    undefined,
    { timeout: 15_000 },
  );
  const reply = (await answer.jsonValue()) as { type: string; id: string; height?: number; message?: string };
  expect(reply, reply.message).toMatchObject({ type: 'height', id: 'd1' });
  expect(reply.height).toBeGreaterThan(0);

  const svg = page.frameLocator('#under-test').locator('#diagram svg');
  await expect(svg).toHaveCount(1);
  await expect(svg.locator('text=Drawn')).not.toHaveCount(0);
  // Mermaid dropped the init block's styles and fonts: the drawn SVG doesn't name the other site at all.
  expect(await svg.evaluate((element) => element.outerHTML)).not.toContain(world.elsewhere);

  const state = await settled();
  expect(state.requests).toEqual([]);
  expect(state.connections).toBe(0);
  expect(state.datagrams).toBe(0);
});
