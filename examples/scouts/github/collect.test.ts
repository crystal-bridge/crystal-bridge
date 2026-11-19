import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ScoutItems, ScoutManifest } from '../../../packages/protocol/src/index.ts';
import {
  MAX_PAGES,
  collect,
  failingChecks,
  lastHuman,
  maintainedRepos,
  projectsQuery,
  query,
  cacheKey,
  readSettings,
  toItems,
  validateSettings,
} from './collect.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ME = 'octo-me';
const T = (minute: number) => `2026-11-18T10:${String(minute).padStart(2, '0')}:00Z`;
const NOW = Date.parse('2026-11-18T12:00:00Z');
const DAY = 24 * 60 * 60_000;

const user = (login: string) => ({ login, __typename: 'User' });
const bot = (login: string) => ({ login, __typename: 'Bot' });

const WIDGETS = {
  nameWithOwner: 'acme/widgets',
  name: 'widgets',
  url: 'https://github.com/acme/widgets',
  description: 'Widgets for everyone',
};

/** A pull request as the collector's GraphQL search returns it, made up for the test. */
function pr(extra: Record<string, unknown> = {}, checks: { state: string; nodes?: unknown[] } | null = null) {
  return {
    __typename: 'PullRequest',
    id: 'PR_1',
    number: 7,
    title: 'Fix the retry loop',
    url: 'https://github.com/acme/widgets/pull/7',
    isDraft: false,
    updatedAt: T(30),
    additions: 12,
    deletions: 3,
    repository: WIDGETS,
    author: user(ME),
    reviewDecision: null,
    mergeStateStatus: 'BLOCKED',
    labels: { nodes: [] },
    commits: {
      nodes: [
        {
          commit: {
            committedDate: T(10),
            author: { user: { login: ME } },
            statusCheckRollup: checks && { state: checks.state, contexts: { nodes: checks.nodes ?? [] } },
          },
        },
      ],
    },
    comments: { totalCount: 0, nodes: [] },
    reviews: { nodes: [] },
    ...extra,
  };
}

function issue(extra: Record<string, unknown> = {}) {
  return {
    __typename: 'Issue',
    id: 'I_1',
    number: 12,
    title: 'Uploads time out on big files',
    url: 'https://github.com/acme/widgets/issues/12',
    updatedAt: T(20),
    repository: WIDGETS,
    author: user('someone'),
    labels: { nodes: [] },
    assignees: { nodes: [] },
    comments: { totalCount: 0, nodes: [] },
    ...extra,
  };
}

/** A maintained repository as the batched per-repository query returns it. */
function repo(nameWithOwner: string, { prs = [], issues = [] }: { prs?: unknown[]; issues?: unknown[] } = {}) {
  const name = nameWithOwner.split('/')[1]!;
  return {
    nameWithOwner,
    name,
    url: `https://github.com/${nameWithOwner}`,
    description: `  The ${name} project  `,
    pullRequests: { totalCount: prs.length, nodes: prs },
    issues: { totalCount: issues.length, nodes: issues },
  };
}

const LANTERN = { nameWithOwner: 'acme/lantern', name: 'lantern', url: 'https://github.com/acme/lantern' };
const inLantern = (number: number, kind: 'pull' | 'issues' = 'pull') => ({
  number,
  url: `https://github.com/acme/lantern/${kind}/${number}`,
  repository: LANTERN,
});

const failing = {
  state: 'FAILURE',
  nodes: [
    { __typename: 'CheckRun', name: 'test (ubuntu)', conclusion: 'FAILURE', status: 'COMPLETED' },
    { __typename: 'CheckRun', name: 'lint', conclusion: 'SUCCESS', status: 'COMPLETED' },
    { __typename: 'StatusContext', context: 'ci/legacy', state: 'ERROR' },
  ],
};

const one = (node: unknown, search = 'mine') => {
  const items = toItems({ [search]: { nodes: [node] } }, ME);
  assert.equal(items.length, 1);
  return items[0]!;
};

/** The one item a maintained repository lists, found by no search. */
const listed = (node: Record<string, unknown>) => {
  const kind = node.__typename === 'PullRequest' ? 'prs' : 'issues';
  const items = toItems({}, ME, [repo('acme/lantern', { [kind]: [{ ...node, ...inLantern(node.number as number) }] })]);
  assert.equal(items.length, 1);
  return items[0]!;
};

describe('lastHuman', () => {
  it('finds the latest person, not bot, who commented, reviewed or pushed', () => {
    const node = pr({
      comments: {
        nodes: [
          { author: user('ana'), createdAt: T(20) },
          { author: bot('ci-bot'), createdAt: T(50) },
        ],
      },
      reviews: { nodes: [{ author: user('ben'), submittedAt: T(25), state: 'COMMENTED' }] },
    });
    assert.deepEqual(lastHuman(node), { login: 'ben', at: T(25) });
    assert.equal(
      lastHuman(pr({ comments: { nodes: [{ author: { login: 'renovate[bot]' }, createdAt: T(59) }] } })).login,
      ME,
    );
  });

  it('skips a review not yet submitted, wherever it sits in the list', () => {
    const pending = { author: user(ME), submittedAt: null, state: 'PENDING' };
    const asked = { author: user('ana'), submittedAt: T(40), state: 'COMMENTED' };
    assert.deepEqual(lastHuman(pr({ reviews: { nodes: [asked, pending] } })), { login: 'ana', at: T(40) });
    assert.deepEqual(lastHuman(pr({ reviews: { nodes: [pending, asked] } })), { login: 'ana', at: T(40) });
  });

  it('counts a deleted account as no one', () => {
    assert.deepEqual(lastHuman(issue({ author: null, comments: { nodes: [{ author: null, createdAt: T(5) }] } })), {});
  });
});

describe('failingChecks', () => {
  it('names the checks that failed, from check runs and old-style statuses', () => {
    assert.deepEqual(failingChecks(pr({}, failing)), ['test (ubuntu)', 'ci/legacy']);
    assert.deepEqual(failingChecks(pr({}, { state: 'SUCCESS' })), []);
    assert.deepEqual(failingChecks(pr()), []);
  });
});

