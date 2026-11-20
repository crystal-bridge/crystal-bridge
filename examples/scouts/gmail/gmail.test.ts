import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ScoutItems, ScoutManifest } from '../../../packages/protocol/src/index.ts';
import { act } from './act.mjs';
import { collect } from './collect.mjs';
import { accessToken, cleanBody, gmail, GROUPS, readClient, redact, toItem } from './gmail.mjs';
import { authUrl, signIn } from './sign-in.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ME = 'me@example.com';
const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64url');

/** A message as `threads.get?format=full` returns it, made up for the test. */
function message(
  extra: {
    id?: string;
    labels?: string[];
    from?: string;
    subject?: string;
    text?: string;
    html?: string;
    at?: number;
    headers?: Record<string, string>;
  } = {},
) {
  const headers = {
    From: extra.from ?? 'Ana Lima <ana@example.org>',
    Subject: extra.subject ?? 'Lunch on Friday?',
    Date: 'Wed, 18 Nov 2026 10:00:00 +0000',
    ...extra.headers,
  };
  const parts = [
    ...(extra.text !== undefined || extra.html === undefined
      ? [{ mimeType: 'text/plain', body: { data: b64(extra.text ?? 'Are you free on Friday?') } }]
      : []),
    ...(extra.html !== undefined ? [{ mimeType: 'text/html', body: { data: b64(extra.html) } }] : []),
    { mimeType: 'application/pdf', filename: 'secret.pdf', body: { attachmentId: 'att1', size: 9 } },
  ];
  return {
    id: extra.id ?? 'm1',
    threadId: 't1',
    labelIds: extra.labels ?? ['INBOX', 'UNREAD', 'CATEGORY_PERSONAL'],
    internalDate: String(extra.at ?? 1_800_000_000_000),
    snippet: 'Are you free',
    payload: {
      mimeType: 'multipart/mixed',
      headers: Object.entries(headers).map(([name, value]) => ({ name, value })),
      parts,
    },
  };
}

const thread = (id: string, messages: unknown[]) => ({ id, historyId: '90', messages });

describe('redact', () => {
  it('hides long numbers such as accounts and cards, and codes where the mail talks about a code', () => {
    assert.equal(redact('Account 1234 5678 9012 3456 is due'), 'Account [number] is due');
    assert.equal(redact('IBAN GB33BUKB20201555555555 please'), 'IBAN [account] please');
    assert.equal(redact('Your verification code is 482913.'), 'Your verification code is [code].');
    assert.equal(redact('Use code G-771204 to sign in'), 'Use code [code] to sign in');
    assert.equal(redact('Meet at 1230 in room 4501, card ending 4242'), 'Meet at 1230 in room 4501, card ending 4242');
    assert.equal(redact('Total $1,250.00 due 2026-12-01'), 'Total $1,250.00 due 2026-12-01');
  });

  it('keeps a year, which a mail about security or a PIN still writes plainly', () => {
    assert.equal(redact('Security update, November 2026: code 482913'), 'Security update, November 2026: code [code]');
    assert.equal(redact('Your PIN for 1999 is 4410'), 'Your PIN for 1999 is [code]');
  });

  it('hides codes split in two, as sign-in mails often write them', () => {
    assert.equal(redact('Your verification code is 123-456.'), 'Your verification code is [code].');
    assert.equal(redact('Your security code: 123 456'), 'Your security code: [code]');
  });

  it('keeps only the host of a link, which drops sign-in tokens and tracking', () => {
    assert.equal(
      redact('Sign in: https://login.example.com/magic?token=abc123 now'),
      'Sign in: [link: login.example.com] now',
    );
  });
});

describe('cleanBody', () => {
  it('prefers plain text, drops quoted replies and attachments, and trims', () => {
    const body = cleanBody(
      message({ text: 'Sure, Friday works.\n\nOn Tue, Bo <bo@example.org> wrote:\n> old stuff\n> more' }).payload,
      600,
    );
    assert.equal(body, 'Sure, Friday works.');
    assert.equal(cleanBody(message({ text: 'x'.repeat(50) }).payload, 20), `${'x'.repeat(19)}…`);
  });

  it('reads HTML when there is no plain text, without styles, scripts, tags or invisible characters', () => {
    const html =
      '<html><style>p{color:red}</style><script>alert(1)</script><p>Hello&nbsp;<b>there</b> &amp; welcome​­</p></html>';
    assert.equal(cleanBody(message({ html }).payload, 600), 'Hello there & welcome');
  });
});

