#!/usr/bin/env node
/**
 * An example Scout collector (docs/SCOUTS.md): the pull requests, issues and, if asked, Discussions that want your
 * attention on GitHub, sorted into groups for a Board. It uses the Kingdom's own `gh` login and stores no token.
 *
 * Node only, no packages, so it runs wherever Crystal does. `settings.json` beside it is optional:
 *   { "discussions": true, "refreshMinutes": 60 }
 */
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The groups, in the order the Board shows them. */
export const GROUPS = [
  'Needs your review',
  'Needs a fix',
  'Ready to merge',
  'Waiting on others',
  'Your issues',
  'Unanswered discussions',
];

const PR_FIELDS = `
  id number title url isDraft updatedAt
  repository { nameWithOwner name }
  author { login __typename }
  reviewDecision mergeStateStatus
  commits(last: 1) { nodes { commit {
    committedDate author { user { login } }
    statusCheckRollup { state contexts(first: 50) { nodes {
      __typename
      ... on CheckRun { name conclusion status }
      ... on StatusContext { context state }
    } } }
  } } }
  comments(last: 10) { nodes { author { login __typename } authorAssociation createdAt } }
  reviews(last: 10) { nodes { author { login __typename } authorAssociation submittedAt state } }`;

const ISSUE_FIELDS = `
  id number title url updatedAt
  repository { nameWithOwner name }
  author { login __typename }
  comments(last: 10) { nodes { author { login __typename } authorAssociation createdAt } }`;

const search = (alias, query, type = 'ISSUE') =>
  `${alias}: search(query: ${JSON.stringify(query)}, type: ${type}, first: 50) { nodes { __typename
    ... on PullRequest { ${PR_FIELDS} }
    ... on Issue { ${ISSUE_FIELDS} }
    ${type === 'DISCUSSION' ? `... on Discussion { ${ISSUE_FIELDS} }` : ''}
  } }`;

/** One GraphQL call for every search: a few points of the hourly 5,000. */
export function query(settings = {}) {
  const searches = [
    search('mine', 'is:open is:pr author:@me archived:false'),
    search('review', 'is:open is:pr review-requested:@me archived:false'),
    search('assigned', 'is:open is:issue assignee:@me archived:false'),
    search('authored', 'is:open is:issue author:@me archived:false'),
  ];
  if (settings.discussions) searches.push(search('discussions', 'is:open is:unanswered author:@me', 'DISCUSSION'));
  return `query { viewer { login } ${searches.join('\n')} }`;
}

const isBot = (author) => !author || author.__typename === 'Bot' || /\[bot\]$/.test(author.login ?? '');

/**
 * The latest comment, review or push by a person, not a bot, as `{ login, at, association }`; `{}` when there is none.
 * A review not yet submitted has no time and is left out. `approvals` false leaves approvals out too: one asks nothing
 * of you.
 */
function lastWord(node, { approvals = true } = {}) {
  const events = [
    ...(node.comments?.nodes ?? []).map((one) => ({
      author: one.author,
      at: one.createdAt,
      association: one.authorAssociation,
    })),
    ...(node.reviews?.nodes ?? [])
      .filter((one) => approvals || one.state !== 'APPROVED')
      .map((one) => ({ author: one.author, at: one.submittedAt, association: one.authorAssociation })),
    ...(node.commits?.nodes ?? []).map(({ commit }) => ({
      author: commit.author?.user ? { login: commit.author.user.login, __typename: 'User' } : null,
      at: commit.committedDate,
    })),
  ].filter((event) => !isBot(event.author) && typeof event.at === 'string' && event.at !== '');
  const latest = events.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)).at(-1);
  return latest ? { login: latest.author.login, at: latest.at, association: latest.association } : {};
}

/** The latest person, not a bot, who commented, reviewed or pushed: `{ login, at }`, or `{}` when there is none. */
export function lastHuman(node) {
  const { login, at } = lastWord(node);
  return login ? { login, at } : {};
}

/** People with write access: a reply from one of them suggests the answer Quest; anyone else's is only listed. */
const TRUSTED = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

