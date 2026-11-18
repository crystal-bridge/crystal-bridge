/**
 * What the Gmail Scout's scripts share: the Google client and sign-in, calls to the Gmail API, and turning a thread
 * into a Board item with a cleaned, trimmed and redacted body. Node only, no packages.
 */
import { mkdirSync, readFileSync, realpathSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.settings.basic',
];
export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me/';

/** The groups, in the order the Board shows them: Gmail's inbox categories. */
export const GROUPS = ['Primary', 'Updates', 'Social', 'Forums', 'Promotions'];
const CATEGORIES = {
  CATEGORY_UPDATES: 'Updates',
  CATEGORY_SOCIAL: 'Social',
  CATEGORY_FORUMS: 'Forums',
  CATEGORY_PROMOTIONS: 'Promotions',
};

const SIGN_IN = "run `node sign-in.mjs` in the Scout's folder on the Kingdom that runs it";

/** The Desktop OAuth client you made in your own Google Cloud project, from the JSON Google lets you download. */
export function readClient(folder) {
  let text;
  try {
    text = readFileSync(join(folder, 'client_secret.json'), 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    throw new Error(
      `no client_secret.json in ${folder}: create a Desktop OAuth client in your Google Cloud project and save its JSON there (see the README)`,
    );
  }
  const client = JSON.parse(text).installed;
  if (!client?.client_id || !client?.client_secret) {
    throw new Error('client_secret.json is not a Desktop OAuth client: its JSON has no "installed" client');
  }
  return { id: client.client_id, secret: client.client_secret };
}

/**
 * Writes a file only you can read, in a folder only you can enter, both tightened before the content goes in: the
 * folder may be one sign-in made before Crystal, or a copied file may carry a looser mode.
 */
export function writePrivate(folder, file, text) {
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  chmodSync(folder, 0o700);
  writeFileSync(file, '', { mode: 0o600 });
  chmodSync(file, 0o600);
  writeFileSync(file, text);
}

/** Saves what sign-in returned, readable by you alone (Windows ignores the mode; the folder's own access applies). */
export function writeToken(state, token) {
  const file = join(state, 'token.json');
  writePrivate(state, file, `${JSON.stringify(token)}\n`);
}

/** A fresh access token from the saved refresh token, or an error that says how to sign in again. */
export async function accessToken({ fetch = globalThis.fetch, client, state }) {
  let saved;
  try {
    saved = JSON.parse(readFileSync(join(state, 'token.json'), 'utf8'));
  } catch {
    saved = undefined;
  }
  if (!saved?.refresh_token) throw new Error(`not signed in to Google: ${SIGN_IN}`);
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: saved.refresh_token,
      client_id: client.id,
      client_secret: client.secret,
    }).toString(),
  });
  const body = await response.json().catch(() => ({}));
  if (body.error === 'invalid_grant') {
    throw new Error(
      `Google's sign-in expired or was revoked, so sign in again: ${SIGN_IN}. A client left in Testing expires every seven days.`,
    );
  }
  if (!response.ok || !body.access_token) {
    throw new Error(`Google's token endpoint answered ${response.status}: ${body.error ?? 'no access token'}`);
  }
  return body.access_token;
}

/** Waits between tries when Gmail says the per-user quota is spent: about a minute in all, then the run fails. */
const BACKOFF_MS = [2_000, 4_000, 8_000, 16_000, 30_000];

/** Whether waiting can fix a refusal: a rate limit or a spent quota, which Gmail sends as 429 or as 403 with a reason. */
function retryable(status, answer) {
  if (status === 429) return true;
  if (status !== 403) return false;
  const reasons = (answer.error?.errors ?? []).map((one) => one.reason);
  return (
    reasons.some((reason) => /rateLimitExceeded|quotaExceeded/.test(String(reason))) ||
    /quota exceeded|rate limit/i.test(answer.error?.message ?? '')
  );
}

/**
 * A caller for the Gmail API as the signed-in user: `call(path, { method, query, body })` returns the JSON answer. A
 * spent quota (a new project allows 6,000 units a minute per user, counted over shorter windows too) is waited out.
 */