describe('toItem', () => {
  it('makes one item per thread from its latest message, with a rev that changes on a new message', () => {
    const item = toItem(
      thread('t1', [message({ id: 'm1', at: 1 }), message({ id: 'm2', at: 2, subject: 'Re: Lunch' })]),
      {
        email: ME,
        bodyChars: 600,
      },
    );
    assert.equal(item.id, 'thread:t1');
    assert.equal(item.rev, 'm2');
    assert.equal(item.title, 'Re: Lunch');
    assert.equal(item.group, 'Primary');
    assert.match(item.subtitle, /^Ana Lima <ana@example.org> · 2 messages/);
    assert.equal(item.url, `https://mail.google.com/mail/?authuser=${encodeURIComponent(ME)}#all/t1`);
    assert.equal(item.fields.fromAddress, 'ana@example.org');
    assert.equal(item.fields.unread, true);
    assert.equal(item.fields.body, 'Are you free on Friday?');
    // A person gets no Filter sender: a batch press over Primary must not send people's mail past the inbox.
    assert.ok(!item.actions.includes('filter'));
    assert.ok(item.actions.includes('spam'));
    assert.ok(ScoutItems.safeParse({ items: [item] }).success);
  });

  it('groups by Gmail category, notes a mailing list, and redacts the subject too', () => {
    const item = toItem(
      thread('t2', [
        message({
          labels: ['INBOX', 'CATEGORY_PROMOTIONS'],
          subject: 'Your code is 551200',
          headers: { 'List-Id': 'Deals <deals.shop.example>', 'List-Unsubscribe': '<mailto:x@example.com>' },
        }),
      ]),
      { email: ME, bodyChars: 600 },
    );
    assert.equal(item.group, 'Promotions');
    assert.equal(item.title, 'Your code is [code]');
    assert.equal(item.fields.list, 'Deals <deals.shop.example>');
    assert.equal(item.fields.unsubscribe, true);
    assert.equal(item.fields.unread, false);
    assert.ok(item.actions.includes('filter'));
  });

  it('leaves out drafts, trash and spam, so an unsent reply is neither the latest message nor sent anywhere', () => {
    const item = toItem(
      thread('t4', [
        message({ id: 'm1', at: 1 }),
        message({ id: 'd1', at: 2, labels: ['DRAFT'], from: ME, text: 'my unsent words' }),
        message({ id: 'x1', at: 3, labels: ['TRASH'], text: 'binned' }),
      ]),
      { email: ME, bodyChars: 600 },
    );
    assert.equal(item.rev, 'm1');
    assert.equal(item.fields.fromMe, false);
    assert.equal(item.fields.messages, 1);
    assert.equal(item.fields.body, 'Are you free on Friday?');
  });

  it('hides a code in the subject when the talk of a code comes after the trimmed part of the body', () => {
    const item = toItem(
      thread('t5', [
        message({ subject: 'Sign-in 739201', text: `${'Hello there. '.repeat(10)}Your verification code.` }),
      ]),
      { email: ME, bodyChars: 40 },
    );
    assert.equal(item.title, 'Sign-in [code]');
  });

  it('says when you had the last word, and offers no filter on your own address', () => {
    const item = toItem(thread('t3', [message({ labels: ['INBOX', 'SENT'], from: `Me <${ME}>` })]), {
      email: ME,
      bodyChars: 600,
    });
    assert.equal(item.fields.fromMe, true);
    assert.ok(!item.actions.includes('filter'));
    assert.match(item.subtitle, /you replied last/);
  });
});

