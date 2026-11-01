import { cleanup, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { HeroManifest } from '../heroes.js';
import { HelperBackLine, isAgentCall, isSummonStart, SetOutLine, SkillLine, SummonLine, ToolCard } from './ToolCard.js';

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

const manifest: HeroManifest = {
  leader: 'paladin',
  fallback: 'wizard',
  classes: {
    paladin: { name: 'Paladin', match: ['security'], work: 'slash', verb: 'Smite', victory: 'emote', anims: {} },
    wizard: { name: 'Wizard', match: ['build'], work: 'spellcast', verb: 'Cast', victory: 'spellcast', anims: {} },
  },
};
const helper = { id: 'a1', description: 'Build the docs', agentType: 'general-purpose' };

describe('the party in the chat', () => {
  afterEach(() => cleanup());

  it('marks a helper-s tool with its sprite, and leaves the leader-s alone', () => {
    const { rerender } = render(<ToolCard tool={{ ...tool('Read', {}, 'x'), helper }} manifest={manifest} />);
    expect(screen.getByRole('img', { name: 'Wizard · Build the docs' })).toBeTruthy();
    rerender(<ToolCard tool={tool('Read', {}, 'x')} manifest={manifest} />);
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('announces a helper setting out, with its prompt folded inside', () => {
    const call = tool('Agent', { description: 'Build the docs', prompt: 'Go build', subagent_type: 'general-purpose' });
    expect(isAgentCall(call)).toBe(true);
    expect(isAgentCall(tool('Read', {}))).toBe(false);
    render(<SetOutLine tool={{ ...call, sent: helper }} manifest={manifest} />);
    expect(screen.getByText('Wizard sets out: Build the docs!')).toBeTruthy();
    expect(screen.getByText('Go build')).toBeTruthy();
    expect(screen.getByText('Wizard sets out: Build the docs!').closest('details')!.open).toBe(false);
  });

  it('gives a helper the same Class setting out as on its tools', () => {
    const call = tool('Agent', { description: 'Security review', subagent_type: 'general-purpose' });
    const sent = { ...helper, description: 'Security review' };
    render(<SetOutLine tool={{ ...call, sent }} manifest={manifest} />);
    expect(screen.getByText('Paladin sets out: Security review!')).toBeTruthy();
  });

  it('announces a return with the report folded inside, and a KO', () => {
    const back = { kind: 'helper-back' as const, id: 'e9', helper, report: 'All built' };
    const { rerender } = render(<HelperBackLine item={{ ...back, outcome: 'returned' }} manifest={manifest} />);
    expect(screen.getByText('Wizard returns from Build the docs!')).toBeTruthy();
    expect(screen.getByText('All built')).toBeTruthy();
    rerender(<HelperBackLine item={{ ...back, outcome: 'failed' }} manifest={manifest} />);
    expect(screen.getByText('Wizard was KO’d on Build the docs!')).toBeTruthy();
  });

  it('lets a helper-s skill be its own', () => {
    render(<SkillLine tool={{ ...tool('Skill', { skill: 'deploy' }), helper }} manifest={manifest} />);
    expect(screen.getByText('Wizard casts deploy!')).toBeTruthy();
  });

  it('says on a chip what the Hero is doing, by the Class doing it, with the plain word as its hint', () => {
    const { rerender } = render(<ToolCard tool={tool('Read', {})} manifest={manifest} />);
    expect(screen.getByText('Attacking').getAttribute('title')).toBe('running');
    rerender(<ToolCard tool={{ ...tool('Read', {}), helper }} manifest={manifest} />);
    expect(screen.getByText('Casting').getAttribute('title')).toBe('running');
    rerender(<ToolCard tool={tool('Read', {}, 'x')} manifest={manifest} />);
    expect(screen.getByText('Success').getAttribute('title')).toBe('done');
    rerender(<ToolCard tool={{ ...tool('Read', {}, 'x'), isError: true }} manifest={manifest} />);
    expect(screen.getByText('Miss').getAttribute('title')).toBe('failed');
    rerender(<ToolCard tool={{ ...tool('Read', {}, 'x'), isError: true, denied: true }} manifest={manifest} />);
    expect(screen.getByText('Blocked').getAttribute('title')).toBe('denied');
  });
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

describe('SummonLine', () => {
  const start = {
    kind: 'tool',
    id: 't',
    name: 'mcp__crystal__summon',
    input: { action: 'start', summon: 'Shiva', command: './encode --all' },
  } as unknown as ComponentProps<typeof SummonLine>['tool'];

  it('announces a Cast in one line, with the command folded inside', () => {
    render(<SummonLine tool={start} />);
    expect(screen.getByText('You summoned Shiva!')).toBeTruthy();
    expect(screen.getByText('./encode --all').closest('details')).not.toBeNull();
  });

  it('takes only a start: status and cancel stay ordinary tool cards', () => {
    expect(isSummonStart(start)).toBe(true);
    expect(isSummonStart({ ...start, input: { action: 'status' } })).toBe(false);
    expect(isSummonStart({ ...start, name: 'Bash' })).toBe(false);
  });
});
