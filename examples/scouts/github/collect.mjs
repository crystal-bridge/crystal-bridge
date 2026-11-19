#!/usr/bin/env node
/**
 * An example Scout collector (docs/SCOUTS.md) for a `projects` Board: every open pull request and issue in the
 * repositories you maintain, and your own in the ones you contribute to, each with the reason it needs you, if any. It
 * uses the Kingdom's own `gh` login and stores no token.
 *
 * Node only, no packages, so it runs wherever Crystal does. `settings.json` beside it is optional:
 *   { "include": [], "exclude": [], "activeDays": 90, "maxRepos": 30, "perProject": 50, "discussions": false,
 *     "refreshMinutes": 60 }
 */
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The most items a Board takes from one run (`MAX_SCOUT_ITEMS` in the protocol). */
const MAX_ITEMS = 1000;
/** Repositories listed per GraphQL call: each costs about 5 points and well under GitHub's node limit. */
const BATCH = 5;
/** Pages of your repositories to read, 100 each, newest push first, before giving up on older ones. */
export const MAX_PAGES = 5;
/** Maintained repositories listed in full when `maxRepos` isn't set. */
const DEFAULT_MAX_REPOS = 30;

const LABELS = 'labels(first: 10) { nodes { name color } }';
const COMMENTS = 'comments(last: 10) { totalCount nodes { author { login __typename } authorAssociation createdAt } }';
const REPOSITORY = 'repository { nameWithOwner name url description }';

const prFields = (contexts) => `
  id number title url isDraft updatedAt additions deletions
  ${REPOSITORY}
  author { login __typename }
  reviewDecision mergeStateStatus
  ${LABELS}
  commits(last: 1) { nodes { commit {
    committedDate author { user { login } }
    statusCheckRollup { state contexts(first: ${contexts}) { nodes {
      __typename
      ... on CheckRun { name conclusion status }
      ... on StatusContext { context state }
    } } }
  } } }
  ${COMMENTS}
  reviews(last: 10) { nodes { author { login __typename } authorAssociation submittedAt state } }`;

const ISSUE_FIELDS = `
  id number title url updatedAt
  ${REPOSITORY}
  author { login __typename }
  ${LABELS}
  assignees(first: 10) { nodes { login } }
  milestone { title dueOn }
  ${COMMENTS}`;

const DISCUSSION_FIELDS = `
  id number title url updatedAt
  ${REPOSITORY}
  author { login __typename }
  ${LABELS}
  ${COMMENTS}`;

const search = (alias, query, type = 'ISSUE') =>
  `${alias}: search(query: ${JSON.stringify(query)}, type: ${type}, first: 50) { nodes { __typename
    ... on PullRequest { ${prFields(50)} }
    ... on Issue { ${ISSUE_FIELDS} }
    ${type === 'DISCUSSION' ? `... on Discussion { ${DISCUSSION_FIELDS} }` : ''}
  } }`;

/** Your repositories and the orgs', newest push first, to pick the maintained ones from. */
const repositories = (after) =>
  `repositories(first: 100${after ? `, after: ${JSON.stringify(after)}` : ''}, ` +
  'ownerAffiliations: [OWNER, ORGANIZATION_MEMBER], affiliations: [OWNER, ORGANIZATION_MEMBER, COLLABORATOR], ' +
  'orderBy: { field: PUSHED_AT, direction: DESC }) { pageInfo { hasNextPage endCursor } ' +
  'nodes { nameWithOwner viewerPermission isArchived isFork hasIssuesEnabled pushedAt } }';

/** The first call: who you are, your repositories, and every search. A few points of the hourly 5,000. */
export function query(settings = {}) {
  const searches = [
    search('mine', 'is:open is:pr author:@me archived:false'),
    search('review', 'is:open is:pr review-requested:@me archived:false'),
    search('assigned', 'is:open is:issue assignee:@me archived:false'),
    search('authored', 'is:open is:issue author:@me archived:false'),
  ];
  if (settings.discussions) searches.push(search('discussions', 'is:open is:unanswered author:@me', 'DISCUSSION'));
  return `query { viewer { login ${repositories()} } ${searches.join('\n')} }`;
}