/** A stand-in for Google: the token endpoint and the Gmail API, recording each call. */
function fakeGoogle(
  opts: { inbox?: Record<string, unknown>; history?: unknown; historyStatus?: number; tokenError?: string } = {},
) {
  const calls: { method: string; url: URL; body?: string }[] = [];
  const inbox: Record<string, any> = opts.inbox ?? { t1: thread('t1', [message()]) };
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetch = async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    calls.push({ method, url, body: typeof init.body === 'string' ? init.body : init.body?.toString() });
    if (url.host === 'oauth2.googleapis.com') {
      if (opts.tokenError) return json(400, { error: opts.tokenError });
      return json(200, { access_token: 'ya29.fake', expires_in: 3599, refresh_token: 'rt-new', scope: 'x' });
    }
    const path = url.pathname.replace('/gmail/v1/users/me/', '');
    if (path === 'profile') return json(200, { emailAddress: ME, historyId: '100' });
    if (path === 'threads' && method === 'GET') return json(200, { threads: Object.keys(inbox).map((id) => ({ id })) });
    if (path === 'history') {
      if (opts.historyStatus) return json(opts.historyStatus, { error: { code: opts.historyStatus } });
      return json(200, opts.history ?? { historyId: '120' });
    }
    const got = /^threads\/([^/]+)$/.exec(path);
    if (got) return inbox[got[1]!] ? json(200, inbox[got[1]!]) : json(404, { error: { code: 404 } });
    if (path === 'threads/gone/modify')
      return json(404, { error: { code: 404, message: 'Requested entity was not found.' } });
    if (/^threads\/[^/]+\/modify$/.test(path)) return json(200, {});
    if (path === 'settings/filters') {
      const body = JSON.parse(String(init.body));
      if (body.criteria.from === 'dupe@example.org') return json(400, { error: { message: 'Filter already exists' } });
      if (body.criteria.from === 'bad@example.org') return json(400, { error: { message: 'Invalid criteria' } });
      return json(200, { id: 'f1', ...body });
    }
    return json(404, { error: { message: `no fake for ${method} ${path}` } });
  };
  return { fetch, calls };
}

describe('gmail', () => {
  const quota = () =>
    new Response(
      JSON.stringify({
        error: {
          code: 403,
          message: "Quota exceeded for quota metric 'Total Query Cost' and limit 'Units per minute per user'",
          errors: [{ reason: 'rateLimitExceeded' }],
        },
      }),
      { status: 403 },
    );

  it('waits and tries again when Gmail says the per-user quota is spent, as on a new project with its lower quota', async () => {
    let calls = 0;
    const waits: number[] = [];
    const call = gmail({
      fetch: async () => (++calls < 3 ? quota() : new Response('{"ok":true}', { status: 200 })),
      token: 't',
      sleep: async (ms: number) => void waits.push(ms),
    });
    assert.deepEqual(await call('profile'), { ok: true });
    assert.equal(calls, 3);
    assert.equal(waits.length, 2);
    assert.ok(waits[1]! > waits[0]!);
  });

  it('gives up after a minute of waiting, and says the quota is the reason', async () => {
    const waits: number[] = [];
    const call = gmail({ fetch: async () => quota(), token: 't', sleep: async (ms: number) => void waits.push(ms) });
    await assert.rejects(call('profile'), /quota/i);
    assert.ok(waits.reduce((a, b) => a + b, 0) <= 70_000);
  });

  it('does not retry a refusal that waiting cannot fix', async () => {
    let calls = 0;
    const call = gmail({
      fetch: async () => (calls++, new Response('{"error":{"message":"Insufficient Permission"}}', { status: 403 })),
      token: 't',
      sleep: async () => {},
    });
    await assert.rejects(call('settings/filters'), /403/);
    assert.equal(calls, 1);
  });
});