const FAILED_RUNS = new Set(['FAILURE', 'TIMED_OUT', 'STARTUP_FAILURE', 'ACTION_REQUIRED']);

/** Whether a pull request's checks failed on its latest commit, as GitHub sums them up. */
function checksFailed(node) {
  const state = node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state;
  return state === 'FAILURE' || state === 'ERROR';
}

/** The names of a pull request's checks that failed on its latest commit, as far as they can be named. */
export function failingChecks(node) {
  const rollup = node.commits?.nodes?.[0]?.commit?.statusCheckRollup;
  if (!checksFailed(node)) return [];
  return (rollup.contexts?.nodes ?? []).flatMap((check) =>
    check.__typename === 'CheckRun'
      ? FAILED_RUNS.has(check.conclusion)
        ? [check.name]
        : []
      : check.state === 'FAILURE' || check.state === 'ERROR'
        ? [check.context]
        : [],
  );
}

/** Where an item belongs, why, and what it offers. `me` is the `gh` login. */
function classify(node, me, search) {
  const last = lastWord(node, { approvals: false });
  const theirs = last.login && last.login !== me ? `${last.login} replied` : undefined;
  if (node.__typename === 'Discussion') {
    return { group: 'Unanswered discussions', why: theirs ?? 'no answer yet', actions: ['open', 'later', 'done'] };
  }
  if (node.__typename === 'Issue') {
    const why = theirs ?? (node.author?.login === me ? 'waiting on others' : 'assigned to you');
    return { group: 'Your issues', why, actions: ['triage', 'open', 'later', 'done'], suggested: theirs && 'triage' };
  }
  if (search === 'review' || node.author?.login !== me) {
    return { group: 'Needs your review', why: 'review requested', actions: ['open', 'later', 'done'] };
  }
  if (checksFailed(node)) {
    const failed = failingChecks(node);
    return {
      group: 'Needs a fix',
      why: failed.length > 0 ? `checks failing: ${failed.join(', ')}` : 'checks failing',
      actions: ['fix', 'open', 'later'],
      suggested: 'fix',
    };
  }
  if (node.reviewDecision === 'CHANGES_REQUESTED' && last.login !== me) {
    return {
      group: 'Needs a fix',
      why: 'changes requested',
      actions: ['answer', 'open', 'later'],
      suggested: 'answer',
    };
  }
  if (theirs) {
    // Anyone may comment on a public pull request: only a reply from someone with write access suggests the Quest.
    const suggested = TRUSTED.has(last.association) ? { suggested: 'answer' } : {};
    return { group: 'Needs a fix', why: theirs, actions: ['answer', 'open', 'later'], ...suggested };
  }
  if (!node.isDraft && node.mergeStateStatus === 'CLEAN') {
    return { group: 'Ready to merge', why: 'ready to merge', actions: ['open', 'done'] };
  }
  return {
    group: 'Waiting on others',
    why: node.isDraft ? 'draft' : 'waiting on others',
    actions: ['open', 'later', 'done'],
  };
}

const KINDS = { PullRequest: 'pr', Issue: 'issue', Discussion: 'discussion' };
/** Searches a node can turn up in: review requests first, so someone else's pull request reads as one to review. */
const ORDER = ['review', 'mine', 'assigned', 'authored', 'discussions'];

/** The Board's items from the GraphQL answer's searches, each found once, grouped in `GROUPS` order. */
export function toItems(searches, me) {
  const seen = new Map();
  for (const name of ORDER) {
    for (const node of searches[name]?.nodes ?? []) {
      const kind = KINDS[node?.__typename];
      if (!kind) continue;
      const id = `${kind}:${node.repository.nameWithOwner}#${node.number}`;
      if (seen.has(id)) continue;
      const last = lastHuman(node);
      // An issue you opened shows once someone else has the last word: until then it isn't yours to act on.
      if (name === 'authored' && (!last.login || last.login === me)) continue;
      const { group, why, actions, suggested } = classify(node, me, name);
      const failed = kind === 'pr' ? failingChecks(node) : [];
      seen.set(id, {
        id,
        // Back to new when the group changes, someone (not a bot) acts, or the checks change.
        rev: [group, last.at ?? node.updatedAt, failed.join(',')].join('|').slice(0, 200),
        title: node.title.slice(0, 500),
        subtitle: `${node.repository.nameWithOwner}#${node.number} · ${why}`.slice(0, 500),
        url: node.url,
        group,
        fields: {
          kind,
          repo: node.repository.name,
          repository: node.repository.nameWithOwner,
          number: node.number,
          author: node.author?.login ?? null,
          ...(failed.length > 0 ? { checks: failed.join(', ').slice(0, 2000) } : {}),
        },
        actions,
        ...(suggested ? { suggested } : {}),
      });
    }
  }
  return [...seen.values()].sort((a, b) => GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group));
}