/** The next page of your repositories. */
const repositoriesQuery = (after) => `query { viewer { ${repositories(after)} } }`;

/**
 * One call listing these repositories' open pull requests and issues, `perProject` of each, newest updated first, each
 * repository under an alias (`r0`, `r1`, ...). Checks are named from the first 25 per pull request; your own pull
 * requests come from the search too, which names 50.
 */
export function projectsQuery(names, perProject = 50) {
  const order = 'orderBy: { field: UPDATED_AT, direction: DESC }';
  const repos = names.map((nameWithOwner, at) => {
    const [owner, name] = nameWithOwner.split('/');
    return `r${at}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {
      nameWithOwner name url description
      pullRequests(states: OPEN, first: ${perProject}, ${order}) { totalCount nodes { __typename ${prFields(25)} } }
      issues(states: OPEN, first: ${perProject}, ${order}) { totalCount nodes { __typename ${ISSUE_FIELDS} } }
    }`;
  });
  return `query { ${repos.join('\n')} }`;
}

const lower = (name) => name.toLowerCase();

/**
 * The repositories you maintain, sorted: admin or maintain permission, not archived, pushed within `activeDays` (90),
 * and not a fork unless it takes issues of its own; plus `include`, less `exclude`. At most `maxRepos` (30) are kept:
 * `include` always counts first, then the newest pushed.
 */
export function maintainedRepos(repos, settings = {}, now = Date.now()) {
  const cutoff = now - (settings.activeDays ?? 90) * 24 * 60 * 60_000;
  const excluded = new Set((settings.exclude ?? []).map(lower));
  const included = new Set((settings.include ?? []).map(lower));
  const kept = new Map();
  const pushed = new Map();
  for (const repo of repos) {
    if (repo.viewerPermission !== 'ADMIN' && repo.viewerPermission !== 'MAINTAIN') continue;
    if (repo.isArchived || (repo.isFork && !repo.hasIssuesEnabled)) continue;
    if (!(Date.parse(repo.pushedAt) >= cutoff)) continue;
    kept.set(lower(repo.nameWithOwner), repo.nameWithOwner);
    pushed.set(lower(repo.nameWithOwner), Date.parse(repo.pushedAt));
  }
  for (const name of settings.include ?? []) if (!kept.has(lower(name))) kept.set(lower(name), name);
  const candidates = [...kept.entries()].filter(([key]) => !excluded.has(key));
  const first = candidates.filter(([key]) => included.has(key));
  const room = Math.max(0, (settings.maxRepos ?? DEFAULT_MAX_REPOS) - first.length);
  const rest = candidates
    .filter(([key]) => !included.has(key))
    .sort((a, b) => pushed.get(b[0]) - pushed.get(a[0]) || (a[0] < b[0] ? -1 : 1))
    .slice(0, room);
  return [...first, ...rest].map(([, name]) => name).sort();
}

const isBot = (author) => !author || author.__typename === 'Bot' || /\[bot\]$/.test(author.login ?? '');

/**
 * Comments, reviews and pushes by people, not bots, oldest first, as `{ login, at, association }`. A review not yet
 * submitted has no time and is left out. `approvals` false leaves approvals out too: one asks nothing of you.
 */
function humanEvents(node, { approvals = true } = {}) {
  return [
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
  ]
    .filter((event) => !isBot(event.author) && typeof event.at === 'string' && event.at !== '')
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
    .map((event) => ({ login: event.author.login, at: event.at, association: event.association }));
}

/** The latest comment, review or push by a person: `{ login, at, association }`, or `{}` when there is none. */
const lastWord = (node, options) => humanEvents(node, options).at(-1) ?? {};