describe('Google sign-in', () => {
  let folder: string;
  let state: string;
  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'cb-gmail-scout-'));
    state = join(folder, 'state');
    writeFileSync(
      join(folder, 'client_secret.json'),
      JSON.stringify({ installed: { client_id: 'cid.apps.googleusercontent.com', client_secret: 'cs' } }),
    );
  });
  afterEach(() => rmSync(folder, { recursive: true, force: true }));

  it('asks for offline access to modify mail and its basic settings, with PKCE', () => {
    const url = new URL(authUrl({ clientId: 'cid', redirect: 'http://127.0.0.1:5000', challenge: 'ch', nonce: 'n' }));
    assert.equal(url.searchParams.get('access_type'), 'offline');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(
      url.searchParams.get('scope'),
      'https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.settings.basic',
    );
  });

  it('says how to get a client when client_secret.json is missing', () => {
    rmSync(join(folder, 'client_secret.json'));
    assert.throws(() => readClient(folder), /client_secret\.json.*Desktop/);
  });

  it('takes the code on a loopback address and keeps the refresh token where only you can read it', async () => {
    const google = fakeGoogle();
    const client = readClient(folder);
    let refused: number | undefined;
    const email = await signIn({
      fetch: google.fetch,
      client,
      state,
      port: 0,
      timeoutMs: 5_000,
      show: (url: string) => {
        const asked = new URL(url);
        const back = new URL(asked.searchParams.get('redirect_uri')!);
        back.searchParams.set('code', 'planted');
        back.searchParams.set('state', 'not-ours');
        // A redirect with someone else's state is refused, and the sign-in keeps waiting for its own.
        request(back, (res) => {
          refused = res.statusCode;
          res.resume();
          back.searchParams.set('code', 'the-code');
          back.searchParams.set('state', asked.searchParams.get('state')!);
          request(back, (again) => again.resume()).end();
        }).end();
      },
    });
    assert.equal(refused, 404);
    assert.equal(email, ME);
    const saved = JSON.parse(readFileSync(join(state, 'token.json'), 'utf8'));
    assert.equal(saved.refresh_token, 'rt-new');
    if (process.platform !== 'win32') assert.equal(statSync(join(state, 'token.json')).mode & 0o777, 0o600);
    const exchange = google.calls.find((call) => call.url.host === 'oauth2.googleapis.com')!;
    assert.match(exchange.body!, /code=the-code/);
    assert.match(exchange.body!, /code_verifier=/);
  });

  it('says what Google refused, and stops waiting when it never answers', async () => {
    const client = readClient(folder);
    const google = fakeGoogle();
    await assert.rejects(
      signIn({
        fetch: google.fetch,
        client,
        state,
        port: 0,
        timeoutMs: 5_000,
        show: (url: string) => {
          const asked = new URL(url);
          const back = new URL(asked.searchParams.get('redirect_uri')!);
          back.searchParams.set('error', 'access_denied');
          back.searchParams.set('state', asked.searchParams.get('state')!);
          request(back, (res) => res.resume()).end();
        },
      }),
      /access_denied/,
    );
    await assert.rejects(
      signIn({ fetch: google.fetch, client, state, port: 0, timeoutMs: 50, show: () => {} }),
      /no answer from Google/,
    );
  });

  it('turns a revoked or expired sign-in into an instruction to sign in again', async () => {
    mkdirSync(state);
    writeFileSync(join(state, 'token.json'), JSON.stringify({ refresh_token: 'rt-old' }));
    const google = fakeGoogle({ tokenError: 'invalid_grant' });
    await assert.rejects(
      accessToken({ fetch: google.fetch, client: readClient(folder), state }),
      /sign in again.*sign-in\.mjs/i,
    );
    rmSync(join(state, 'token.json'));
    await assert.rejects(
      accessToken({ fetch: google.fetch, client: readClient(folder), state }),
      /not signed in.*sign-in\.mjs/i,
    );
  });
});

