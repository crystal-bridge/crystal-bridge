import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ScoutItems, ScoutManifest } from '../../../packages/protocol/src/index.ts';
import { collect, failingChecks, lastHuman, readSettings, toItems } from './collect.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ME = 'octo-me';
const T = (minute: number) => `2026-11-18T10:${String(minute).padStart(2, '0')}:00Z`;

const user = (login: string) => ({ login, __typename: 'User' });
const bot = (login: string) => ({ login, __typename: 'Bot' });

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
    repository: { nameWithOwner: 'acme/widgets', name: 'widgets' },
    author: user(ME),
    reviewDecision: null,
    mergeStateStatus: 'BLOCKED',
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
    comments: { nodes: [] },
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
    repository: { nameWithOwner: 'acme/widgets', name: 'widgets' },
    author: user('someone'),
    comments: { nodes: [] },
    ...extra,
  };
}

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

describe('toItems', () => {
  it('puts your pull request with failing checks under Needs a fix, offering the fix Quest with the check names', () => {
    const item = one(pr({}, failing));
    assert.equal(item.group, 'Needs a fix');
    assert.equal(item.id, 'pr:acme/widgets#7');
    assert.equal(item.suggested, 'fix');
    assert.ok(item.actions.includes('fix'));
    assert.equal(item.fields.checks, 'test (ubuntu), ci/legacy');
    assert.equal(item.fields.repo, 'widgets');
    assert.match(item.subtitle, /^acme\/widgets#7 · checks failing: test \(ubuntu\)/);
  });

  it('puts a review asking for changes, or a reply from someone else, under Needs a fix with the answer Quest', () => {
    const changes = one(
      pr({
        reviewDecision: 'CHANGES_REQUESTED',
        reviews: { nodes: [{ author: user('ben'), submittedAt: T(40), state: 'CHANGES_REQUESTED' }] },
      }),
    );
    assert.equal(changes.group, 'Needs a fix');
    assert.equal(changes.suggested, 'answer');
    const reply = one(pr({ comments: { nodes: [{ author: user('ana'), createdAt: T(45) }] } }));
    assert.equal(reply.group, 'Needs a fix');
    assert.match(reply.subtitle, /ana replied/);
  });

  it('counts an approval as no one waiting on you, so an approved pull request is ready to merge', () => {
    const approved = pr(
      {
        mergeStateStatus: 'CLEAN',
        reviewDecision: 'APPROVED',
        reviews: {
          nodes: [{ author: user('ben'), authorAssociation: 'MEMBER', submittedAt: T(40), state: 'APPROVED' }],
        },
      },
      { state: 'SUCCESS' },
    );
    assert.equal(one(approved).group, 'Ready to merge');
  });

  it('puts failing checks it can-t name under Needs a fix too', () => {
    const cancelled = { state: 'FAILURE', nodes: [{ __typename: 'CheckRun', name: 'e2e', conclusion: 'CANCELLED' }] };
    const item = one(pr({}, cancelled));
    assert.equal(item.group, 'Needs a fix');
    assert.match(item.subtitle, /· checks failing$/);
  });

  it('lists a reply from someone without write access, but suggests no Quest for it', () => {
    const stranger = one(
      pr({ comments: { nodes: [{ author: user('drive-by'), authorAssociation: 'NONE', createdAt: T(45) }] } }),
    );
    assert.equal(stranger.group, 'Needs a fix');
    assert.match(stranger.subtitle, /drive-by replied/);
    assert.equal(stranger.suggested, undefined);
    const member = one(
      pr({ comments: { nodes: [{ author: user('ana'), authorAssociation: 'MEMBER', createdAt: T(45) }] } }),
    );
    assert.equal(member.suggested, 'answer');
  });

  it('puts a pull request GitHub would merge under Ready to merge', () => {
    assert.equal(
      one(pr({ mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED' }, { state: 'SUCCESS' })).group,
      'Ready to merge',
    );
    // A draft is never ready, whatever GitHub says about merging.
    assert.equal(one(pr({ mergeStateStatus: 'CLEAN', isDraft: true })).group, 'Waiting on others');
  });

  it('keeps your pull request under Waiting on others while you had the last word', () => {
    const item = one(pr({ comments: { nodes: [{ author: user(ME), createdAt: T(45) }] } }));
    assert.equal(item.group, 'Waiting on others');
    assert.ok(!item.actions.includes('fix'));
  });

  it('puts a review request under Needs your review, and someone else-s pull request found twice only once', () => {
    const theirs = pr({ id: 'PR_2', number: 8, url: 'https://github.com/acme/widgets/pull/8', author: user('ana') });
    const items = toItems({ review: { nodes: [theirs] }, mine: { nodes: [] }, assigned: { nodes: [theirs] } }, ME);
    assert.equal(items.length, 1);
    assert.equal(items[0]!.group, 'Needs your review');
  });

  it('lists your issues with the triage Quest, and says who it waits on', () => {
    const asked = one(issue({ comments: { nodes: [{ author: user('ana'), createdAt: T(30) }] } }), 'assigned');
    assert.equal(asked.group, 'Your issues');
    assert.equal(asked.id, 'issue:acme/widgets#12');
    assert.ok(asked.actions.includes('triage'));
    assert.match(asked.subtitle, /ana replied/);
    const answered = one(
      issue({ author: user(ME), comments: { nodes: [{ author: user('ana'), createdAt: T(30) }] } }),
      'authored',
    );
    assert.match(answered.subtitle, /ana replied/);
    // One you opened that waits on others is not yours to act on: a roadmap of them would bury the rest.
    assert.deepEqual(toItems({ authored: { nodes: [issue({ author: user(ME) })] } }, ME), []);
    const assignedToo = toItems({ assigned: { nodes: [issue({ author: user(ME) })] } }, ME);
    assert.match(assignedToo[0]!.subtitle, /waiting on others/);
  });

  it('lists an unanswered Discussion you started', () => {
    const discussion = {
      __typename: 'Discussion',
      id: 'D_1',
      number: 3,
      title: 'How do I retry?',
      url: 'https://github.com/acme/widgets/discussions/3',
      updatedAt: T(1),
      repository: { nameWithOwner: 'acme/widgets', name: 'widgets' },
      author: user(ME),
      comments: { nodes: [] },
    };
    const item = one(discussion, 'discussions');
    assert.equal(item.id, 'discussion:acme/widgets#3');
    assert.equal(item.group, 'Unanswered discussions');
    assert.match(item.subtitle, /no answer yet/);
    assert.deepEqual(item.actions, ['open', 'later', 'done']);
  });

  it('changes rev when there is something new to see, and not for a bot', () => {
    const before = one(pr()).rev;
    assert.equal(one(pr({ comments: { nodes: [{ author: bot('ci-bot'), createdAt: T(55) }] } })).rev, before);
    assert.notEqual(one(pr({ comments: { nodes: [{ author: user('ana'), createdAt: T(55) }] } })).rev, before);
    assert.notEqual(one(pr({}, failing)).rev, before);
  });

  it('orders the groups as the Board shows them', () => {
    const items = toItems(
      {
        mine: {
          nodes: [
            pr({ mergeStateStatus: 'CLEAN' }),
            pr({ id: 'PR_3', number: 9, url: 'https://github.com/acme/widgets/pull/9' }, failing),
          ],
        },
        review: {
          nodes: [pr({ id: 'PR_2', number: 8, url: 'https://github.com/acme/widgets/pull/8', author: user('ana') })],
        },
        assigned: { nodes: [issue()] },
      },
      ME,
    );
    assert.deepEqual(
      items.map((item) => item.group),
      ['Needs your review', 'Needs a fix', 'Ready to merge', 'Your issues'],
    );
  });

  it('prints only what a Board accepts', () => {
    const items = toItems(
      { mine: { nodes: [pr({}, failing), pr({ id: 'PR_9', number: 9 })] }, assigned: { nodes: [issue()] } },
      ME,
    );
    assert.ok(ScoutItems.safeParse({ items }).success, JSON.stringify(ScoutItems.safeParse({ items }).error?.issues));
  });
});

describe('scout.json', () => {
  it('is a Scout this release loads, and every action an item names is in it', () => {
    const manifest = ScoutManifest.parse(JSON.parse(readFileSync(join(HERE, 'scout.json'), 'utf8')));
    const items = toItems(
      {
        mine: {
          nodes: [
            pr({}, failing),
            pr({ id: 'PR_4', number: 4, reviewDecision: 'CHANGES_REQUESTED' }),
            pr({ id: 'PR_5', number: 5, mergeStateStatus: 'CLEAN' }),
          ],
        },
        review: { nodes: [pr({ id: 'PR_2', number: 8, author: user('ana') })] },
        assigned: { nodes: [issue()] },
        discussions: {
          nodes: [
            {
              __typename: 'Discussion',
              id: 'D_1',
              number: 3,
              title: 'How?',
              url: 'https://github.com/acme/widgets/discussions/3',
              updatedAt: T(1),
              repository: { nameWithOwner: 'acme/widgets', name: 'widgets' },
              author: user(ME),
              comments: { nodes: [] },
            },
          ],
        },
      },
      ME,
    );
    const named = new Set(items.flatMap((item) => item.actions));
    assert.deepEqual(
      [...named].filter((key) => !(key in manifest.actions)),
      [],
    );
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

  const answer = {
    data: {
      viewer: { login: ME },
      mine: { nodes: [pr({}, failing)] },
      review: { nodes: [] },
      assigned: { nodes: [] },
      authored: { nodes: [] },
    },
  };

  /** A stand-in for `gh`: records each call and answers the notifications check and the search. */
  function fakeGh(notifications: 'changed' | 'same') {
    const calls: string[][] = [];
    const gh = async (args: string[]) => {
      calls.push(args);
      if (args.includes('notifications')) {
        if (notifications === 'same')
          return { code: 1, stdout: 'HTTP/2.0 304 Not Modified\r\n\r\n', stderr: 'gh: HTTP 304\n' };
        return { code: 0, stdout: 'HTTP/2.0 200 OK\r\nEtag: W/"two"\r\n\r\n[]', stderr: '' };
      }
      return { code: 0, stdout: JSON.stringify(answer), stderr: '' };
    };
    return { gh, calls };
  }

  it('searches and keeps the list with the notifications ETag', async () => {
    const { gh, calls } = fakeGh('changed');
    const out = await collect({ gh, state, now: 0, settings: {} });
    assert.equal(out.items[0]!.group, 'Needs a fix');
    assert.equal(calls.filter((args) => args.includes('graphql')).length, 1);
    assert.equal(JSON.parse(readFileSync(join(state, 'cache.json'), 'utf8')).etag, 'W/"two"');
  });

  it('prints the kept list without searching when nothing changed, until it is an hour old', async () => {
    writeFileSync(
      join(state, 'cache.json'),
      JSON.stringify({ etag: 'W/"one"', at: 0, items: [{ id: 'kept', title: 'Kept' }] }),
    );
    const quiet = fakeGh('same');
    const out = await collect({ gh: quiet.gh, state, now: 59 * 60_000, settings: {} });
    assert.deepEqual(out.items, [{ id: 'kept', title: 'Kept' }]);
    assert.ok(quiet.calls.some((args) => args.includes('If-None-Match: W/"one"')));
    assert.equal(quiet.calls.filter((args) => args.includes('graphql')).length, 0);
    const stale = fakeGh('same');
    await collect({ gh: stale.gh, state, now: 61 * 60_000, settings: {} });
    assert.equal(stale.calls.filter((args) => args.includes('graphql')).length, 1);
    writeFileSync(join(state, 'cache.json'), JSON.stringify({ etag: 'W/"one"', at: 0, items: [] }));
    const shorter = fakeGh('same');
    await collect({ gh: shorter.gh, state, now: 11 * 60_000, settings: { refreshMinutes: 10 } });
    assert.equal(shorter.calls.filter((args) => args.includes('graphql')).length, 1);
  });

  it('searches Discussions only when the settings ask', async () => {
    const plain = fakeGh('changed');
    await collect({ gh: plain.gh, state, now: 0, settings: {} });
    assert.ok(!plain.calls.flat().join(' ').includes('DISCUSSION'));
    const asked = fakeGh('changed');
    await collect({ gh: asked.gh, state, now: 0, settings: { discussions: true } });
    assert.ok(asked.calls.flat().join(' ').includes('DISCUSSION'));
  });

  it('refuses a settings.json that isn-t JSON, rather than quietly ignoring it', () => {
    writeFileSync(join(state, 'settings.json'), '{ "discussions": true, }');
    assert.throws(() => readSettings(state), /settings\.json/);
    assert.deepEqual(readSettings(join(state, 'missing')), {});
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