export function gmail({
  fetch = globalThis.fetch,
  token,
  sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
}) {
  return async (path, { method = 'GET', query, body } = {}) => {
    const url = `${API}${path}${query ? `?${new URLSearchParams(query)}` : ''}`;
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const answer = await response.json().catch(() => ({}));
      if (response.ok) return answer;
      if (retryable(response.status, answer) && attempt < BACKOFF_MS.length) {
        const after = Number(response.headers?.get?.('retry-after')) * 1000;
        await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 30_000) : BACKOFF_MS[attempt]);
        continue;
      }
      const error = new Error(
        `Gmail ${method} ${path} answered ${response.status}: ${answer.error?.message ?? ''}`.trim(),
      );
      error.status = response.status;
      throw error;
    }
  };
}

/** Runs `work` over `list` with at most `limit` at once, in order. */
export async function mapLimit(list, limit, work) {
  const out = new Array(list.length);
  let next = 0;
  const lane = async () => {
    while (next < list.length) {
      const index = next++;
      out[index] = await work(list[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, lane));
  return out;
}

const CODE_WORDS = /\b(code|codes|otp|passcode|pin|verification|verify|one-time|2fa|two-factor|security|password)\b/i;

/**
 * What the Board and the synthesis step may see of a mail's text. Links keep only their host, which drops sign-in
 * tokens and tracking. Numbers of nine digits or more (accounts, cards, phones) and IBAN-like strings are hidden, and
 * so are short codes when the text talks about a code. `codes` forces the last on or off for text whose context is
 * elsewhere, such as a subject.
 */
export function redact(text, { codes = CODE_WORDS.test(text) } = {}) {
  let out = text
    .replace(/https?:\/\/[^\s<>"')\]]+/gi, (url) => {
      try {
        return `[link: ${new URL(url).host}]`;
      } catch {
        return '[link]';
      }
    })
    .replace(/\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g, '[account]')
    .replace(/(?<![\w.,-])\d(?:[ -]?\d){8,}(?![\w,]|\.\d)/g, '[number]');
  if (codes)
    out = out.replace(
      /(?<![\w.,-])(?:[A-Z]{1,3}-)?(?:\d{3}[ -]\d{3}|(?!(?:19|20)\d\d(?!\d))\d{4,8})(?![\w,]|[.-]\d)/g,
      '[code]',
    );
  return out;
}

const INVISIBLE = /[­͏؜ᅟᅠ឴឵᠎​-‏‪-‮⁠-⁤⁪-⁯﻿]/g;

const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };

/** The text of an HTML mail: no head, styles, scripts, comments or tags, with common entities decoded. */
function htmlText(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(head|style|script|title)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d|blockquote)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*|#39);/gi, (whole, name) => {
      if (name[0] === '#' && name !== '#39') {
        const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ' ';
      }
      return ENTITIES[name.toLowerCase()] ?? whole;
    });
}

/** Every text part of a message that isn't an attachment, by MIME type. */
function textParts(part, found = { plain: [], html: [] }) {
  if (!part) return found;
  if (!part.filename && part.body?.data) {
    const text = Buffer.from(part.body.data, 'base64url').toString('utf8');
    if (part.mimeType === 'text/plain') found.plain.push(text);
    else if (part.mimeType === 'text/html') found.html.push(text);
  }
  for (const child of part.parts ?? []) textParts(child, found);
  return found;
}

/** Cuts a reply at the quote of what it answers, and drops quoted lines and a signature. */
function withoutQuotes(text) {
  const kept = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*On .+wrote:\s*$/.test(line) || /^-{2,}\s*(Original|Forwarded) Message/i.test(line) || line === '-- ') {
      break;
    }
    if (/^\s*>/.test(line)) continue;
    kept.push(line);
  }
  return kept.join('\n');
}

/**
 * A message body as one trimmed line: plain text when there is some, else the HTML's text; no attachments, quotes or
 * invisible characters. `transform` runs before the trim, so redaction never meets half a link.
 */