describe('collect', () => {
  let folder: string;
  let state: string;
  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'cb-gmail-scout-'));
    state = join(folder, 'state');
    mkdirSync(state);
    writeFileSync(
      join(folder, 'client_secret.json'),
      JSON.stringify({ installed: { client_id: 'cid', client_secret: 'cs' } }),
    );
    writeFileSync(join(state, 'token.json'), JSON.stringify({ refresh_token: 'rt' }));
  });
  afterEach(() => rmSync(folder, { recursive: true, force: true }));

  const kept = () => JSON.parse(readFileSync(join(state, 'inbox.json'), 'utf8'));

  it('reads the whole inbox the first time and saves the position before reading', async () => {
    const google = fakeGoogle();
    const out = await collect({ fetch: google.fetch, folder, state, settings: {} });
    assert.deepEqual(
      out.items.map((item: { id: string }) => item.id),
      ['thread:t1'],
    );
    assert.equal(kept().historyId, '100');
    assert.equal(kept().email, ME);
    assert.equal(kept().bodyChars, 300);
    const paths = google.calls.map((call) => call.url.pathname.split('/users/me/')[1]).filter(Boolean);
    assert.ok(paths.indexOf('profile') < paths.indexOf('threads'));
  });

  it('reads only the threads history names after that, and drops one that left the inbox', async () => {
    const two = { t1: thread('t1', [message()]), t2: thread('t2', [message({ id: 'm9', subject: 'Invoice' })]) };
    await collect({ fetch: fakeGoogle({ inbox: two }).fetch, folder, state, settings: {} });
    const archived = { t1: thread('t1', [message({ labels: ['CATEGORY_PERSONAL'] })]), t2: two.t2 };
    const google = fakeGoogle({
      inbox: archived,
      history: { historyId: '130', history: [{ labelsRemoved: [{ message: { id: 'm1', threadId: 't1' } }] }] },
    });
    const out = await collect({ fetch: google.fetch, folder, state, settings: {} });
    assert.deepEqual(
      out.items.map((item: { id: string }) => item.id),
      ['thread:t2'],
    );
    assert.equal(kept().historyId, '130');
    const threadGets = google.calls.filter((call) => /\/threads\/t\d$/.test(call.url.pathname));
    assert.deepEqual(
      threadGets.map((call) => call.url.pathname.split('/').at(-1)),
      ['t1'],
    );
    assert.equal(
      google.calls.find((call) => call.url.pathname.endsWith('/history'))!.url.searchParams.get('startHistoryId'),
      '100',
    );
  });

  it('brings a thread back as new when a message arrives in it', async () => {
    await collect({ fetch: fakeGoogle().fetch, folder, state, settings: {} });
    const google = fakeGoogle({
      inbox: { t1: thread('t1', [message(), message({ id: 'm2', at: 1_800_000_100_000, subject: 'Re: Lunch' })]) },
      history: { historyId: '125', history: [{ messagesAdded: [{ message: { id: 'm2', threadId: 't1' } }] }] },
    });
    const out = await collect({ fetch: google.fetch, folder, state, settings: {} });
    assert.equal(out.items[0].rev, 'm2');
    assert.equal(out.items[0].title, 'Re: Lunch');
  });

  it('reads in full instead when history touched more threads than the Board holds', async () => {
    await collect({ fetch: fakeGoogle().fetch, folder, state, settings: { maxThreads: 2 } });
    const touched = ['a', 'b', 'c'].map((id) => ({ labelsRemoved: [{ message: { id: `m-${id}`, threadId: id } }] }));
    const google = fakeGoogle({ history: { historyId: '140', history: touched } });
    await collect({ fetch: google.fetch, folder, state, settings: { maxThreads: 2 } });
    assert.ok(google.calls.some((call) => call.url.pathname.endsWith('/profile')));
    assert.ok(!google.calls.some((call) => /\/threads\/[abc]$/.test(call.url.pathname)));
  });

  it('reads in full when the sign-in is now another account, or maxThreads changed', async () => {
    await collect({ fetch: fakeGoogle().fetch, folder, state, settings: {} });
    writeFileSync(join(state, 'token.json'), JSON.stringify({ refresh_token: 'rt', email: 'other@example.com' }));
    const switched = fakeGoogle();
    await collect({ fetch: switched.fetch, folder, state, settings: {} });
    assert.ok(switched.calls.some((call) => call.url.pathname.endsWith('/profile')));
    const raised = fakeGoogle();
    await collect({ fetch: raised.fetch, folder, state, settings: { maxThreads: 300 } });
    assert.ok(raised.calls.some((call) => call.url.pathname.endsWith('/profile')));
  });

  it('keeps its state folder and list readable by you alone', { skip: process.platform === 'win32' }, async () => {
    rmSync(state, { recursive: true, force: true });
    mkdirSync(state, { mode: 0o755 });
    writeFileSync(join(state, 'token.json'), JSON.stringify({ refresh_token: 'rt' }));
    await collect({ fetch: fakeGoogle().fetch, folder, state, settings: {} });
    assert.equal(statSync(state).mode & 0o777, 0o700);
    assert.equal(statSync(join(state, 'inbox.json')).mode & 0o777, 0o600);
  });

  it('reads the inbox in full again when Google says the position is too old', async () => {
    await collect({ fetch: fakeGoogle().fetch, folder, state, settings: {} });
    const google = fakeGoogle({ historyStatus: 404 });
    const out = await collect({ fetch: google.fetch, folder, state, settings: {} });
    assert.equal(out.items.length, 1);
    assert.ok(google.calls.some((call) => call.url.pathname.endsWith('/profile')));
  });

  it('reads no more threads than maxThreads, newest first as Gmail lists them', async () => {
    const many = Object.fromEntries(['a', 'b', 'c'].map((id) => [id, thread(id, [message({ id: `m-${id}` })])]));
    const google = fakeGoogle({ inbox: many });
    const out = await collect({ fetch: google.fetch, folder, state, settings: { maxThreads: 2 } });
    assert.equal(out.items.length, 2);
    assert.equal(
      google.calls.find((call) => call.url.pathname.endsWith('/threads'))!.url.searchParams.get('maxResults'),
      '2',
    );
    assert.ok(ScoutItems.safeParse(out).success);
  });
});

