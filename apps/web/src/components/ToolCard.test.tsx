import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ToolCard } from './ToolCard.js';

const tool = (name: string, input: unknown, output?: string) => ({
  kind: 'tool' as const,
  id: 't',
  name,
  input,
  output,
  isError: false,
  denied: false,
  done: output !== undefined,
});

describe('ToolCard', () => {
  afterEach(() => cleanup());

  it('shows an Edit as a diff of the file, with counts in the summary', () => {
    const { container } = render(
      <ToolCard
        tool={tool('Edit', {
          file_path: '/r/src/app.ts',
          old_string: 'const a = 1;\nkeep',
          new_string: 'const a = 2;\nkeep\nadded',
        })}
      />,
    );
    // In the summary line (truncated when long) and in full above the diff.
    expect(screen.getAllByText('/r/src/app.ts')).toHaveLength(2);
    expect(screen.getByText('+2 −1')).toBeTruthy();
    expect([...container.querySelectorAll('[data-diff="removed"]')].map((n) => n.textContent)).toEqual([
      'const a = 1;',
    ]);
    expect([...container.querySelectorAll('[data-diff="added"]')].map((n) => n.textContent)).toEqual([
      'const a = 2;',
      'added',
    ]);
  });

  it('shows each change of a MultiEdit', () => {
    const { container } = render(
      <ToolCard
        tool={tool('MultiEdit', {
          file_path: '/r/a.ts',
          edits: [
            { old_string: 'x', new_string: 'y' },
            { old_string: 'p', new_string: 'q' },
          ],
        })}
      />,
    );
    expect([...container.querySelectorAll('[data-diff="added"]')].map((n) => n.textContent)).toEqual(['y', 'q']);
  });

  it('shows a Write as the new file-s contents', () => {
    const { container } = render(
      <ToolCard tool={tool('Write', { file_path: '/r/new.md', content: '# Title\nbody' })} />,
    );
    expect(screen.getByText('+2')).toBeTruthy();
    expect([...container.querySelectorAll('[data-diff="added"]')].map((n) => n.textContent)).toEqual([
      '# Title',
      'body',
    ]);
  });

  it('shows a Bash command, its description and its output', () => {
    render(<ToolCard tool={tool('Bash', { command: 'ls -la', description: 'List files' }, 'a\nb')} />);
    expect(screen.getByText('$ ls -la')).toBeTruthy();
    expect(screen.getByText('List files')).toBeTruthy();
    expect(screen.getByText(/^a\s+b$/)).toBeTruthy();
  });

  it('falls back to the raw input for other tools', () => {
    render(<ToolCard tool={tool('WebFetch', { url: 'https://example.com', prompt: 'summarize' })} />);
    expect(screen.getByText(/"prompt": "summarize"/)).toBeTruthy();
  });
});