export function cleanBody(payload, max, transform = (text) => text) {
  const { plain, html } = textParts(payload);
  const raw = plain.length > 0 ? plain.join('\n') : html.map(htmlText).join('\n');
  const text = transform(withoutQuotes(raw.replace(INVISIBLE, '')).replace(/\s+/g, ' ').trim());
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

const header = (message, name) =>
  message.payload?.headers?.find((one) => one.name.toLowerCase() === name.toLowerCase())?.value ?? '';

/**
 * An address a Gmail filter may match on: plain, so nothing in it reads as a search operator, such as a leading `-`
 * (every sender but this one), `*`, braces or a comma. A sender writes their own From header.
 */
export const FILTERABLE = /^[a-z0-9][a-z0-9._%+'-]*@[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/** `Ana Lima <ana@example.org>` as `{ name, address }`. */
export function parseFrom(value) {
  const angle = /^\s*([^<>]*?)\s*<([^<>\s]+@[^<>\s]+)>\s*$/.exec(value);
  if (angle) return { name: angle[1].replace(/^"(.*)"$/, '$1').trim() || angle[2], address: angle[2].toLowerCase() };
  const bare = /[^\s<>"]+@[^\s<>"]+/.exec(value)?.[0];
  return { name: bare ?? (value.trim() || 'unknown sender'), address: bare?.toLowerCase() };
}

const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const SKIPPED = new Set(['DRAFT', 'TRASH', 'SPAM']);

/**
 * A thread from `threads.get?format=full` as a Board item, from its latest message; undefined when it has none left
 * once drafts, trash and spam are set aside.
 */
export function toItem(thread, { email, bodyChars }) {
  // A draft is your unsent reply; trash and spam aren't part of the conversation you see.
  const messages = (thread.messages ?? [])
    .filter((message) => !(message.labelIds ?? []).some((label) => SKIPPED.has(label)))
    .sort((a, b) => Number(a.internalDate) - Number(b.internalDate));
  const latest = messages.at(-1);
  if (!latest) return undefined;
  const me = email?.toLowerCase();
  const isMine = (message) =>
    (message.labelIds ?? []).includes('SENT') ||
    (me !== undefined && parseFrom(header(message, 'From')).address === me);
  const theirs = messages.filter((message) => !isMine(message)).at(-1);
  const sender = theirs ?? latest;
  const from = parseFrom(header(sender, 'From'));
  const fromMe = isMine(latest);
  const labels = new Set((theirs ?? latest).labelIds ?? []);
  const group = Object.entries(CATEGORIES).find(([label]) => labels.has(label))?.[1] ?? 'Primary';
  const subject = header(latest, 'Subject');
  // Whether the mail talks about a code is decided on the whole text, not the trimmed part, for the subject too.
  let codes = CODE_WORDS.test(subject);
  const body = cleanBody(latest.payload, bodyChars, (text) => {
    codes = codes || CODE_WORDS.test(text);
    return redact(text, { codes });
  });
  const count = messages.length;
  const list = header(sender, 'List-Id');
  const plain = Boolean(theirs && from.address && FILTERABLE.test(from.address));
  const unsubscribe = Boolean(header(sender, 'List-Unsubscribe'));
  // Only bulk mail (a list, or one you can unsubscribe from) offers a filter: a person's never does, so a batch press
  // over Primary can't send people's mail past the inbox.
  const canFilter = plain && Boolean(list || unsubscribe);
  return {
    id: `thread:${thread.id}`,
    // Back to new when a message arrives in the thread; reading it or changing labels doesn't count.
    rev: latest.id,
    title: clip(redact(subject, { codes }).trim() || '(no subject)', 500),
    subtitle: clip(
      [
        plain ? `${redact(from.name)} <${from.address}>` : redact(from.name),
        `${count} message${count === 1 ? '' : 's'}`,
        ...(fromMe ? ['you replied last'] : []),
      ].join(' · '),
      500,
    ),
    url: `https://mail.google.com/mail/?authuser=${encodeURIComponent(email ?? '')}#all/${thread.id}`,
    group,
    fields: {
      from: clip(redact(from.name), 200),
      fromAddress: plain ? from.address : null,
      date: new Date(Number(latest.internalDate)).toISOString(),
      category: group,
      messages: count,
      unread: messages.some((message) => (message.labelIds ?? []).includes('UNREAD')),
      fromMe,
      list: list ? clip(list, 200) : null,
      unsubscribe,
      body,
    },
    actions: [
      'open',
      'follow-up',
      'archive',
      ...(canFilter ? ['filter'] : []),
      ...(theirs ? ['spam'] : []),
      'later',
      'done',
    ],
  };
}

/** The items in the Board's order: by group, newest first within one. */
export function sortItems(items) {
  return items.sort(
    (a, b) => GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group) || (a.fields.date < b.fields.date ? 1 : -1),
  );
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

/** Whether `url` (a module's `import.meta.url`) is the command being run, through a symlink or not. */
export function isMain(url) {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(url));
  } catch {
    return false;
  }
}

/** Runs a script's `main`, printing what it returns as JSON, or its error on stderr with exit code 1. */
export function runMain(main) {
  Promise.resolve()
    .then(main)
    .then(
      (out) => {
        if (out !== undefined) process.stdout.write(`${JSON.stringify(out)}\n`);
      },
      (error) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
      },
    );
}
