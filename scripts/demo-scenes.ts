/**
 * The scripted world of `pnpm demo`: Kingdoms and Quests made of the same events a real Crystal sends, so the app can be
 * shown in full with no real session behind it. Everything here is invented, and that's the point: no real skills, plan
 * usage, paths or model names can reach a screenshot.
 */
import { randomUUID } from 'node:crypto';
import type { Appearance, Envelope, ExternalSession, Project, UsagePayload } from '../packages/protocol/src/index.js';

const MODEL = 'claude-model';
const CONTEXT_WINDOW = 200_000;
const MINUTE = 60_000;

/** One Quest's event stream, written in order. */
export class Story {
  readonly session = randomUUID();
  readonly events: Envelope[] = [];
  private seq = 0;
  private tool = 0;
  private ts: number;
  private context = 12_000;

  constructor(
    readonly node: string,
    readonly cwd: string,
    minutesAgo: number,
  ) {
    this.ts = Date.now() - minutesAgo * MINUTE;
  }

  private push(type: Envelope['type'], payload: unknown): void {
    this.ts += 1500;
    this.events.push({ node: this.node, session: this.session, seq: this.seq++, ts: this.ts, type, payload });
  }

  private raw(raw: Record<string, unknown>): void {
    this.push('claude.event', { engine: 'claude', raw: { session_id: this.session, ...raw } });
  }

  private assistant(content: unknown[]): void {
    this.context += 9_000;
    this.raw({
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        model: MODEL,
        id: randomUUID(),
        role: 'assistant',
        content,
        usage: {
          input_tokens: 40,
          cache_read_input_tokens: this.context,
          cache_creation_input_tokens: 800,
          output_tokens: 300,
        },
      },
    });
  }

  start(prompt: string, label = prompt): this {
    this.push('session.started', { cwd: this.cwd, prompt, label, engine: 'stream' });
    this.raw({
      type: 'system',
      subtype: 'init',
      cwd: this.cwd,
      model: MODEL,
      permissionMode: 'default',
      tools: ['Task', 'Bash', 'Edit', 'Read', 'Write', 'Monitor', 'mcp__github__get_issue', 'mcp__github__list_prs'],
      skills: ['code-review', 'deploy', 'release-notes', 'write-tests', 'brainstorm', 'explain-this'],
      slash_commands: ['compact', 'context', 'cost', 'review', 'code-review', 'deploy'],
      mcp_servers: [
        { name: 'crystal', status: 'connected', source: 'dynamic' },
        { name: 'github', status: 'connected' },
        { name: 'postgres', status: 'connected' },
        { name: 'browser', status: 'failed' },
      ],
      plugins: [{ name: 'formatter', path: 'builtin', source: 'builtin', version: '1.4.0' }],
      agents: ['code-reviewer', 'docs-researcher', 'Explore', 'general-purpose', 'Plan', 'security-auditor'],
    });
    return this;
  }

  follow(text: string): this {
    this.push('user.message', { text });
    return this;
  }

  say(text: string): this {
    this.assistant([{ type: 'text', text }]);
    return this;
  }

  /** A tool call with no result yet; returns its id, for `done`. */
  call(name: string, input: Record<string, unknown>): string {
    const id = `toolu_demo${++this.tool}`;
    this.assistant([{ type: 'tool_use', id, name, input }]);
    return id;
  }

  done(id: string, content = 'OK'): this {
    this.raw({
      type: 'user',
      parent_tool_use_id: null,
      message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content, is_error: false }] },
    });
    return this;
  }

  /** A tool call that finished. */
  use(name: string, input: Record<string, unknown>, result = 'OK'): this {
    return this.done(this.call(name, input), result);
  }

  edit(file: string, oldString: string, newString: string): this {
    return this.use('Edit', { file_path: `${this.cwd}/${file}`, old_string: oldString, new_string: newString });
  }

  /** A permission card waiting on the user; returns its request id. */
  ask(toolName: string, input: Record<string, unknown>, toolUseId?: string): string {
    const requestId = randomUUID();
    this.push('permission.request', { requestId, toolName, input, ...(toolUseId ? { toolUseId } : {}) });
    return requestId;
  }

  allowed(requestId: string): this {
    this.push('permission.resolved', { requestId, behavior: 'allow' });
    return this;
  }

  finish(summary: string, costUsd: number, minutes: number): this {
    const durationMs = minutes * MINUTE;
    const tokens = { input: 900, output: 4_200, cacheRead: this.context, cacheWrite: 7_000 };
    this.raw({
      type: 'result',
      subtype: 'success',
      total_cost_usd: costUsd,
      duration_ms: durationMs,
      result: summary,
      usage: {
        input_tokens: tokens.input,
        output_tokens: tokens.output,
        cache_read_input_tokens: tokens.cacheRead,
        cache_creation_input_tokens: tokens.cacheWrite,
      },
      modelUsage: { [MODEL]: { contextWindow: CONTEXT_WINDOW } },
    });
    this.push('turn.finished', { outcome: 'success', summary, costUsd, durationMs, tokens });
    return this;
  }

  /** The process stopped between turns, as it does after an idle spell. */
  rest(): this {
    this.push('session.ended', { exitCode: 0, signal: null, reason: 'idle' });
    return this;
  }

  usage(payload: UsagePayload): this {
    this.push('usage', payload);
    return this;
  }

  close(): this {
    this.push('session.closed', {});
    return this;
  }
}