/** The latest person, not a bot, who commented, reviewed or pushed: `{ login, at }`, or `{}` when there is none. */
export function lastHuman(node) {
  const { login, at } = lastWord(node);
  return login ? { login, at } : {};
}

/** People with write access: a reply from one of them suggests the answer Quest; anyone else's is only listed. */
const TRUSTED = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

const FAILED_RUNS = new Set(['FAILURE', 'TIMED_OUT', 'STARTUP_FAILURE', 'ACTION_REQUIRED']);

const rollupOf = (node) => node.commits?.nodes?.[0]?.commit?.statusCheckRollup;

/** Whether a pull request's checks failed on its latest commit, as GitHub sums them up. */
function checksFailed(node) {
  const state = rollupOf(node)?.state;
  return state === 'FAILURE' || state === 'ERROR';
}

/** The names of a pull request's checks that failed on its latest commit, as far as they can be named. */
export function failingChecks(node) {
  if (!checksFailed(node)) return [];
  return (rollupOf(node).contexts?.nodes ?? []).flatMap((check) =>
    check.__typename === 'CheckRun'
      ? FAILED_RUNS.has(check.conclusion)
        ? [check.name]
        : []
      : check.state === 'FAILURE' || check.state === 'ERROR'
        ? [check.context]
        : [],
  );
}

const CHECKS = { SUCCESS: 'pass', FAILURE: 'fail', ERROR: 'fail', PENDING: 'running', EXPECTED: 'running' };
const REVIEWS = { APPROVED: 'approved', CHANGES_REQUESTED: 'changes', REVIEW_REQUIRED: 'pending' };

/**
 * Why an item needs you, if it does: `{ why, reason?, action?, suggested? }`. `why` is for the subtitle; `reason` is
 * the Board's chip; `action` is the Quest or link that fits, which `suggested` highlights. `found` names the searches
 * that turned the item up.
 */
function classify(node, me, found) {
  const last = lastWord(node, { approvals: false });
  const theirs = last.login && last.login !== me ? `${last.login} replied` : undefined;
  const author = node.author?.login;
  if (node.__typename === 'Discussion') {
    return theirs ? { why: theirs, reason: 'reply' } : { why: 'no answer yet' };
  }
  if (node.__typename === 'Issue') {
    const assigned = found.has('assigned') || (node.assignees?.nodes ?? []).some((one) => one?.login === me);
    if (theirs && (assigned || author === me)) {
      return { why: theirs, reason: 'reply', action: 'triage', suggested: 'triage' };
    }
    if (assigned && author !== me) {
      return { why: 'assigned to you', reason: 'assigned', action: 'triage', suggested: 'triage' };
    }
    // One you opened and assigned to yourself is your own work: it goes to the queue, not to Needs you, with triage
    // offered but not suggested, since nobody is waiting on it.
    if (author === me && assigned) {
      const milestone = String(node.milestone?.title ?? '').trim();
      return { why: milestone ? `your issue · ${milestone}` : 'your issue', reason: 'next', action: 'triage' };
    }
    if (author === me) return { why: 'waiting on others' };
    return { why: `by ${author ?? 'ghost'}` };
  }
  if (found.has('review')) {
    return { why: 'review requested', reason: 'review', action: 'review', suggested: 'review' };
  }
  if (author !== me) return { why: `by ${author ?? 'ghost'}` };
  if (checksFailed(node)) {
    const failed = failingChecks(node);
    const why = failed.length > 0 ? `checks failing: ${failed.join(', ')}` : 'checks failing';
    return { why, reason: 'fail', action: 'fix', suggested: 'fix' };
  }
  if (node.reviewDecision === 'CHANGES_REQUESTED' && last.login !== me) {
    return { why: 'changes requested', reason: 'changes', action: 'answer', suggested: 'answer' };
  }
  if (theirs) {
    // Anyone may comment on a public pull request: only a reply from someone with write access suggests the Quest.
    const suggested = TRUSTED.has(last.association) ? { suggested: 'answer' } : {};
    return { why: theirs, reason: 'reply', action: 'answer', ...suggested };
  }
  if (!node.isDraft && node.mergeStateStatus === 'CLEAN') {
    return { why: 'ready to merge', reason: 'merge', action: 'merge', suggested: 'merge' };
  }
  return { why: node.isDraft ? 'draft' : 'waiting on others' };
}

