#!/usr/bin/env node
/**
 * Signs this Kingdom in to Gmail for the Scout, once: Google's loopback flow for desktop apps, with PKCE. It prints an
 * address to open in a browser, takes Google's answer on 127.0.0.1, and keeps the refresh token in `state/token.json`,
 * readable by you alone.
 *
 *   node sign-in.mjs              any free port
 *   node sign-in.mjs --port 8765  a fixed port, for a Kingdom you reach over SSH: ssh -L 8765:127.0.0.1:8765 <kingdom>
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCOPES, TOKEN_URL, gmail, isMain, readClient, runMain, writeToken } from './gmail.mjs';

/** Google's consent page for this client: offline access, so a refresh token comes back, asked for every time. */
export function authUrl({ clientId, redirect, challenge, nonce }) {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirect,
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: nonce,
  }).toString();
  return url.toString();
}

/** Waits on 127.0.0.1 for Google's redirect with the code, for five minutes at most. */
function waitForCode(server, nonce, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no answer from Google within five minutes')), timeoutMs);
    server.once('done', () => clearTimeout(timer));
    server.on('request', (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      if (url.searchParams.get('state') !== nonce || (!code && !error)) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(error ? `Google said: ${error}. Nothing was saved.` : 'Signed in. You can close this tab.');
      clearTimeout(timer);
      if (error) reject(new Error(`Google said: ${error}`));
      else resolve(code);
    });
  });
}

/** The whole sign-in: returns the signed-in address. `show` gets the consent page's address. */
export async function signIn({ fetch = globalThis.fetch, client, state, port = 0, show, timeoutMs = 5 * 60_000 }) {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const nonce = randomBytes(16).toString('base64url');
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  try {
    const redirect = `http://127.0.0.1:${server.address().port}`;
    const answer = waitForCode(server, nonce, timeoutMs);
    answer.catch(() => {});
    show(authUrl({ clientId: client.id, redirect, challenge, nonce }));
    const code = await answer;
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: redirect,
        client_id: client.id,
        client_secret: client.secret,
      }).toString(),
    });
    const token = await response.json().catch(() => ({}));
    if (!response.ok || !token.access_token) {
      throw new Error(`Google's token endpoint answered ${response.status}: ${token.error ?? 'no token'}`);
    }
    if (!token.refresh_token) {
      throw new Error(
        'Google returned no refresh token: remove the app under "Third-party apps & services" in your Google Account and sign in again',
      );
    }
    const profile = await gmail({ fetch, token: token.access_token })('profile');
    writeToken(state, { refresh_token: token.refresh_token, scope: token.scope, email: profile.emailAddress });
    return profile.emailAddress;
  } finally {
    server.emit('done');
    server.close();
  }
}

if (isMain(import.meta.url)) {
  const folder = dirname(fileURLToPath(import.meta.url));
  const state = process.env.CRYSTAL_SCOUT_STATE || join(folder, 'state');
  const at = process.argv.indexOf('--port');
  const port = at > 0 ? Number(process.argv[at + 1]) : 0;
  runMain(async () => {
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port takes a port number');
    const email = await signIn({
      client: readClient(folder),
      state,
      port,
      show: (url) =>
        process.stdout.write(
          `Open this address in a browser that reaches this machine's 127.0.0.1 (here, or through an SSH forward), and allow both permissions:\n\n${url}\n\n`,
        ),
    });
    process.stdout.write(`Signed in as ${email}. The Scout's next run uses this sign-in.\n`);
  });
}