describe('settings', () => {
  it('takes the example file and no file at all', () => {
    validateSettings(JSON.parse(readFileSync(join(HERE, 'settings.example.json'), 'utf8')));
    validateSettings({});
  });

  it('refuses a setting of the wrong type, naming it', () => {
    assert.throws(() => validateSettings({ activeDays: '90' }), /activeDays/);
    assert.throws(() => validateSettings({ perProject: 0 }), /perProject/);
    assert.throws(() => validateSettings({ perProject: 101 }), /perProject/);
    assert.throws(() => validateSettings({ perProject: 2.5 }), /perProject/);
    assert.throws(() => validateSettings({ maxRepos: 0 }), /maxRepos/);
    assert.throws(() => validateSettings({ maxRepos: 201 }), /maxRepos/);
    assert.throws(() => validateSettings({ maxRepos: 1.5 }), /maxRepos/);
    validateSettings({ maxRepos: 200 });
    assert.throws(() => validateSettings({ refreshMinutes: -1 }), /refreshMinutes/);
    assert.throws(() => validateSettings({ discussions: 'yes' }), /discussions/);
    assert.throws(() => validateSettings({ include: 'acme/lantern' }), /include/);
    assert.throws(() => validateSettings({ exclude: ['lantern'] }), /exclude/);
    assert.throws(() => validateSettings({ exlude: [] }), /exlude/);
    assert.throws(() => validateSettings([]), /settings\.json/);
  });

  it('refuses a settings.json that isn-t JSON or has a wrong setting, rather than quietly ignoring it', () => {
    const folder = mkdtempSync(join(tmpdir(), 'cb-github-settings-'));
    try {
      writeFileSync(join(folder, 'settings.json'), '{ "discussions": true, }');
      assert.throws(() => readSettings(folder), /settings\.json/);
      writeFileSync(join(folder, 'settings.json'), '{ "perProject": "50" }');
      assert.throws(() => readSettings(folder), /settings\.json.*perProject/);
      assert.deepEqual(readSettings(join(folder, 'missing')), {});
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});

describe('maintainedRepos', () => {
  const recent = new Date(NOW - 10 * DAY).toISOString();
  const old = new Date(NOW - 120 * DAY).toISOString();
  const found = (nameWithOwner: string, extra: Record<string, unknown> = {}) => ({
    nameWithOwner,
    viewerPermission: 'ADMIN',
    isArchived: false,
    isFork: false,
    hasIssuesEnabled: true,
    pushedAt: recent,
    ...extra,
  });

  it('keeps the active repositories you administer or maintain', () => {
    const repos = [
      found('acme/lantern'),
      found('acme/kettle', { viewerPermission: 'MAINTAIN' }),
      found('acme/teapot', { viewerPermission: 'WRITE' }),
      found('acme/attic', { isArchived: true }),
      found('acme/dusty', { pushedAt: old }),
      found('octo-me/upstream-fork', { isFork: true, hasIssuesEnabled: false }),
      found('octo-me/hard-fork', { isFork: true, hasIssuesEnabled: true }),
    ];
    assert.deepEqual(maintainedRepos(repos, {}, NOW), ['acme/kettle', 'acme/lantern', 'octo-me/hard-fork']);
    assert.deepEqual(maintainedRepos(repos, { activeDays: 200 }, NOW), [
      'acme/dusty',
      'acme/kettle',
      'acme/lantern',
      'octo-me/hard-fork',
    ]);
  });

  it('adds `include` and leaves out `exclude`, whatever the case', () => {
    const repos = [found('acme/lantern'), found('acme/kettle')];
    assert.deepEqual(
      maintainedRepos(repos, { include: ['mira/notes', 'ACME/lantern'], exclude: ['Acme/Kettle'] }, NOW),
      ['acme/lantern', 'mira/notes'],
    );
    assert.deepEqual(maintainedRepos(repos, { include: ['mira/notes'], exclude: ['mira/notes'] }, NOW), [
      'acme/kettle',
      'acme/lantern',
    ]);
  });
});

describe('maintainedRepos cap', () => {
  const at = (name: string, days: number) => ({
    nameWithOwner: name,
    viewerPermission: 'ADMIN',
    isArchived: false,
    isFork: false,
    hasIssuesEnabled: true,
    pushedAt: new Date(NOW - days * DAY).toISOString(),
  });
  const many = Array.from({ length: 40 }, (_, index) => at(`acme/r${String(index).padStart(2, '0')}`, index + 1));

  it('lists 30 by default and `maxRepos` otherwise, newest push first', () => {
    assert.equal(maintainedRepos(many, {}, NOW).length, 30);
    assert.deepEqual(maintainedRepos(many, { maxRepos: 2 }, NOW), ['acme/r00', 'acme/r01']);
    assert.ok(!maintainedRepos(many, { maxRepos: 2 }, NOW).includes('acme/r39'));
  });

  it('always lists `include`, ahead of the cap, and counts it in the cap', () => {
    assert.deepEqual(maintainedRepos(many, { maxRepos: 2, include: ['acme/r39'] }, NOW), ['acme/r00', 'acme/r39']);
    assert.deepEqual(maintainedRepos(many, { maxRepos: 1, include: ['acme/r39', 'mira/other'] }, NOW), [
      'acme/r39',
      'mira/other',
    ]);
  });
});

describe('queries', () => {
  it('asks for your repositories, newest push first, beside the four searches', () => {
    const text = query({});
    assert.match(text, /viewer \{ login repositories\(first: 100/);
    assert.match(text, /orderBy: \{ field: PUSHED_AT, direction: DESC \}/);
    for (const alias of ['mine', 'review', 'assigned', 'authored']) assert.match(text, new RegExp(`${alias}: search`));
    assert.doesNotMatch(text, /DISCUSSION/);
    assert.match(query({ discussions: true }), /discussions: search\(.*type: DISCUSSION/);
  });

  it('asks for an issue-s milestone and its due date, in the searches and the repository lists', () => {
    assert.match(query({}), /milestone \{ title dueOn \}/);
    assert.match(projectsQuery(['acme/lantern']), /milestone \{ title dueOn \}/);
  });

  it('lists each maintained repository-s open pull requests and issues under an alias, newest first', () => {
    const text = projectsQuery(['acme/lantern', 'mira/notes'], 30);
    assert.match(text, /r0: repository\(owner: "acme", name: "lantern"\)/);
    assert.match(text, /r1: repository\(owner: "mira", name: "notes"\)/);
    assert.match(text, /pullRequests\(states: OPEN, first: 30, orderBy: \{ field: UPDATED_AT, direction: DESC \}\)/);
    assert.match(text, /issues\(states: OPEN, first: 30, orderBy: \{ field: UPDATED_AT, direction: DESC \}\)/);
  });
});

describe('toItems', () => {
  it('maps a pull request in a maintained repository with its project, labels and marks', () => {
    const item = listed({
      ...pr(
        {
          author: user('mira'),
          reviewDecision: 'APPROVED',
          comments: { totalCount: 4, nodes: [] },
          labels: {
            nodes: [
              { name: 'enhancement', color: 'a2eeef' },
              { name: 'broken', color: 'nope' },
              ...Array.from({ length: 12 }, (_, at) => ({ name: `tag-${at}`, color: '00ff00' })),
            ],
          },
        },
        { state: 'SUCCESS' },
      ),
    });
    assert.equal(item.id, 'pr:acme/lantern#7');
    assert.equal(item.group, 'acme/lantern');
    assert.deepEqual(item.project, {
      name: 'acme/lantern',
      url: 'https://github.com/acme/lantern',
      description: 'The lantern project',
      owned: true,
    });
    assert.equal(item.labels!.length, 10);
    assert.deepEqual(item.labels![0], { name: 'enhancement', color: '#a2eeef' });
    assert.ok(!item.labels!.some((label) => label.name === 'broken'));
    assert.deepEqual(item.fields, {
      kind: 'pr',
      checks: 'pass',
      review: 'approved',
      author: 'mira',
      login: 'mira',
      updated: T(30),
      comments: 4,
      added: 12,
      removed: 3,
      mine: false,
      repo: 'lantern',
      repository: 'acme/lantern',
      number: 7,
      isPr: true,
      isIssue: false,
    });
    // Someone else's pull request that asks nothing of you: listed, but not in the Needs-you window.
    assert.equal(item.fields!.reason, undefined);
    assert.equal(item.suggested, undefined);
    assert.equal(item.summary, undefined);
    assert.deepEqual(item.actions, ['open', 'later', 'done']);
  });

  it('names drafts, bugs, issues and Discussions, and each checks and review state', () => {
    assert.equal(listed(pr({ isDraft: true })).fields!.kind, 'draft');
    assert.equal(listed(issue({ labels: { nodes: [{ name: 'Bug', color: 'd73a4a' }] } })).fields!.kind, 'bug');
    const plain = listed(issue());
    assert.equal(plain.fields!.kind, 'issue');
    assert.equal(plain.fields!.isIssue, true);
    assert.equal(plain.fields!.checks, undefined);
    assert.equal(listed(pr({}, { state: 'PENDING' })).fields!.checks, 'running');
    assert.equal(listed(pr({}, { state: 'ERROR' })).fields!.checks, 'fail');
    assert.equal(listed(pr()).fields!.checks, undefined);
    assert.equal(listed(pr({ reviewDecision: 'REVIEW_REQUIRED' })).fields!.review, 'pending');
    assert.equal(listed(pr({ reviewDecision: 'CHANGES_REQUESTED' })).fields!.review, 'changes');
    assert.equal(listed(pr()).fields!.review, undefined);
    const discussion = one(
      {
        __typename: 'Discussion',
        id: 'D_1',
        number: 3,
        title: 'How do I retry?',
        url: 'https://github.com/acme/widgets/discussions/3',
        updatedAt: T(1),
        repository: WIDGETS,
        author: user(ME),
        labels: { nodes: [] },
        comments: { totalCount: 0, nodes: [] },
      },
      'discussions',
    );
    assert.equal(discussion.id, 'discussion:acme/widgets#3');
    assert.equal(discussion.fields!.kind, 'discussion');
    assert.match(discussion.subtitle!, /no answer yet/);
  });

  it('marks an item from a repository you only contribute to as not owned', () => {
    const item = one(pr({}, failing));
    assert.deepEqual(item.project, {
      name: 'acme/widgets',
      url: 'https://github.com/acme/widgets',
      description: 'Widgets for everyone',
      owned: false,
    });
    assert.equal(item.group, 'acme/widgets');
    assert.equal(item.fields!.mine, true);
  });

  it('asks for your review when it is requested, with a link to review', () => {
    const item = one(pr({ author: user('ana') }), 'review');
    assert.equal(item.fields!.reason, 'review');
    assert.equal(item.suggested, 'review');
    assert.deepEqual(item.actions, ['review', 'open', 'later', 'done']);
    assert.equal(item.summary, 'review requested');
  });

  it('offers the fix Quest on your pull request with failing checks, naming them', () => {
    const item = one(pr({}, failing));
    assert.equal(item.id, 'pr:acme/widgets#7');
    assert.equal(item.fields!.reason, 'fail');
    assert.equal(item.fields!.checks, 'fail');
    assert.equal(item.fields!.failing, 'test (ubuntu), ci/legacy');
    assert.equal(item.suggested, 'fix');
    assert.deepEqual(item.actions, ['fix', 'open', 'later', 'done']);
    assert.equal(item.summary, 'checks failing: test (ubuntu), ci/legacy');
    assert.match(item.subtitle!, /^acme\/widgets#7 · checks failing: test \(ubuntu\)/);
    const unnamed = one(
      pr({}, { state: 'FAILURE', nodes: [{ __typename: 'CheckRun', name: 'e2e', conclusion: 'CANCELLED' }] }),
    );
    assert.equal(unnamed.summary, 'checks failing');
    // The banner counts `failing`, so a failure no check can be named for still sets it.
    assert.equal(unnamed.fields!.failing, 'checks failing');
    assert.equal(one(pr({}, { state: 'SUCCESS' })).fields!.failing, undefined);
  });

  it('offers the answer Quest for a review asking for changes', () => {
    const item = one(
      pr({
        reviewDecision: 'CHANGES_REQUESTED',
        reviews: { nodes: [{ author: user('ben'), submittedAt: T(40), state: 'CHANGES_REQUESTED' }] },
      }),
    );
    assert.equal(item.fields!.reason, 'changes');
    assert.equal(item.suggested, 'answer');
    assert.equal(item.summary, 'changes requested');
  });

  it('owes a reply to someone else-s last word, suggesting the Quest only for someone with write access', () => {
    const member = one(
      pr({ comments: { nodes: [{ author: user('mira'), authorAssociation: 'MEMBER', createdAt: T(45) }] } }),
    );
    assert.equal(member.fields!.reason, 'reply');
    assert.equal(member.suggested, 'answer');
    assert.equal(member.summary, 'mira replied');
    const stranger = one(
      pr({ comments: { nodes: [{ author: user('drive-by'), authorAssociation: 'NONE', createdAt: T(45) }] } }),
    );
    assert.equal(stranger.fields!.reason, 'reply');
    assert.equal(stranger.suggested, undefined);
    assert.ok(stranger.actions!.includes('answer'));
    assert.match(stranger.subtitle!, /drive-by replied/);
  });

  it('marks your pull request GitHub would merge, never a draft, with a link to merge', () => {
    const ready = one(pr({ mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED' }, { state: 'SUCCESS' }));
    assert.equal(ready.fields!.reason, 'merge');
    assert.equal(ready.suggested, 'merge');
    assert.equal(ready.summary, 'ready to merge');
    // An approval asks nothing of you, so it is not a reply owed.
    const approved = one(
      pr(
        {
          mergeStateStatus: 'CLEAN',
          reviews: {
            nodes: [{ author: user('ben'), authorAssociation: 'MEMBER', submittedAt: T(40), state: 'APPROVED' }],
          },
        },
        { state: 'SUCCESS' },
      ),
    );
    assert.equal(approved.fields!.reason, 'merge');
    const draft = one(pr({ mergeStateStatus: 'CLEAN', isDraft: true }));
    assert.equal(draft.fields!.reason, undefined);
    assert.match(draft.subtitle!, /· draft$/);
  });

  it('gives your pull request no reason while you had the last word', () => {
    const item = one(pr({ comments: { nodes: [{ author: user(ME), createdAt: T(45) }] } }));
    assert.equal(item.fields!.reason, undefined);
    assert.equal(item.summary, undefined);
    assert.deepEqual(item.actions, ['open', 'later', 'done']);
    assert.match(item.subtitle!, /waiting on others/);
  });

  it('offers triage for an issue assigned to you, and for a reply on yours', () => {
    const assigned = one(issue(), 'assigned');
    assert.equal(assigned.id, 'issue:acme/widgets#12');
    assert.equal(assigned.fields!.reason, 'assigned');
    assert.equal(assigned.suggested, 'triage');
    assert.equal(assigned.summary, 'assigned to you');
    const answered = one(issue({ comments: { nodes: [{ author: user('ana'), createdAt: T(30) }] } }), 'assigned');
    assert.equal(answered.fields!.reason, 'reply');
    assert.equal(answered.suggested, 'triage');
    assert.equal(answered.summary, 'ana replied');
    const yours = one(
      issue({ author: user(ME), comments: { nodes: [{ author: user('ana'), createdAt: T(30) }] } }),
      'authored',
    );
    assert.equal(yours.fields!.reason, 'reply');
    // One you opened that waits on others, in a repository you don't maintain, is not yours to act on.
    assert.deepEqual(toItems({ authored: { nodes: [issue({ author: user(ME) })] } }, ME), []);
  });

  it('queues an issue you opened and assigned to yourself as Up next, out of Needs you', () => {
    const own = issue({ author: user(ME), assignees: { nodes: [{ login: ME }] } });
    const item = listed(own);
    assert.equal(item.fields!.reason, 'next');
    assert.equal(item.suggested, undefined);
    assert.deepEqual(item.actions, ['triage', 'open', 'later', 'done']);
    assert.equal(item.summary, 'your issue');
    assert.equal(one(own, 'assigned').fields!.reason, 'next');
    assert.match(item.subtitle!, /· your issue$/);
    assert.match(listed(issue({ author: user(ME) })).subtitle!, /· waiting on others$/);
    assert.equal(listed(issue({ author: user(ME) })).fields!.reason, undefined);
    // Once someone else replies, it waits on you again.
    const answered = issue({
      author: user(ME),
      assignees: { nodes: [{ login: ME }] },
      comments: { totalCount: 1, nodes: [{ author: user('ana'), createdAt: T(30) }] },
    });
    assert.equal(listed(answered).fields!.reason, 'reply');
  });

  it('names a queued issue-s milestone and takes its due date, and its priority from a P0-P3 label', () => {
    const own = (extra: Record<string, unknown>) =>
      listed(issue({ author: user(ME), assignees: { nodes: [{ login: ME }] }, ...extra }));
    const planned = own({
      milestone: { title: 'v0.7 Lanterns', dueOn: '2026-12-01T08:00:00Z' },
      labels: {
        nodes: [
          { name: 'bug', color: 'd73a4a' },
          { name: 'P1', color: 'b60205' },
        ],
      },
    });
    assert.equal(planned.summary, 'your issue · v0.7 Lanterns');
    assert.equal(planned.fields!.due, '2026-12-01T08:00:00Z');
    assert.equal(planned.fields!.priority, 1);
    assert.equal(own({ milestone: { title: 'Someday', dueOn: null } }).fields!.due, undefined);
    assert.equal(own({}).fields!.priority, undefined);
    assert.equal(own({}).fields!.due, undefined);
    const priority = (...names: string[]) =>
      own({ labels: { nodes: names.map((name) => ({ name, color: 'ededed' })) } }).fields!.priority;
    assert.equal(priority('p0'), 0);
    assert.equal(priority('priority: 2'), 2);
    assert.equal(priority('Priority/3'), 3);
    assert.equal(priority('priority-1'), 1);
    assert.equal(priority('p10', 'P2 later', 'help wanted'), undefined);
    assert.equal(priority('docs', 'P3', 'P0'), 3);
    // Any item may carry a priority, and one someone else assigned you stays in Needs you.
    const theirs = listed(
      issue({ assignees: { nodes: [{ login: ME }] }, labels: { nodes: [{ name: 'P0', color: 'b60205' }] } }),
    );
    assert.equal(theirs.fields!.reason, 'assigned');
    assert.equal(theirs.fields!.priority, 0);
  });

  it('relights a queued issue when its priority changes, not when its milestone moves', () => {
    const own = (label: string | null, dueOn: string) =>
      listed(
        issue({
          author: user(ME),
          assignees: { nodes: [{ login: ME }] },
          labels: { nodes: label ? [{ name: label, color: 'b60205' }] : [] },
          milestone: { title: 'v1', dueOn },
        }),
      ).rev;
    assert.equal(own('P1', '2026-12-01T08:00:00Z'), own('P1', '2026-12-09T08:00:00Z'));
    assert.notEqual(own('P1', '2026-12-01T08:00:00Z'), own('P0', '2026-12-01T08:00:00Z'));
    assert.notEqual(own(null, '2026-12-01T08:00:00Z'), own('P2', '2026-12-01T08:00:00Z'));
    // An item with no priority keeps the rev it had before priorities, so an upgrade relights nothing new.
    assert.doesNotMatch(listed(pr({ author: user('mira') })).rev!, /\|p/);
  });

  it('finds an issue assigned to you in a maintained repository without a search', () => {
    const item = listed(issue({ assignees: { nodes: [{ login: ME }] } }));
    assert.equal(item.fields!.reason, 'assigned');
    assert.equal(item.suggested, 'triage');
  });

  it('lists everything open in a maintained repository, with no reason when it doesn-t involve you', () => {
    const items = toItems({}, ME, [
      repo('acme/lantern', {
        prs: [pr({ ...inLantern(1), author: user('mira') }), pr({ ...inLantern(2), author: user('ben') }, failing)],
        issues: [issue({ ...inLantern(3, 'issues'), author: user(ME) }), issue({ ...inLantern(4, 'issues') })],
      }),
    ]);
    assert.deepEqual(items.map((item) => item.id).sort(), [
      'issue:acme/lantern#3',
      'issue:acme/lantern#4',
      'pr:acme/lantern#1',
      'pr:acme/lantern#2',
    ]);
    assert.ok(items.every((item) => item.fields!.reason === undefined && item.suggested === undefined));
    // Someone else's failing checks still count on the banner.
    assert.equal(items.find((item) => item.id === 'pr:acme/lantern#2')!.fields!.failing, 'test (ubuntu), ci/legacy');
  });

  it('lists an item found twice once, with the richer reason', () => {
    const theirs = pr({ ...inLantern(8), author: user('ana') });
    const items = toItems({ review: { nodes: [theirs] }, mine: { nodes: [] } }, ME, [
      repo('acme/lantern', { prs: [theirs] }),
    ]);
    assert.equal(items.length, 1);
    assert.equal(items[0]!.fields!.reason, 'review');
    assert.equal(items[0]!.project!.owned, true);
  });

  it('leaves out an excluded repository-s items, even ones a search found', () => {
    assert.deepEqual(toItems({ mine: { nodes: [pr({}, failing)] } }, ME, [], { exclude: ['ACME/widgets'] }), []);
  });

  it('changes rev when someone acts or the reason changes, not for a bot, you or a busy repository', () => {
    const before = listed(pr({ author: user('mira') })).rev;
    assert.equal(listed(pr({ author: user('mira'), updatedAt: T(59) })).rev, before);
    assert.equal(
      listed(pr({ author: user('mira'), comments: { nodes: [{ author: bot('ci-bot'), createdAt: T(55) }] } })).rev,
      before,
    );
    assert.equal(
      listed(pr({ author: user('mira'), comments: { nodes: [{ author: user(ME), createdAt: T(55) }] } })).rev,
      before,
    );
    assert.notEqual(
      listed(pr({ author: user('mira'), comments: { nodes: [{ author: user('ana'), createdAt: T(55) }] } })).rev,
      before,
    );
    const mine = one(pr()).rev;
    assert.notEqual(one(pr({}, failing)).rev, mine);
    const otherFailure = { state: 'FAILURE', nodes: [{ __typename: 'CheckRun', name: 'e2e', conclusion: 'FAILURE' }] };
    assert.notEqual(one(pr({}, otherFailure)).rev, one(pr({}, failing)).rev);
  });

  it('keeps the items that need you when there are more than a Board takes', () => {
    const many = Array.from({ length: 5 }, (_, at) =>
      issue({ ...inLantern(at + 1, 'issues'), updatedAt: T(at), id: `I_${at}` }),
    );
    const items = toItems({ mine: { nodes: [pr({}, failing)] } }, ME, [repo('acme/lantern', { issues: many })], {
      max: 3,
    });
    assert.deepEqual(items.map((item) => item.id).sort(), [
      'issue:acme/lantern#4',
      'issue:acme/lantern#5',
      'pr:acme/widgets#7',
    ]);
  });

  it('keeps a project name within what a Board takes, so a long repository name still has its project', () => {
    const long = `acme/${'x'.repeat(105)}`;
    assert.equal(long.length, 110);
    const node = pr({ repository: { ...WIDGETS, nameWithOwner: long, name: 'x'.repeat(105) } });
    const items = toItems({ mine: { nodes: [node] } }, ME);
    assert.ok(items[0]!.project!.name.length <= 100);
    assert.match(items[0]!.project!.name, /^acme\/x+…$/);
    assert.ok(ScoutItems.safeParse({ items }).success, JSON.stringify(ScoutItems.safeParse({ items }).error?.issues));
  });

  it('reports how many items it dropped past the most a Board takes, and none when all fit', () => {
    const many = Array.from({ length: 5 }, (_, at) => issue({ ...inLantern(at + 1, 'issues'), id: `I_${at}` }));
    const dropped: number[] = [];
    toItems({}, ME, [repo('acme/lantern', { issues: many })], {
      max: 5,
      onDropped: (count: number) => dropped.push(count),
    });
    assert.deepEqual(dropped, []);
    toItems({}, ME, [repo('acme/lantern', { issues: many })], {
      max: 3,
      onDropped: (count: number) => dropped.push(count),
    });
    assert.deepEqual(dropped, [2]);
  });

  it('prints only what a Board accepts', () => {
    const items = toItems(
      { mine: { nodes: [pr({}, failing), pr({ id: 'PR_9', number: 9 })] }, assigned: { nodes: [issue()] } },
      ME,
      [repo('acme/lantern', { prs: [pr({ ...inLantern(1), author: user('mira') })], issues: [issue(inLantern(2))] })],
    );
    assert.ok(ScoutItems.safeParse({ items }).success, JSON.stringify(ScoutItems.safeParse({ items }).error?.issues));
  });
});

describe('scout.json', () => {
  it('is a projects Board this release loads, drawing every kind and reason the collector gives', () => {
    const manifest = ScoutManifest.parse(JSON.parse(readFileSync(join(HERE, 'scout.json'), 'utf8')));
    assert.equal(manifest.view, 'projects');
    assert.ok(manifest.projects, 'the projects block loads');
    const items = toItems(
      {
        mine: {
          nodes: [
            pr({}, failing),
            pr({
              id: 'PR_4',
              number: 4,
              reviewDecision: 'CHANGES_REQUESTED',
              reviews: { nodes: [{ author: user('ben'), submittedAt: T(40), state: 'CHANGES_REQUESTED' }] },
            }),
            pr({ id: 'PR_5', number: 5, mergeStateStatus: 'CLEAN' }),
            pr({ id: 'PR_6', number: 6, comments: { nodes: [{ author: user('mira'), createdAt: T(45) }] } }),
            pr({ id: 'PR_3', number: 3, isDraft: true }),
          ],
        },
        review: { nodes: [pr({ id: 'PR_2', number: 8, author: user('ana') })] },
        assigned: {
          nodes: [
            issue(),
            issue({ number: 13, labels: { nodes: [{ name: 'bug', color: 'd73a4a' }] } }),
            issue({ number: 14, author: user(ME), assignees: { nodes: [{ login: ME }] } }),
          ],
        },
        discussions: {
          nodes: [
            {
              __typename: 'Discussion',
              id: 'D_1',
              number: 3,
              title: 'How?',
              url: 'https://github.com/acme/widgets/discussions/3',
              updatedAt: T(1),
              repository: WIDGETS,
              author: user(ME),
              labels: { nodes: [] },
              comments: { nodes: [] },
            },
          ],
        },
      },
      ME,
    );
    const named = new Set(items.flatMap((item) => item.actions ?? []));
    assert.deepEqual(
      [...named].filter((key) => !(key in manifest.actions)),
      [],
    );
    const reasons = new Set(items.flatMap((item) => (item.fields!.reason ? [item.fields!.reason as string] : [])));
    assert.deepEqual([...reasons].sort(), ['assigned', 'changes', 'fail', 'merge', 'next', 'reply', 'review']);
    for (const reason of reasons) assert.ok(reason in manifest.projects!.reasons!.values, reason);
    // Your own issues go to the queue window; everything else someone is waiting on stays in Needs you.
    const lanes = Object.entries(manifest.projects!.reasons!.values).filter(([, look]) => look.lane === 'queue');
    assert.deepEqual(
      lanes.map(([key]) => key),
      ['next'],
    );
    assert.deepEqual(manifest.projects!.queue, { title: 'Your queue', priority: 'priority', due: 'due' });
    for (const item of items) assert.ok((item.fields!.kind as string) in manifest.projects!.kind!.values);
    for (const action of Object.values(manifest.actions)) {
      if (action.kind === 'quest') readFileSync(join(HERE, action.prompt), 'utf8');
    }
  });
});

describe('collect', () => {
  let state: string;
  beforeEach(() => {
    state = mkdtempSync(join(tmpdir(), 'cb-github-scout-'));
  });
  afterEach(() => rmSync(state, { recursive: true, force: true }));

  const recent = new Date(NOW - DAY).toISOString();
  const owned = (nameWithOwner: string) => ({
    nameWithOwner,
    viewerPermission: 'ADMIN',
    isArchived: false,
    isFork: false,
    hasIssuesEnabled: true,
    pushedAt: recent,
  });

  /**
   * A stand-in for `gh`: records each call and answers the notifications check, the searches and the per-repository
   * lists, from `repos` (what the viewer has) and `answers` (what each repository lists, `null` for one it can't read).
   */
  function fakeGh(
    notifications: 'changed' | 'same',
    {
      repos = [owned('acme/lantern')],
      answers = { 'acme/lantern': repo('acme/lantern', { prs: [pr({ ...inLantern(1), author: user('mira') })] }) },
      errors = [],
      pages = [repos],
      down = [],
      limited,
    }: {
      repos?: unknown[];
      answers?: Record<string, unknown>;
      errors?: unknown[];
      /** The viewer's repositories a page at a time; a page has a next one when another follows. */
      pages?: unknown[][];
      /** Repositories whose batch fails outright, with no data, as a 502 does. */
      down?: string[];
      /** Every repository batch hits GitHub's secondary rate limit, which answers in REST's shape or only on stderr. */
      limited?: 'body' | 'stderr';
    } = {},
  ) {
    const calls: string[][] = [];
    const gh = async (args: string[]) => {
      calls.push(args);
      if (args.includes('notifications')) {
        if (notifications === 'same')
          return { code: 1, stdout: 'HTTP/2.0 304 Not Modified\r\n\r\n', stderr: 'gh: HTTP 304\n' };
        return { code: 0, stdout: 'HTTP/2.0 200 OK\r\nEtag: W/"two"\r\n\r\n[]', stderr: '' };
      }
      const text = args.join(' ');
      const pageAt = (index: number) => ({
        pageInfo: { hasNextPage: index < pages.length - 1, endCursor: `c${index + 1}` },
        nodes: pages[index],
      });
      if (!text.includes('search(') && text.includes('repositories(')) {
        const index = Number(/after: "c(\d+)"/.exec(text)?.[1] ?? 'NaN');
        return { code: 0, stdout: JSON.stringify({ data: { viewer: { repositories: pageAt(index) } } }), stderr: '' };
      }
      if (text.includes('search(')) {
        const data = {
          viewer: { login: ME, repositories: pageAt(0) },
          mine: { nodes: [pr({}, failing)] },
          review: { nodes: [] },
          assigned: { nodes: [] },
          authored: { nodes: [] },
        };
        return { code: 0, stdout: JSON.stringify({ data }), stderr: '' };
      }
      const data: Record<string, unknown> = {};
      for (const [, alias, owner, name] of text.matchAll(/(r\d+): repository\(owner: "([^"]+)", name: "([^"]+)"\)/g)) {
        data[alias!] = answers[`${owner}/${name}`] ?? null;
      }
      if (limited === 'body') {
        const body = { message: 'You have exceeded a secondary rate limit. Please wait a few minutes.' };
        return {
          code: 1,
          stdout: JSON.stringify(body),
          stderr: 'gh: You have exceeded a secondary rate limit (HTTP 403)',
        };
      }
      if (limited === 'stderr') return { code: 1, stdout: '', stderr: 'gh: API rate limit exceeded (HTTP 429)' };
      if (down.some((name) => text.includes(`name: "${name.split('/')[1]}"`))) {
        return { code: 1, stdout: '', stderr: 'gh: HTTP 502: Bad Gateway' };
      }
      const failed = errors.length > 0 || Object.values(data).includes(null);
      const body = failed
        ? {
            data,
            errors: errors.length > 0 ? errors : [{ type: 'NOT_FOUND', path: ['r1'], message: 'Could not resolve' }],
          }
        : { data };
      return { code: failed ? 1 : 0, stdout: JSON.stringify(body), stderr: failed ? 'gh: GraphQL: error' : '' };
    };
    return { gh, calls };
  }

  const graphqlCalls = (calls: string[][]) => calls.filter((args) => args.includes('graphql'));

  it('searches, lists the maintained repositories, and keeps the list with the notifications ETag', async () => {
    const { gh, calls } = fakeGh('changed');
    const out = await collect({ gh, state, now: NOW, settings: {} });
    assert.deepEqual(out.items.map((item: { id: string }) => item.id).sort(), [
      'pr:acme/lantern#1',
      'pr:acme/widgets#7',
    ]);
    assert.equal(graphqlCalls(calls).length, 2);
    assert.equal(JSON.parse(readFileSync(join(state, 'cache.json'), 'utf8')).etag, 'W/"two"');
  });

  const repoCalls = (calls: string[][]) =>
    graphqlCalls(calls).filter((args) => args.join(' ').includes('repositories('));
  const page = (prefix: string, count: number, daysAgo = 1) =>
    Array.from({ length: count }, (_, index) => ({
      ...owned(`acme/${prefix}${index}`),
      pushedAt: new Date(NOW - daysAgo * DAY).toISOString(),
    }));

  it('reads the next page of your repositories with the cursor, and lists what it holds', async () => {
    const { gh, calls } = fakeGh('changed', {
      pages: [page('a', 1), page('b', 1)],
      answers: { 'acme/a0': repo('acme/a0'), 'acme/b0': repo('acme/b0', { issues: [issue(inLantern(3, 'issues'))] }) },
    });
    const out = await collect({ gh, state, now: NOW, settings: {}, log: () => {} });
    const second = repoCalls(calls)[1]!.join(' ');
    assert.match(second, /after: "c1"/);
    assert.equal(repoCalls(calls).length, 2);
    assert.ok(graphqlCalls(calls).some((args) => args.join(' ').includes('name: "b0"')));
    assert.ok(out.items.some((item: { id: string }) => item.id === 'issue:acme/lantern#3'));
  });

  it('reads no more pages once the last repository on one was pushed before the window', async () => {
    const { gh, calls } = fakeGh('changed', {
      pages: [page('a', 2, 200), page('b', 1)],
      answers: {},
    });
    await collect({ gh, state, now: NOW, settings: { activeDays: 90 }, log: () => {} });
    assert.equal(repoCalls(calls).length, 1);
  });

  it('reads at most MAX_PAGES pages, and says so when there were more', async () => {
    const notes: string[] = [];
    const pages = Array.from({ length: MAX_PAGES + 3 }, (_, index) => page(`p${index}-`, 1));
    const { gh, calls } = fakeGh('changed', { pages, answers: {} });
    await collect({ gh, state, now: NOW, settings: { maxRepos: 1 }, log: (line: string) => notes.push(line) });
    assert.equal(repoCalls(calls).length, MAX_PAGES);
    assert.match(notes.join('\n'), new RegExp(`read the newest ${MAX_PAGES * 100} repositories.*include`));
    const few = fakeGh('changed', { pages: [page('q', 1)], answers: {} });
    const quiet: string[] = [];
    await collect({ gh: few.gh, state, now: NOW, settings: {}, log: (line: string) => quiet.push(line) });
    assert.doesNotMatch(quiet.join('\n'), /newest/);
  });

  it('lists only `maxRepos` maintained repositories, newest push first, and says how many it left out', async () => {
    const notes: string[] = [];
    const repos = [3, 1, 2].map((days) => ({
      ...owned(`acme/d${days}`),
      pushedAt: new Date(NOW - days * DAY).toISOString(),
    }));
    const { gh, calls } = fakeGh('changed', { repos, answers: {} });
    await collect({
      gh,
      state,
      now: NOW,
      settings: { maxRepos: 1, include: ['mira/pinned'] },
      log: (line: string) => notes.push(line),
    });
    const listed = graphqlCalls(calls)
      .filter((args) => args.join(' ').includes(': repository('))[0]!
      .join(' ');
    assert.match(listed, /name: "pinned"/);
    assert.doesNotMatch(listed, /name: "d\d"/);
    assert.match(notes.join('\n'), /left out 3.*maxRepos.*include/);
    const room = fakeGh('changed', { repos, answers: {} });
    await collect({ gh: room.gh, state, now: NOW, settings: { maxRepos: 2 }, log: () => {} });
    const text = graphqlCalls(room.calls)
      .filter((args) => args.join(' ').includes(': repository('))[0]!
      .join(' ');
    assert.match(text, /name: "d1"/);
    assert.match(text, /name: "d2"/);
    assert.doesNotMatch(text, /name: "d3"/);
  });

  it('skips the repositories of a batch that fails outright, with a note, and keeps the rest', async () => {
    const notes: string[] = [];
    const names = ['a', 'b', 'c', 'd', 'e', 'f'].map((name) => `acme/${name}`);
    const { gh } = fakeGh('changed', {
      repos: names.map(owned),
      answers: Object.fromEntries(names.map((name) => [name, repo(name, { issues: [issue(inLantern(9, 'issues'))] })])),
      down: ['acme/b'],
    });
    const out = await collect({
      gh,
      state,
      now: NOW,
      settings: { maxRepos: 10 },
      log: (line: string) => notes.push(line),
    });
    assert.ok(out.items.some((item: { id: string }) => item.id === 'issue:acme/lantern#9'));
    assert.match(notes.join('\n'), /skipped acme\/a, acme\/b, acme\/c, acme\/d, acme\/e.*502/s);
  });

  it('fails the run on a secondary rate limit, whether GitHub says so in the body or only on stderr', async () => {
    for (const limited of ['body', 'stderr'] as const) {
      const { gh, calls } = fakeGh('changed', {
        repos: ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => owned(`acme/${n}`)),
        limited,
      });
      await assert.rejects(collect({ gh, state, now: NOW, settings: {}, log: () => {} }), /rate limit/);
      // It stops at the first limited batch rather than spending more requests.
      assert.equal(graphqlCalls(calls).filter((args) => !args.join(' ').includes('search(')).length, 1);
    }
  });

  it('keeps no list after a skipped batch, so the next run reads everything again', async () => {
    const names = ['a', 'b', 'c', 'd', 'e', 'f'].map((name) => `acme/${name}`);
    const answers = Object.fromEntries(names.map((name) => [name, repo(name)]));
    const flaky = fakeGh('changed', { repos: names.map(owned), answers, down: ['acme/b'] });
    await collect({ gh: flaky.gh, state, now: NOW, settings: {}, log: () => {} });
    const next = fakeGh('same', { repos: names.map(owned), answers });
    await collect({ gh: next.gh, state, now: NOW + 60_000, settings: {}, log: () => {} });
    assert.ok(graphqlCalls(next.calls).length > 0);
  });

  it('fails the run when every batch failed, so the Board keeps its last list', async () => {
    const names = ['a', 'b'].map((name) => `acme/${name}`);
    const { gh } = fakeGh('changed', { repos: names.map(owned), down: ['acme/a'] });
    await assert.rejects(
      collect({ gh, state, now: NOW, settings: {}, log: () => {} }),
      /couldn't read any of your repositories/,
    );
  });

  it('logs the cap on items only when it dropped some', async () => {
    const lots = (count: number) =>
      Array.from({ length: count }, (_, at) =>
        issue({ ...inLantern(at + 1, 'issues'), id: `I_${at}`, number: at + 1 }),
      );
    const run = async (count: number) => {
      const notes: string[] = [];
      const { gh } = fakeGh('changed', { answers: { 'acme/lantern': repo('acme/lantern', { issues: lots(count) }) } });
      await collect({ gh, state, now: NOW, settings: {}, log: (line: string) => notes.push(line) });
      return notes.join('\n');
    };
    // The search's own pull request makes one more item than the repository lists.
    assert.doesNotMatch(await run(999), /kept 1000/);
    assert.match(await run(1000), /kept 1000 items/);
  });

  it('lists the maintained repositories five to a call, `perProject` of each', async () => {
    const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((name) => `acme/${name}`);
    const { gh, calls } = fakeGh('changed', {
      repos: names.map(owned),
      answers: Object.fromEntries(names.map((name) => [name, repo(name)])),
    });
    await collect({ gh, state, now: NOW, settings: { perProject: 20 } });
    const lists = graphqlCalls(calls).filter((args) => !args.join(' ').includes('search('));
    assert.equal(lists.length, 2);
    assert.equal(lists[0]!.join(' ').match(/: repository\(/g)!.length, 5);
    assert.equal(lists[1]!.join(' ').match(/: repository\(/g)!.length, 2);
    assert.match(lists[0]!.join(' '), /pullRequests\(states: OPEN, first: 20,/);
  });

  it('skips a repository it can-t read, with a note on stderr', async () => {
    const notes: string[] = [];
    const { gh } = fakeGh('changed', {
      repos: [owned('acme/lantern')],
      answers: { 'acme/lantern': repo('acme/lantern') },
    });
    const out = await collect({
      gh,
      state,
      now: NOW,
      settings: { include: ['mira/secret'] },
      log: (line: string) => notes.push(line),
    });
    assert.deepEqual(
      out.items.map((item: { id: string }) => item.id),
      ['pr:acme/widgets#7'],
    );
    assert.match(notes.join('\n'), /mira\/secret/);
  });

  it('fails the run on GitHub-s rate limit, with its reason', async () => {
    const { gh } = fakeGh('changed', {
      errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded for user' }],
    });
    await assert.rejects(collect({ gh, state, now: NOW, settings: {}, log: () => {} }), /rate limit/);
  });

  it('keys a kept list on a format that changed with the queue lane', () => {
    assert.equal(JSON.parse(cacheKey({})).format, 3);
  });

  it('searches again when the kept list came from another version or other settings', async () => {
    const kept = (key: unknown) =>
      writeFileSync(join(state, 'cache.json'), JSON.stringify({ key, etag: 'W/"one"', at: 0, items: [] }));
    kept(undefined);
    const older = fakeGh('same');
    await collect({ gh: older.gh, state, now: 60_000, settings: {} });
    assert.equal(graphqlCalls(older.calls).length, 2);
    kept(cacheKey({}));
    const changed = fakeGh('same');
    await collect({ gh: changed.gh, state, now: 60_000, settings: { exclude: ['acme/lantern'] } });
    assert.ok(graphqlCalls(changed.calls).length > 0);
    kept(cacheKey({ exclude: ['acme/lantern'] }));
    const same = fakeGh('same');
    await collect({ gh: same.gh, state, now: 60_000, settings: { exclude: ['acme/lantern'] } });
    assert.equal(graphqlCalls(same.calls).length, 0);
  });

  it('prints the kept list without searching when nothing changed, until it is an hour old', async () => {
    writeFileSync(
      join(state, 'cache.json'),
      JSON.stringify({ key: cacheKey({}), etag: 'W/"one"', at: 0, items: [{ id: 'kept', title: 'Kept' }] }),
    );
    const quiet = fakeGh('same');
    const out = await collect({ gh: quiet.gh, state, now: 59 * 60_000, settings: {} });
    assert.deepEqual(out.items, [{ id: 'kept', title: 'Kept' }]);
    assert.ok(quiet.calls.some((args) => args.includes('If-None-Match: W/"one"')));
    assert.equal(graphqlCalls(quiet.calls).length, 0);
    const stale = fakeGh('same');
    await collect({ gh: stale.gh, state, now: 61 * 60_000, settings: {} });
    assert.equal(graphqlCalls(stale.calls).length, 2);
    writeFileSync(join(state, 'cache.json'), JSON.stringify({ key: cacheKey({}), etag: 'W/"one"', at: 0, items: [] }));
    const shorter = fakeGh('same');
    await collect({ gh: shorter.gh, state, now: 11 * 60_000, settings: { refreshMinutes: 10 } });
    assert.ok(graphqlCalls(shorter.calls).length > 0);
  });

  it('searches Discussions only when the settings ask', async () => {
    const plain = fakeGh('changed');
    await collect({ gh: plain.gh, state, now: NOW, settings: {} });
    assert.ok(!plain.calls.flat().join(' ').includes('DISCUSSION'));
    const asked = fakeGh('changed');
    await collect({ gh: asked.gh, state, now: NOW, settings: { discussions: true } });
    assert.ok(asked.calls.flat().join(' ').includes('DISCUSSION'));
  });

  it('says plainly when gh is missing or not logged in', async () => {
    const missing = async () => ({ code: -1, stdout: '', stderr: 'spawn gh ENOENT' });
    await assert.rejects(collect({ gh: missing, state, now: 0, settings: {} }), /gh isn't installed/);
    const out = async () => ({
      code: 4,
      stdout: '',
      stderr: 'To get started with GitHub CLI, please run:  gh auth login',
    });
    await assert.rejects(collect({ gh: out, state, now: 0, settings: {} }), /gh auth login/);
  });
});

describe('collect.mjs run as a command', () => {
  // A folder reached through a symlink, such as macOS's /tmp or dotfiles, must still run, never print nothing and exit 0.
  it(
    'runs through a symlinked folder, and fails plainly when gh is missing',
    { skip: process.platform === 'win32' },
    () => {
      const root = mkdtempSync(join(tmpdir(), 'cb-github-run-'));
      try {
        mkdirSync(join(root, 'real'));
        copyFileSync(join(HERE, 'collect.mjs'), join(root, 'real', 'collect.mjs'));
        symlinkSync(join(root, 'real'), join(root, 'linked'));
        const run = spawnSync(process.execPath, [join(root, 'linked', 'collect.mjs')], {
          cwd: join(root, 'linked'),
          env: { PATH: join(root, 'no-bin'), CRYSTAL_SCOUT_STATE: join(root, 'state') },
          encoding: 'utf8',
        });
        assert.equal(run.status, 1);
        assert.match(run.stderr, /gh isn't installed/);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