/** Priority labels such as `P1`, `p0`, `priority: 2` or `priority/3`. */
const PRIORITY = [/^p(\d)$/i, /^priority[:\s/-]*(\d)$/i];

/** The number of the first priority label, lower meaning sooner, or undefined for none. */
function priorityOf(node) {
  for (const label of node.labels?.nodes ?? []) {
    const name = String(label?.name ?? '').trim();
    for (const pattern of PRIORITY) {
      const match = pattern.exec(name);
      if (match) return Number(match[1]);
    }
  }
  return undefined;
}

const KINDS = { PullRequest: 'pr', Issue: 'issue', Discussion: 'discussion' };
/** Searches in the order they're read; a review request makes someone else's pull request one to review. */
const SEARCHES = ['review', 'mine', 'assigned', 'authored', 'discussions'];

/** Label colours with the `#` GitHub leaves off; any other colour is dropped, and at most ten are kept. */
function labelsOf(node) {
  return (node.labels?.nodes ?? [])
    .flatMap((label) => {
      const color = `#${label?.color ?? ''}`;
      const name = String(label?.name ?? '').slice(0, 50);
      return name && /^#[0-9a-fA-F]{6}$/.test(color) ? [{ name, color }] : [];
    })
    .slice(0, 10);
}

/** A project's name is at most 100 characters, the protocol's limit: a longer one is cut, keeping its start. */
function projectName(nameWithOwner) {
  return nameWithOwner.length <= 100 ? nameWithOwner : `${nameWithOwner.slice(0, 99)}…`;
}

function projectOf(repository, owned) {
  const description = String(repository.description ?? '')
    .trim()
    .slice(0, 200)
    .trim();
  return {
    name: projectName(repository.nameWithOwner),
    ...(repository.url ? { url: repository.url } : {}),
    ...(description ? { description } : {}),
    owned,
  };
}

