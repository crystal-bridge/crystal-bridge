/**
 * The repo's own checks, run by the git hooks and by CI, so they hold for every contributor and harness:
 *   tsx scripts/repo-checks.ts staged       pre-commit: Prettier and the scrub on staged files, gitleaks if installed
 *   tsx scripts/repo-checks.ts msg <file>   commit-msg: conventional subject, noreply author, no attribution lines
 *   tsx scripts/repo-checks.ts all          CI: the scrub on every tracked file
 * The scrub flags model ids, home paths and email addresses other than noreply and example ones. A private deny list
 * (one string per line, `#` comments) at `~/.config/crystal-bridge/deny-list` adds strings that must never be
 * committed; it lives outside the repo because listing them here would publish them.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODEL_RE = /\bclaude-(?:opus|sonnet|haiku|fable|instant)\b[a-z0-9.-]*|\b(?:Opus|Sonnet|Haiku|Fable) \d/i;
const HOME_RE = /\/(?:Users|home)\/(?!me\b)[A-Za-z0-9._-]+/;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const ALLOWED_EMAIL = /(^noreply@)|@users\.noreply\.github\.com$|@example\.(com|org|net|invalid)$/i;
/** Third-party or generated files: their authors' names and addresses belong there. */
const SKIP = [
  /^pnpm-lock\.yaml$/,
  /^THIRD_PARTY_NOTICES\.md$/,
  /^LICENSES\//,
  /^apps\/web\/public\/heroes\/CREDITS\.csv$/,
];

const DENY_LIST = join(homedir(), '.config', 'crystal-bridge', 'deny-list');

export function loadDenyList(path = DENY_LIST): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

/** Problems with one file's contents, each naming the file and line; a deny-list hit never repeats the entry. */
export function checkFile(path: string, text: string, deny: string[]): string[] {
  if (SKIP.some((re) => re.test(path)) || text.includes('\0')) return [];
  const problems: string[] = [];
  text.split('\n').forEach((line, i) => {
    const at = `${path}:${i + 1}`;
    const model = MODEL_RE.exec(line);
    if (model) problems.push(`${at}: model name "${model[0]}"`);
    const home = HOME_RE.exec(line);
    if (home) problems.push(`${at}: home path "${home[0]}" (use /home/me in tests, placeholders in docs)`);
    for (const email of line.match(EMAIL_RE) ?? []) {
      if (!ALLOWED_EMAIL.test(email)) problems.push(`${at}: email address "${email}"`);
    }
    const lower = line.toLowerCase();
    deny.forEach((entry, n) => {
      if (lower.includes(entry.toLowerCase())) problems.push(`${at}: matches line ${n + 1} of your private deny list`);
    });
  });
  return problems;
}

const CONVENTIONAL = /^(feat|fix|chore|docs|refactor|test|perf|build|ci|style|revert)(\([\w,./-]+\))?!?: \S/;
const GIT_MADE = /^(Merge |Revert "|fixup! |squash! |amend! )/;

/** Problems with a commit message: its subject's form, attribution trailers and model names. */
export function checkCommitMessage(message: string): string[] {
  const lines = message.split('\n').filter((line) => !line.startsWith('#'));
  const subject = lines[0] ?? '';
  if (GIT_MADE.test(subject)) return [];
  const problems: string[] = [];
  if (!CONVENTIONAL.test(subject)) problems.push(`subject isn't conventional (e.g. "feat(web): ..."): "${subject}"`);
  for (const line of lines) {
    if (/^co-authored-by:/i.test(line) || /generated with .*claude/i.test(line)) {
      problems.push(`no attribution lines: "${line}"`);
    }
    const model = MODEL_RE.exec(line);
    if (model) problems.push(`model name "${model[0]}"`);
  }
  return problems;
}

/** Whether a `git var GIT_AUTHOR_IDENT` names a noreply address. */
export function isAuthorAllowed(ident: string): boolean {
  const email = /<([^>]*)>/.exec(ident)?.[1] ?? '';
  return /@users\.noreply\.github\.com$/i.test(email) || /^noreply@/i.test(email);
}

function git(...args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function fail(problems: string[], hint: string): never {
  for (const problem of problems) console.error(`  ${problem}`);
  console.error(hint);
  process.exit(1);
}

function staged(): void {
  const files = git('diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z').split('\0').filter(Boolean);
  if (files.length === 0) return;
  const deny = loadDenyList();
  const problems = files.flatMap((file) => checkFile(file, git('show', `:${file}`), deny));
  if (problems.length > 0) fail(problems, 'repo-checks: fix these before committing.');

  const prettier = spawnSync('pnpm', ['exec', 'prettier', '--check', '--ignore-unknown', ...files], {
    stdio: 'inherit',
  });
  if (prettier.status !== 0) fail([], 'repo-checks: run `pnpm format`, then stage the result.');

  const gitleaks = spawnSync('gitleaks', ['git', '--staged', '--redact', '--no-banner'], { stdio: 'inherit' });
  if (gitleaks.error) console.error('repo-checks: gitleaks not installed; CI scans for secrets instead.');
  else if (gitleaks.status !== 0) fail([], 'repo-checks: gitleaks found a possible secret.');
}

function msg(file: string): void {
  const problems = checkCommitMessage(readFileSync(file, 'utf8'));
  const author = git('var', 'GIT_AUTHOR_IDENT').trim();
  if (!isAuthorAllowed(author)) {
    problems.push("the author must be a noreply address: set user.email in this repo's git config");
  }
  if (problems.length > 0) fail(problems, 'repo-checks: commit message rejected.');
}

function all(): void {
  const files = git('ls-files', '-z').split('\0').filter(Boolean);
  const problems = files.flatMap((file) =>
    existsSync(file) ? checkFile(file, readFileSync(file, 'utf8'), loadDenyList()) : [],
  );
  if (problems.length > 0) fail(problems, `repo-checks: ${problems.length} problem(s) in tracked files.`);
  console.log(`repo-checks: ${files.length} tracked files clean`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [mode, arg] = process.argv.slice(2);
  if (mode === 'staged') staged();
  else if (mode === 'msg' && arg) msg(arg);
  else if (mode === 'all') all();
  else fail([], 'usage: tsx scripts/repo-checks.ts staged | msg <file> | all');
}