describe('act', () => {
  let folder: string;
  let state: string;
  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'cb-gmail-act-'));
    state = join(folder, 'state');
    mkdirSync(state);
    writeFileSync(
      join(folder, 'client_secret.json'),
      JSON.stringify({ installed: { client_id: 'cid', client_secret: 'cs' } }),
    );
    writeFileSync(join(state, 'token.json'), JSON.stringify({ refresh_token: 'rt' }));
  });
  afterEach(() => rmSync(folder, { recursive: true, force: true }));

  const item = (id: string, fromAddress = 'news@example.com') => ({
    id: `thread:${id}`,
    title: 'x',
    fields: { fromAddress },
  });
  const modifies = (calls: ReturnType<typeof fakeGoogle>['calls']) =>
    calls
      .filter((call) => call.url.pathname.endsWith('/modify'))
      .map((call) => [call.url.pathname.split('/').at(-2), JSON.parse(call.body!)]);

  it('archives by taking threads out of the inbox', async () => {
    const google = fakeGoogle();
    await act({ fetch: google.fetch, folder, state, action: 'archive', items: [item('t1'), item('t2')] });
    assert.deepEqual(modifies(google.calls), [
      ['t1', { removeLabelIds: ['INBOX'] }],
      ['t2', { removeLabelIds: ['INBOX'] }],
    ]);
  });

  it('moves to spam with the SPAM label', async () => {
    const google = fakeGoogle();
    await act({ fetch: google.fetch, folder, state, action: 'spam', items: [item('t1')] });
    assert.deepEqual(modifies(google.calls), [['t1', { addLabelIds: ['SPAM'], removeLabelIds: ['INBOX'] }]]);
  });

  it('makes one skip-the-inbox filter per sender, takes an existing one as done, and archives the threads', async () => {
    const google = fakeGoogle();
    await act({
      fetch: google.fetch,
      folder,
      state,
      action: 'filter',
      items: [item('t1'), item('t2'), item('t3', 'dupe@example.org')],
    });
    const filters = google.calls.filter((call) => call.url.pathname.endsWith('/settings/filters'));
    assert.deepEqual(
      filters.map((call) => JSON.parse(call.body!)),
      [
        { criteria: { from: 'news@example.com' }, action: { removeLabelIds: ['INBOX'] } },
        { criteria: { from: 'dupe@example.org' }, action: { removeLabelIds: ['INBOX'] } },
      ],
    );
    assert.equal(modifies(google.calls).length, 3);
  });

  it('counts a thread deleted since the last run as done, and carries on with the rest', async () => {
    const google = fakeGoogle();
    await act({ fetch: google.fetch, folder, state, action: 'archive', items: [item('t1'), item('gone'), item('t3')] });
    assert.deepEqual(
      modifies(google.calls).map(([id]) => id),
      ['t1', 'gone', 't3'],
    );
  });

  it('fails on any other refusal from Gmail', async () => {
    const google = fakeGoogle();
    await assert.rejects(
      act({ fetch: google.fetch, folder, state, action: 'filter', items: [item('t1', 'bad@example.org')] }),
      /answered 400/,
    );
  });

  it('refuses a sender address a Gmail search would read as an operator', async () => {
    const google = fakeGoogle();
    for (const address of ['-news@example.com', '*@*', 'a@example.com,*']) {
      await assert.rejects(
        act({ fetch: google.fetch, folder, state, action: 'filter', items: [item('t1', address)] }),
        /no sender/,
      );
    }
  });

  it('refuses an item that is not a thread, or a filter without a sender, before touching anything', async () => {
    const google = fakeGoogle();
    await assert.rejects(
      act({ fetch: google.fetch, folder, state, action: 'archive', items: [{ id: 'synthesis:abc', title: 'x' }] }),
      /not a Gmail thread/,
    );
    await assert.rejects(
      act({
        fetch: google.fetch,
        folder,
        state,
        action: 'filter',
        items: [{ id: 'thread:t1', title: 'x', fields: {} }],
      }),
      /no sender/,
    );
    await assert.rejects(
      act({ fetch: google.fetch, folder, state, action: 'nuke', items: [item('t1')] }),
      /unknown action/,
    );
    assert.equal(modifies(google.calls).length, 0);
  });
});

