#!/usr/bin/env node
/**
 * An example Scout collector (docs/SCOUTS.md): the threads in your Gmail inbox, one item each, grouped by Gmail's
 * categories for a Board. The first run reads the inbox; later runs read only what changed since the saved position,
 * with `history.list`, which needs no public address. When Google says the position is too old, it reads in full again.
 *
 * Node only, no packages. `settings.json` beside it is optional: { "maxThreads": 100, "bodyChars": 600 }
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  accessToken,
  gmail,
  isMain,
  mapLimit,
  readClient,
  readSettings,
  runMain,
  sortItems,
  toItem,
  writePrivate,
} from './gmail.mjs';

const number = (value, fallback, max) => (Number(value) > 0 ? Math.min(Math.floor(Number(value)), max) : fallback);

/** A thread as an item while it's in the inbox; undefined once it's gone or left. */
async function threadItem(call, id, options) {
  let thread;
  try {
    thread = await call(`threads/${id}`, { query: { format: 'full' } });
  } catch (error) {
    if (error.status === 404) return undefined;
    throw error;
  }
  const inInbox = (thread.messages ?? []).some((message) => (message.labelIds ?? []).includes('INBOX'));
  return inInbox ? toItem(thread, options) : undefined;
}

/** The threads that history since `start` touched, and the new position; undefined when `start` is too old. */
async function changedSince(call, start, limit) {
  const touched = new Set();
  let historyId;
  let pageToken;
  do {
    let page;
    try {
      page = await call('history', {
        query: { startHistoryId: start, maxResults: '500', ...(pageToken ? { pageToken } : {}) },
      });
    } catch (error) {
      if (error.status === 404) return undefined;
      throw error;
    }
    for (const entry of page.history ?? []) {
      for (const key of ['messages', 'messagesAdded', 'messagesDeleted', 'labelsAdded', 'labelsRemoved']) {
        for (const one of entry[key] ?? []) {
          const threadId = one.message?.threadId ?? one.threadId;
          if (threadId) touched.add(threadId);
        }
      }
    }
    // More than the Board holds: a full read is cheaper than the rest of the pages and a fetch per thread.
    if (touched.size > limit) return { touched: [...touched], historyId: undefined };
    historyId = page.historyId ?? historyId;
    pageToken = page.nextPageToken;
  } while (pageToken);
  return { touched: [...touched], historyId: historyId ?? start };
}

/** The account `sign-in.mjs` signed in as, if it saved one. */
function signedInAs(state) {
  try {
    return JSON.parse(readFileSync(join(state, 'token.json'), 'utf8')).email;
  } catch {
    return undefined;
  }
}

/**
 * The whole run: `{ items }` for the Board, the newest `maxThreads` inbox threads, with the position and list kept in
 * `state/inbox.json`. History says which threads changed; when it names any, the inbox's newest threads are listed again
 * (one call), so a thread archived elsewhere makes room for the next one down. Only threads history named, or new to
 * the list, are fetched. The inbox is read in full the first time, when the position is too old, when history named
 * more threads than the Board holds, or when the account or settings changed.
 */
export async function collect({ fetch = globalThis.fetch, folder, state, settings = {} }) {
  const client = readClient(folder);
  const call = gmail({ fetch, token: await accessToken({ fetch, client, state }) });
  const maxThreads = number(settings.maxThreads, 100, 500);
  const bodyChars = number(settings.bodyChars, 600, 2000);
  const file = join(state, 'inbox.json');
  let kept;
  try {
    kept = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    kept = undefined;
  }
  const account = signedInAs(state);

  const listInbox = async () => {
    const listed = await call('threads', { query: { labelIds: 'INBOX', maxResults: String(maxThreads) } });
    return (listed.threads ?? []).slice(0, maxThreads).map((one) => one.id);
  };
  /** The items for `ids`, in order, reusing a kept one where `reuse` gives it. */
  const read = async (ids, options, reuse = () => undefined) => {
    const fresh = await mapLimit(ids, 3, (id) => reuse(id) ?? threadItem(call, id, options));
    return Object.fromEntries(ids.flatMap((id, index) => (fresh[index] ? [[id, fresh[index]]] : [])));
  };

  let saved;
  const same =
    kept?.historyId &&
    kept.email &&
    kept.items &&
    kept.bodyChars === bodyChars &&
    kept.maxThreads === maxThreads &&
    (account === undefined || account.toLowerCase() === kept.email.toLowerCase());
  if (same) {
    const options = { email: kept.email, bodyChars };
    const changed = await changedSince(call, kept.historyId, maxThreads);
    if (changed && changed.touched.length === 0) {
      saved = { ...kept, historyId: changed.historyId };
    } else if (changed && changed.touched.length <= maxThreads) {
      const touched = new Set(changed.touched);
      const items = await read(await listInbox(), options, (id) => (touched.has(id) ? undefined : kept.items[id]));
      saved = { ...kept, historyId: changed.historyId, items };
    }
  }
  if (!saved) {
    // The position first, so whatever changes while the inbox is read turns up in the next run's history.
    const profile = await call('profile');
    const items = await read(await listInbox(), { email: profile.emailAddress, bodyChars });
    saved = { historyId: profile.historyId, email: profile.emailAddress, bodyChars, maxThreads, items };
  }

  writePrivate(state, file, JSON.stringify(saved));
  return { items: sortItems(Object.values(saved.items)) };
}

if (isMain(import.meta.url)) {
  const folder = dirname(fileURLToPath(import.meta.url));
  const state = process.env.CRYSTAL_SCOUT_STATE || join(folder, 'state');
  runMain(() => collect({ folder, state, settings: readSettings(folder) }));
}