/** One Board item from a node, the searches that found it, and whether its repository is one you maintain. */
function toItem(node, me, found, repository, owned) {
  const type = KINDS[node.__typename];
  const isPr = type === 'pr';
  const labels = labelsOf(node);
  const bug = type === 'issue' && labels.some((label) => label.name.toLowerCase() === 'bug');
  const kind = isPr && node.isDraft ? 'draft' : bug ? 'bug' : type;
  const { why, reason, action, suggested } = classify(node, me, found);
  const failed = isPr ? failingChecks(node) : [];
  // The banner counts `failing`, so a failure no check can be named for still sets it.
  const failing = isPr && checksFailed(node);
  const author = node.author?.login ?? null;
  const mine = author === me;
  const checks = isPr ? CHECKS[rollupOf(node)?.state] : undefined;
  const review = isPr ? REVIEWS[node.reviewDecision] : undefined;
  const priority = priorityOf(node);
  // A milestone's due date is a day, stored as a timestamp: keep the day.
  const due =
    typeof node.milestone?.dueOn === 'string' && node.milestone.dueOn !== ''
      ? node.milestone.dueOn.slice(0, 10)
      : undefined;
  // Back to new only when the reason changes, someone else (not a bot) acts, or your failing checks change: a busy
  // repository's edits, other labels, bot comments, a moved milestone and a changed priority don't relight it. The queue
  // lane's `next` counts as no reason, so an upgrade doesn't bring back an issue you had put away.
  const other = humanEvents(node)
    .filter((event) => event.login !== me)
    .at(-1);
  const rev = [
    reason && reason !== 'next' ? reason : '',
    other?.at ?? '',
    mine && reason === 'fail' ? failed.join(',') : '',
  ];
  return {
    id: `${type}:${repository.nameWithOwner}#${node.number}`,
    rev: rev.join('|').slice(0, 200),
    title: node.title.slice(0, 500),
    subtitle: `${repository.nameWithOwner}#${node.number} · ${why}`.slice(0, 500),
    url: node.url,
    group: repository.nameWithOwner.slice(0, 80),
    project: projectOf(repository, owned),
    ...(labels.length > 0 ? { labels } : {}),
    fields: {
      kind,
      ...(checks ? { checks } : {}),
      ...(review ? { review } : {}),
      ...(reason ? { reason } : {}),
      author,
      login: author,
      updated: node.updatedAt,
      comments: node.comments?.totalCount ?? node.comments?.nodes?.length ?? 0,
      ...(isPr ? { added: node.additions ?? 0, removed: node.deletions ?? 0 } : {}),
      mine,
      repo: repository.name,
      repository: repository.nameWithOwner,
      number: node.number,
      isPr,
      isIssue: type === 'issue',
      ...(priority !== undefined ? { priority } : {}),
      ...(due ? { due } : {}),
      ...(failed.length > 0
        ? { failing: failed.join(', ').slice(0, 2000) }
        : failing
          ? { failing: 'checks failing' }
          : {}),
    },
    actions: [...(action ? [action] : []), 'open', 'later', 'done'],
    ...(suggested ? { suggested } : {}),
    ...(reason ? { summary: why.slice(0, 300) } : {}),
  };
}

/**
 * The Board's items: every open pull request and issue in `listed` (the maintained repositories' lists), and your own
 * from the searches, each found once. `exclude` leaves repositories out; past `max` items, those that need you stay
 * and then the newest; `onDropped` hears how many were left out.
 */