describe('scout.json', () => {
  it('is a Scout this release loads, and every action an item names is in it', () => {
    const manifest = ScoutManifest.parse(JSON.parse(readFileSync(join(HERE, 'scout.json'), 'utf8')));
    const items = [
      toItem(thread('t1', [message()]), { email: ME, bodyChars: 600 }),
      toItem(thread('t2', [message({ labels: ['INBOX', 'SENT'], from: ME })]), { email: ME, bodyChars: 600 }),
    ];
    const named = new Set(items.flatMap((one) => one.actions));
    assert.deepEqual(
      [...named].filter((key) => !(key in manifest.actions)),
      [],
    );
    for (const action of Object.values(manifest.actions)) {
      if (action.kind === 'quest') readFileSync(join(HERE, action.prompt), 'utf8');
      if (action.kind === 'run') assert.deepEqual(action.command, ['node', 'act.mjs']);
    }
    readFileSync(join(HERE, manifest.synthesize!.prompt), 'utf8');
    // Each inbox category's band has an icon and a tone of its own.
    assert.deepEqual(
      GROUPS.filter((group) => !manifest.groups?.[group]?.icon || !manifest.groups[group]?.tone),
      [],
    );
    assert.equal(new Set(GROUPS.map((group) => manifest.groups?.[group]?.tone)).size, GROUPS.length);
    // A mail list changes on nearly every run: only a press spends plan usage, about $0.57 for 100 threads live.
    assert.deepEqual(
      { when: manifest.synthesize!.when, maxBudgetUsd: manifest.synthesize!.maxBudgetUsd },
      { when: 'now', maxBudgetUsd: 1 },
    );
  });
});

describe('the scripts run as commands', () => {
  it('fail plainly when the Scout has no Google client yet', () => {
    const root = mkdtempSync(join(tmpdir(), 'cb-gmail-run-'));
    try {
      for (const script of ['collect.mjs', 'act.mjs']) {
        const run = spawnSync(process.execPath, [join(HERE, script)], {
          cwd: root,
          env: { PATH: process.env.PATH, CRYSTAL_SCOUT_STATE: join(root, 'state'), CRYSTAL_SCOUT_ACTION: 'archive' },
          input: JSON.stringify({ scout: 'gmail', action: 'archive', items: [] }),
          encoding: 'utf8',
        });
        assert.equal(run.status, 1, script);
        assert.match(run.stderr, /not signed in|client_secret\.json/, script);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