function plan(fiveHourUsed: number, sevenDayUsed: number): UsagePayload {
  const resetsAt = Date.now() + 2 * 60 * MINUTE;
  return {
    windows: [
      { id: 'five_hour', label: '5h', usedPct: fiveHourUsed, resetsAt, status: 'allowed' },
      {
        id: 'seven_day',
        label: '7d',
        usedPct: sevenDayUsed,
        resetsAt: resetsAt + 3 * 24 * 60 * MINUTE,
        status: 'allowed',
      },
    ],
  };
}

export interface DemoKingdom {
  id: string;
  projects: Project[];
  found: ExternalSession[];
}

export interface DemoWorld {
  kingdoms: DemoKingdom[];
  stories: Story[];
  appearance: Appearance;
  /** What each approval sets off, by request id: the rest of that Quest's story. */
  onApprove: Map<string, () => Envelope[]>;
}

function project(root: string, name: string): Project {
  return { path: `${root}/${name}`, name, lastUsed: Date.now() - 20 * MINUTE };
}

/** The whole demo: three Kingdoms, with enough going on to fill every part of the app. */
export function demoWorld(): DemoWorld {
  const onApprove = new Map<string, () => Envelope[]>();

  /** Runs `after` on the story when the user approves, and hands over just the events it adds. */
  function whenApproved(story: Story, requestId: string, after: (story: Story) => void): void {
    onApprove.set(requestId, () => {
      const from = story.events.length;
      story.allowed(requestId);
      after(story);
      return story.events.slice(from);
    });
  }

  // The showpiece: the party out, a Side Quest watching, a tests run waiting on Approve.
  const login = new Story('highkeep', '/srv/code/aurora-web', 18)
    .start('Add passkey sign-in to the login page, with tests', 'Add passkey sign-in')
    .usage(plan(38, 21))
    .use('Read', { file_path: '/srv/code/aurora-web/src/auth/login.ts' })
    .say('Sign-in only takes an email today, so passkeys need a new challenge step.')
    .finish('Sign-in only takes an email today.', 0.56, 2)
    .follow('Go ahead, and keep email as the fallback')
    .say("I'll split this up: one scout maps the auth flow, one drafts the tests, and I'll write the sign-in itself.")
    .edit(
      'src/auth/login.ts',
      'export async function signIn(email: string) {',
      'export async function signIn(email: string, passkey?: Credential) {',
    )
    .edit('src/auth/passkey.ts', '// TODO', 'export const challenge = () => crypto.randomUUID();');
  login.call('Task', {
    description: 'Map the auth flow',
    subagent_type: 'Explore',
    prompt: 'Trace sign-in end to end.',
  });
  login.call('Task', {
    description: 'Draft passkey tests',
    subagent_type: 'test-writer',
    prompt: 'Cover the happy path.',
  });
  login.call('Monitor', { description: 'Watch the preview deploy', command: 'deploy-status --follow' });
  const tests = login.call('Bash', { command: 'pnpm test src/auth', description: 'Run the auth tests' });
  const runTests = login.ask('Bash', { command: 'pnpm test src/auth', description: 'Run the auth tests' }, tests);
  whenApproved(login, runTests, (story) => {
    story
      .done(tests, '14 passed')
      .use(
        'Bash',
        { command: 'gh pr create --fill', description: 'Open the pull request' },
        'https://git.example.com/tavern/app/pull/128\n',
      )
      .say('Passkey sign-in works, with a fallback to email, and all 14 auth tests pass.')
      .finish('Passkey sign-in works, with a fallback to email.', 1.84, 12);
  });

  const release = new Story('highkeep', '/srv/code/aurora-web', 95)
    .start('Write the release notes for 2.4')
    .use('Bash', { command: 'git log --oneline v2.3..HEAD', description: 'List the changes' }, '37 commits')
    .edit('CHANGELOG.md', '## Unreleased', '## 2.4.0')
    .say('The 2.4 notes are in `CHANGELOG.md`: passkeys, faster search, and six fixes.')
    .finish('The 2.4 notes are in CHANGELOG.md.', 0.42, 4)
    .usage(plan(38, 21))
    .rest();

  const invoices = new Story('emberfall', '/srv/code/ledger', 12)
    .start('Why are some invoices rounding down a cent?', 'Invoice rounding bug')
    .usage(plan(64, 47))
    .use('Read', { file_path: '/srv/code/ledger/src/money.ts' })
    .say('Found it: tax is rounded per line and then summed, so a long invoice can lose a cent.')
    .edit('src/money.ts', 'return lines.map(round).reduce(add);', 'return round(lines.reduce(add));');
  const rounding = invoices.ask('AskUserQuestion', {
    questions: [
      {
        question: 'How should old invoices be handled?',
        header: 'Old invoices',
        multiSelect: false,
        options: [
          { label: 'Leave them', description: 'Only new invoices use the fix.' },
          { label: 'Reissue them', description: 'Correct every affected invoice and notify customers.' },
        ],
      },
    ],
  });

  whenApproved(invoices, rounding, (story) => {
    story
      .say('New invoices now round the total, and old ones stay as they are.')
      .finish('The rounding bug is fixed.', 0.67, 6);
  });

  const migrate = new Story('emberfall', '/srv/code/ledger', 7)
    .start('Move the reports job to the new queue', 'Move reports to the new queue')
    .use('Read', { file_path: '/srv/code/ledger/jobs/reports.ts' })
    .edit('jobs/reports.ts', "queue: 'legacy'", "queue: 'reports'")
    .say('The reports job is on the new queue. Checking the worker picks it up now.');
  migrate.call('Task', { description: 'Check the worker logs', subagent_type: 'Explore', prompt: 'Look for errors.' });

  const docs = new Story('mossgate', '/srv/code/field-guide', 40)
    .start('Add a getting started page to the docs', 'Getting started page')
    .usage(plan(12, 9))
    .edit('docs/start.md', '# Start', '# Getting started');
  const publish = docs.call('Bash', { command: 'pnpm docs:publish', description: 'Publish the docs' });
  const publishing = docs.ask('Bash', { command: 'pnpm docs:publish', description: 'Publish the docs' }, publish);
  whenApproved(docs, publishing, (story) => {
    story.done(publish, 'Published').say('The page is live.').finish('The getting started page is live.', 0.31, 3);
  });

  const closed = [
    new Story('highkeep', '/srv/code/aurora-web', 130)
      .start('Fix the flaky checkout test')
      .say('Fixed: it raced the cart reload.'),
    new Story('highkeep', '/srv/code/design-system', 170)
      .start('Darken the disabled button text')
      .say('Done, and it now passes contrast checks.'),
    new Story('emberfall', '/srv/code/ledger', 150)
      .start('Add an index for the monthly report')
      .say('The report now runs in 2 seconds.'),
    new Story('mossgate', '/srv/code/field-guide', 200)
      .start('Fix the broken links in the guide')
      .say('Fixed 11 links.'),
  ].map((story, at) => story.finish('Done.', 0.2 + at / 10, 5).close());

  return {
    kingdoms: [
      {
        id: 'highkeep',
        projects: [project('/srv/code', 'aurora-web'), project('/srv/code', 'design-system')],
        found: [
          {
            id: randomUUID(),
            cwd: '/srv/code/design-system',
            title: 'Audit the colour tokens',
            updatedAt: Date.now() - 50 * MINUTE,
            messages: 24,
          },
        ],
      },
      { id: 'emberfall', projects: [project('/srv/code', 'ledger')], found: [] },
      { id: 'mossgate', projects: [project('/srv/code', 'field-guide')], found: [] },
    ],
    stories: [...closed, release, login, invoices, migrate, docs],
    appearance: {
      tabStyle: 'tinted',
      promptColour: 'dusk',
      looks: {
        highkeep: { icon: 'castle', colour: '#3550c8', leader: 'varied' },
        emberfall: { icon: 'fortress', colour: '#e06a2a', leader: 'varied' },
        mossgate: { icon: 'treefort', colour: '#2f9e5a', leader: 'varied' },
      },
    },
    onApprove,
  };
}