export function toItems(searches, me, listed = [], { exclude = [], max = MAX_ITEMS, onDropped } = {}) {
  const excluded = new Set(exclude.map(lower));
  const owned = new Map(listed.filter(Boolean).map((repo) => [lower(repo.nameWithOwner), repo]));
  const found = new Map();
  const add = (node, source) => {
    const type = KINDS[node?.__typename];
    if (!type || !node.repository) return;
    const name = node.repository.nameWithOwner;
    if (excluded.has(lower(name))) return;
    const id = `${type}:${name}#${node.number}`;
    const entry = found.get(id) ?? { node, sources: new Set() };
    // A search's node names more failing checks than a repository list's, so it wins.
    if (source !== 'repo') entry.node = node;
    entry.sources.add(source);
    found.set(id, entry);
  };
  for (const repo of owned.values()) {
    for (const node of [...(repo.pullRequests?.nodes ?? []), ...(repo.issues?.nodes ?? [])]) add(node, 'repo');
  }
  for (const name of SEARCHES) for (const node of searches[name]?.nodes ?? []) add(node, name);

  const items = [];
  for (const { node, sources } of found.values()) {
    const repo = owned.get(lower(node.repository.nameWithOwner));
    // An issue you opened, in a repository you don't maintain, shows once someone else has the last word.
    if (!repo && sources.size === 1 && sources.has('authored')) {
      const last = lastHuman(node);
      if (!last.login || last.login === me) continue;
    }
    items.push(toItem(node, me, sources, repo ?? node.repository, Boolean(repo)));
  }
  const kept =
    items.length <= max
      ? items
      : items
          .map((item, at) => ({ item, at }))
          .sort(
            (a, b) =>
              Number(!a.item.fields.reason) - Number(!b.item.fields.reason) ||
              (b.item.fields.updated ?? '').localeCompare(a.item.fields.updated ?? '') ||
              a.at - b.at,
          )
          .slice(0, max)
          .map(({ item }) => item);
  if (items.length > kept.length) onDropped?.(items.length - kept.length);
  return kept.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Runs `gh` with these arguments: `{ code, stdout, stderr }`, with code -1 when it couldn't start. */
export function runGh(args) {
  return new Promise((resolve) => {
    execFile('gh', args, { maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
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
 * One GraphQL call's `data`. `gh` exits non-zero when any part of an answer failed, such as a repository the login
 * can't read: those parts are noted on stderr and left out. A rate limit, or an answer with no data, throws.
 */
const RATE_LIMIT = /rate limit|HTTP 429/i;

async function graphql(gh, text, log) {
  const result = await gh(['api', 'graphql', '-f', `query=${text}`]);
  let body;
  try {
    body = JSON.parse(result.stdout);
  } catch {
    body = undefined;
  }
  const errors = Array.isArray(body?.errors) ? body.errors : [];
  // GraphQL's own limit comes as an error in the answer; the secondary limit as a REST message, or only on stderr.
  const limited =
    errors.find((error) => error?.type === 'RATE_LIMITED' || RATE_LIMIT.test(error?.message ?? ''))?.message ??
    [body?.message, result.code !== 0 ? result.stderr : ''].find((text) => RATE_LIMIT.test(text ?? ''));
  if (limited !== undefined) {
    throw Object.assign(
      new Error(`GitHub's rate limit stopped this run: ${String(limited).trim() || 'rate limited'}`),
      {
        rateLimited: true,
      },
    );
  }
  if (!body?.data) throw result.code !== 0 ? ghFailed(result) : new Error('GitHub answered with no data');
  for (const error of errors)
    log(`GitHub: ${error?.message ?? 'an error'}${error?.path ? ` (${error.path.join('.')})` : ''}`);
  return body.data;
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

/** Your repositories, reading more pages while the last one read was still pushed within the window. */
async function yourRepositories(gh, first, settings, now, log) {
  const cutoff = now - (settings.activeDays ?? 90) * 24 * 60 * 60_000;
  const repos = [...(first?.nodes ?? [])];
  let page = first?.pageInfo;
  for (let pages = 1; page?.hasNextPage; pages++) {
    if (!(Date.parse(repos.at(-1)?.pushedAt) >= cutoff)) break;
    if (pages >= MAX_PAGES) {
      log(`read the newest ${MAX_PAGES * 100} repositories; add older ones with include`);
      break;
    }
    const data = await graphql(gh, repositoriesQuery(page.endCursor), log);
    repos.push(...(data.viewer?.repositories?.nodes ?? []));
    page = data.viewer?.repositories?.pageInfo;
  }
  return repos.filter(Boolean);
}

/**
 * The whole run: the kept list when nothing changed and it is newer than `refreshMinutes` (60 by default; a check
 * finishing makes no notification, so the list is searched again at least that often), a fresh one otherwise.
 */
/** Bump when the items' shape or meaning changes, so a list kept by an older collector is searched again. */
const CACHE_FORMAT = 3;

/** What a kept list was made with: this collector's format and the settings, so changing either searches again. */
export function cacheKey(settings) {
  return JSON.stringify({ format: CACHE_FORMAT, settings });
}

export async function collect({
  gh = runGh,
  state,
  now = Date.now(),
  settings = {},
  log = (line) => process.stderr.write(`${line}\n`),
}) {
  const cacheFile = join(state, 'cache.json');
  let cache;
  try {
    cache = JSON.parse(readFileSync(cacheFile, 'utf8'));
  } catch {
    cache = undefined;
  }
  const maxAge = (settings.refreshMinutes ?? 60) * 60_000;
  const check = await notificationsCheck(gh, cache?.etag);
  const key = cacheKey(settings);
  const fresh = cache?.key === key && Array.isArray(cache.items) && now - cache.at < maxAge;
  if (check.same && fresh) return { items: cache.items };

  const data = await graphql(gh, query(settings), log);
  const me = data.viewer.login;
  const yours = await yourRepositories(gh, data.viewer.repositories, settings, now, log);
  const names = maintainedRepos(yours, settings, now);
  const leftOut = maintainedRepos(yours, { ...settings, maxRepos: Infinity }, now).length - names.length;
  if (leftOut > 0) {
    log(
      `listed ${names.length} repositories in full and left out ${leftOut}; raise maxRepos, or add some with include`,
    );
  }
  const listed = [];
  let skipped = 0;
  for (let at = 0; at < names.length; at += BATCH) {
    const batch = names.slice(at, at + BATCH);
    let answer;
    try {
      answer = await graphql(gh, projectsQuery(batch, settings.perProject ?? 50), log);
    } catch (error) {
      if (error?.rateLimited) throw error;
      log(`skipped ${batch.join(', ')}: ${error instanceof Error ? error.message : String(error)}`);
      skipped += 1;
      continue;
    }
    batch.forEach((name, index) => {
      const repo = answer[`r${index}`];
      if (repo) listed.push(repo);
      else log(`skipped ${name}: this login can't read it`);
    });
  }
  // Nothing read at all is an outage, not an empty list: failing keeps the Board's last list.
  if (skipped > 0 && skipped === Math.ceil(names.length / BATCH)) {
    throw new Error("couldn't read any of your repositories this run; the Board keeps its last list");
  }
  const items = toItems(data, me, listed, {
    exclude: settings.exclude ?? [],
    onDropped: (count) =>
      log(`kept ${MAX_ITEMS} items and left out ${count}, those that need you first; lower perProject to see all`),
  });
  // A list with a skipped batch is short: keep none, so the next run reads everything again.
  mkdirSync(state, { recursive: true });
  if (skipped > 0) rmSync(cacheFile, { force: true });
  else writeFileSync(cacheFile, JSON.stringify({ key, etag: check.etag ?? cache?.etag, at: now, items }));
  return { items };
}

const REPO_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SETTINGS = {
  discussions: [(value) => typeof value === 'boolean', 'true or false'],
  refreshMinutes: [(value) => typeof value === 'number' && value > 0, 'a number of minutes above 0'],
  activeDays: [(value) => typeof value === 'number' && value > 0, 'a number of days above 0'],
  maxRepos: [(value) => Number.isInteger(value) && value >= 1 && value <= 200, 'a whole number from 1 to 200'],
  perProject: [(value) => Number.isInteger(value) && value >= 1 && value <= 100, 'a whole number from 1 to 100'],
  include: [(value) => Array.isArray(value) && value.every((one) => REPO_NAME.test(one)), 'a list of "owner/repo"'],
  exclude: [(value) => Array.isArray(value) && value.every((one) => REPO_NAME.test(one)), 'a list of "owner/repo"'],
};

/** The settings, checked: a wrong type or an unknown name fails the run with a message that names it. */
export function validateSettings(settings) {
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
    throw new Error('settings.json must be an object, such as { "activeDays": 90 }');
  }
  for (const [name, value] of Object.entries(settings)) {
    const rule = SETTINGS[name];
    if (!rule) throw new Error(`settings.json: unknown setting "${name}"; known: ${Object.keys(SETTINGS).join(', ')}`);
    if (!rule[0](value)) throw new Error(`settings.json: ${name} must be ${rule[1]}`);
  }
  return settings;
}

/** `settings.json` beside `scout.json`: none is fine, but one that isn't JSON or is wrong fails the run. */
export function readSettings(folder) {
  let text;
  try {
    text = readFileSync(join(folder, 'settings.json'), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw error;
  }
  let settings;
  try {
    settings = JSON.parse(text);
  } catch (error) {
    throw new Error(`settings.json isn't JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validateSettings(settings);
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