/** Runs `gh` with these arguments: `{ code, stdout, stderr }`, with code -1 when it couldn't start. */
export function runGh(args) {
  return new Promise((resolve) => {
    execFile('gh', args, { maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : -1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr || (code === -1 ? error.message : '')) });
    });
  });
}

function ghFailed(result) {
  if (result.code === -1) return new Error(`gh isn't installed or isn't on the PATH: ${result.stderr.trim()}`);
  if (/gh auth login/.test(result.stderr)) return new Error('gh is not logged in on this Kingdom: run gh auth login');
  return new Error(`gh failed (${result.code}): ${result.stderr.trim().slice(-500)}`);
}

/**
 * Whether anything changed since the list was kept, by the notifications API's ETag: a "not modified" answer costs no
 * rate limit. `{ same: true }`, or `{ same: false, etag }` with the new ETag, if any.
 */
async function notificationsCheck(gh, etag) {
  const args = ['api', '-i', 'notifications', ...(etag ? ['-H', `If-None-Match: ${etag}`] : [])];
  const result = await gh(args);
  if (/^HTTP\/[\d.]+ 304/m.test(result.stdout) || /HTTP 304/.test(result.stderr)) return { same: true };
  if (result.code !== 0) return { same: false };
  return { same: false, etag: /^etag:\s*(.+?)\s*$/im.exec(result.stdout)?.[1] };
}

/**
 * The whole run: the kept list when nothing changed and it is newer than `refreshMinutes` (60 by default; a check
 * finishing makes no notification, so the list is searched again at least that often), a fresh search otherwise.
 */
export async function collect({ gh = runGh, state, now = Date.now(), settings = {} }) {
  const cacheFile = join(state, 'cache.json');
  let cache;
  try {
    cache = JSON.parse(readFileSync(cacheFile, 'utf8'));
  } catch {
    cache = undefined;
  }
  const maxAge = (Number(settings.refreshMinutes) > 0 ? Number(settings.refreshMinutes) : 60) * 60_000;
  const check = await notificationsCheck(gh, cache?.etag);
  if (check.same && cache && Array.isArray(cache.items) && now - cache.at < maxAge) return { items: cache.items };

  const result = await gh(['api', 'graphql', '-f', `query=${query(settings)}`]);
  if (result.code !== 0) throw ghFailed(result);
  const { data } = JSON.parse(result.stdout);
  const items = toItems(data, data.viewer.login);
  mkdirSync(state, { recursive: true });
  writeFileSync(cacheFile, JSON.stringify({ etag: check.etag ?? cache?.etag, at: now, items }));
  return { items };
}

/** `settings.json` beside `scout.json`: none is fine, but one that isn't JSON fails the run rather than being ignored. */
export function readSettings(folder) {
  let text;
  try {
    text = readFileSync(join(folder, 'settings.json'), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`settings.json isn't JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Whether this file is the command being run, through a symlink or not, rather than imported by a test. */
function isMain() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  const folder = dirname(fileURLToPath(import.meta.url));
  const state = process.env.CRYSTAL_SCOUT_STATE || join(folder, 'state');
  Promise.resolve()
    .then(() => collect({ state, settings: readSettings(folder) }))
    .then(
      (out) => process.stdout.write(`${JSON.stringify(out)}\n`),
      (error) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
      },
    );
}
