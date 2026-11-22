import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { HeroManifest } from '../heroes.js';
import {
  chatItems,
  ErrandLine,
  errandTally,
  HelperBackLine,
  isAgentCall,
  isCrystalSearch,
  isErrandCall,
  isSummonStart,
  isTitleCall,
  SetOutLine,
  SkillLine,
  SummonLine,
  TitleLine,
  ToolCard,
} from './ToolCard.js';

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

  it('renders a card-s output only while it is open', () => {
    const { container } = render(<ToolCard tool={tool('Bash', { command: 'ls' }, 'a very long output')} />);
    const card = container.querySelector('details')!;
    expect(screen.queryByText('a very long output')).toBeNull();

    card.open = true;
    fireEvent(card, new Event('toggle'));
    expect(screen.getByText('a very long output')).toBeTruthy();

    card.open = false;
    fireEvent(card, new Event('toggle'));
    expect(screen.queryByText('a very long output')).toBeNull();
  });

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

  /** Opens a card, as a click on its summary would. */
  function unfold(container: HTMLElement) {
    const card = container.querySelector('details')!;
    card.open = true;
    fireEvent(card, new Event('toggle'));
  }

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
    unfold(container);
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
    unfold(container);
    expect([...container.querySelectorAll('[data-diff="added"]')].map((n) => n.textContent)).toEqual(['y', 'q']);
  });

  it('shows a Write as the new file-s contents', () => {
    const { container } = render(
      <ToolCard tool={tool('Write', { file_path: '/r/new.md', content: '# Title\nbody' })} />,
    );
    unfold(container);
    expect(screen.getByText('+2')).toBeTruthy();
    expect([...container.querySelectorAll('[data-diff="added"]')].map((n) => n.textContent)).toEqual([
      '# Title',
      'body',
    ]);
  });

  it('shows a Bash command, its description and its output', () => {
    const { container } = render(
      <ToolCard tool={tool('Bash', { command: 'ls -la', description: 'List files' }, 'a\nb')} />,
    );
    unfold(container);
    expect(screen.getByText('$ ls -la')).toBeTruthy();
    expect(screen.getByText('List files')).toBeTruthy();
    expect(screen.getByText(/^a\s+b$/)).toBeTruthy();
  });

  it('falls back to the raw input for other tools', () => {
    const { container } = render(
      <ToolCard tool={tool('WebFetch', { url: 'https://example.com', prompt: 'summarize' })} />,
    );
    unfold(container);
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

describe('TitleLine (#287)', () => {
  const call = {
    kind: 'tool',
    id: 't',
    name: 'mcp__crystal__title',
    input: { title: 'The Siege of the Flaky Smoke Test', plain: 'Fix the flaky smoke test' },
  } as unknown as ComponentProps<typeof TitleLine>['tool'];

  it('announces the name the Quest gave itself in one line', () => {
    render(<TitleLine tool={call} />);
    expect(screen.getByText('The Bard names your Quest: The Siege of the Flaky Smoke Test.')).toBeTruthy();
  });

  it('claims no name when the call failed or gave none', () => {
    render(<TitleLine tool={{ ...call, isError: true, output: 'This session is not running on this node.' }} />);
    expect(screen.getByText('The Bard could not name your Quest.')).toBeTruthy();
    cleanup();
    render(<TitleLine tool={{ ...call, input: {} }} />);
    expect(screen.getByText('The Bard could not name your Quest.')).toBeTruthy();
  });

  it('knows the search that only loads the title tool, which the chat leaves out', () => {
    const search = { ...call, name: 'ToolSearch', input: { query: 'select:mcp__crystal__title' } };
    expect(isCrystalSearch(search)).toBe(true);
    expect(isCrystalSearch({ ...search, input: { query: 'select:mcp__crystal__title,Read' } })).toBe(false);
    expect(isCrystalSearch({ ...search, input: { query: 'notebook' } })).toBe(false);
  });

  it('shows only the first name the Quest gave itself, the one the hub keeps, and leaves out the title search', () => {
    const search = { ...call, id: 's', name: 'ToolSearch', input: { query: 'select:mcp__crystal__title' } };
    const failed = { ...call, id: 'f', isError: true, output: 'This session is not running on this node.' };
    const first = { ...call, id: 'a', output: 'Named.' };
    const read = { ...call, id: 'r', name: 'Read', input: { file_path: '/r/a.ts' } };
    const again = { ...call, id: 'b', input: { title: 'The Smoke Clears', plain: 'Rewrite it' }, output: 'Named.' };
    expect(chatItems([search, failed, first, read, search, again]).map((item) => item.id)).toEqual(['f', 'a', 'r']);
  });

  it('takes only Crystal’s title tool', () => {
    expect(isTitleCall(call)).toBe(true);
    expect(isTitleCall({ ...call, name: 'mcp__other__title' })).toBe(false);
  });
});

describe('ErrandLine (#288)', () => {
  afterEach(() => cleanup());
  const call = {
    kind: 'tool',
    id: 'e',
    name: 'mcp__crystal__errand',
    input: { title: 'Rotate the deploy key', body: 'It expires next week.' },
    output: 'Left Errand 1.',
    isError: false,
    denied: false,
    done: true,
  } as unknown as ComponentProps<typeof ErrandLine>['tool'];
  const search = (query: string) => ({ ...call, id: 's', name: 'ToolSearch', input: { query } });
  const turnEnd = {
    kind: 'result',
    id: 'result',
    subtype: 'success',
    isError: false,
    text: 'Done.',
    costUsd: undefined,
    durationMs: undefined,
  } as const;
  const reason = 'A Quest may leave at most 10 Errands in one turn; say the rest in your reply.';

  it('takes only Crystal’s errand tool, and searches that load only Crystal’s tools', () => {
    expect(isErrandCall(call)).toBe(true);
    expect(isErrandCall({ ...call, name: 'mcp__other__errand' })).toBe(false);
    expect(isCrystalSearch(search('select:mcp__crystal__errand'))).toBe(true);
    expect(isCrystalSearch(search('select:mcp__crystal__title,mcp__crystal__errand'))).toBe(true);
    expect(isCrystalSearch(search('select:mcp__crystal__errand,Bash'))).toBe(false);
    expect(isCrystalSearch(search('notebook'))).toBe(false);
  });

  it('keeps a search that loads any other Crystal tool, such as summon, which has no line of its own to stand in', () => {
    expect(isCrystalSearch(search('select:mcp__crystal__summon'))).toBe(false);
    expect(isCrystalSearch(search('select:mcp__crystal__errand,mcp__crystal__summon'))).toBe(false);
  });

  it('keeps one line per turn, at the turn’s first Errand, and leaves out the search', () => {
    const items = [
      search('select:mcp__crystal__title,mcp__crystal__errand'),
      { ...call, id: 'e1' },
      { ...call, id: 'read', name: 'Read', input: { file_path: '/r/a.ts' } },
      { ...call, id: 'e2' },
      turnEnd,
      { ...call, id: 'e3' },
    ];
    expect(chatItems(items).map((item) => item.id)).toEqual(['e1', 'read', 'result', 'e3']);
    const tally = errandTally(items);
    expect(tally.get('e1')).toEqual({
      left: 2,
      refused: [],
      titles: ['Rotate the deploy key', 'Rotate the deploy key'],
    });
    expect(tally.get('e3')).toEqual({ left: 1, refused: [], titles: ['Rotate the deploy key'] });
    expect(tally.size).toBe(2);
  });

  it('counts only the calls that left one', () => {
    const refused = { ...call, id: 'e2', isError: true, output: reason };
    const running = { ...call, id: 'e3', output: undefined, done: false };
    expect(errandTally([{ ...call, id: 'e1' }, refused, running]).get('e1')).toEqual({
      left: 1,
      refused: [reason],
      titles: ['Rotate the deploy key'],
    });
  });

  it('puts the line at a refused first call, and lists the title a later call left', () => {
    const items = [
      { ...call, id: 'e1', isError: true, output: reason },
      { ...call, id: 'e2', input: { title: 'Push the README', body: 'Review it first.' } },
    ];
    expect(chatItems(items).map((item) => item.id)).toEqual(['e1']);
    expect(errandTally(items).get('e1')).toEqual({ left: 1, refused: [reason], titles: ['Push the README'] });
  });

  it('counts a denied call as refused', () => {
    const denied = { ...call, id: 'e1', denied: true, output: 'The user said no.' };
    expect(errandTally([denied]).get('e1')).toEqual({ left: 0, refused: ['The user said no.'], titles: [] });
  });

  it('counts a call that got no answer before its turn ended as refused, and one still running as pending', () => {
    const unanswered = { ...call, id: 'e1', output: undefined, done: false };
    expect(errandTally([unanswered, turnEnd]).get('e1')).toEqual({
      left: 0,
      refused: ['No answer came before the turn ended.'],
      titles: [],
    });
    expect(errandTally([turnEnd, unanswered]).get('e1')).toEqual({ left: 0, refused: [], titles: [] });
  });

  it('ErrandLine says how many, and lists each title left, then the refusals, folded inside', () => {
    const { container } = render(
      <ErrandLine tool={call} tally={{ left: 2, refused: [reason], titles: ['Rotate the deploy key', 'Push it'] }} />,
    );
    expect(screen.getByText('Your Quest left you 2 Errands.')).toBeTruthy();
    expect(screen.getByText('1 refused')).toBeTruthy();
    expect(container.querySelector('pre')?.textContent).toBe(`Rotate the deploy key\nPush it\n\n${reason}`);
    // The side panel's Errands block comes later; until then the line has nothing to show there.
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('draws the failed line for a turn whose calls were all refused', () => {
    const items = [{ ...call, id: 'e1', isError: true, output: reason }];
    render(<ErrandLine tool={items[0]!} tally={errandTally(items).get('e1')} />);
    expect(screen.getByText('Your Quest couldn’t leave you an Errand.')).toBeTruthy();
    expect(screen.getByText('1 refused')).toBeTruthy();
  });
});
