#!/usr/bin/env node
/**
 * The Gmail Scout's `run` actions (docs/SCOUTS.md). Reads `{ scout, action, items }` on stdin and acts on each item's
 * thread: `archive` takes it out of the inbox, `spam` moves it to Spam, and `filter` makes a filter that skips the
 * inbox for each item's sender, then archives the threads. Every item is checked before anything changes.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FILTERABLE, accessToken, gmail, isMain, readClient, runMain } from './gmail.mjs';

const CHANGES = {
  archive: { removeLabelIds: ['INBOX'] },
  // Gmail doesn't document whether this teaches its spam filter the way the Report spam button does.
  spam: { addLabelIds: ['SPAM'], removeLabelIds: ['INBOX'] },
  filter: { removeLabelIds: ['INBOX'] },
};

export async function act({ fetch = globalThis.fetch, folder, state, action, items }) {
  if (!Object.hasOwn(CHANGES, action)) throw new Error(`unknown action: ${action}`);
  const threads = items.map((item) => {
    const id = /^thread:([A-Za-z0-9]+)$/.exec(String(item?.id))?.[1];
    if (!id) throw new Error(`${item?.id} is not a Gmail thread`);
    return id;
  });
  const senders = [];
  if (action === 'filter') {
    for (const item of items) {
      const address = item.fields?.fromAddress;
      if (typeof address !== 'string' || !FILTERABLE.test(address)) {
        throw new Error(`no sender to filter on for ${item.id}`);
      }
      if (!senders.includes(address)) senders.push(address);
    }
  }

  const client = readClient(folder);
  const call = gmail({ fetch, token: await accessToken({ fetch, client, state }) });
  for (const from of senders) {
    try {
      await call('settings/filters', {
        method: 'POST',
        body: { criteria: { from }, action: { removeLabelIds: ['INBOX'] } },
      });
    } catch (error) {
      if (!(error.status === 400 && /already exists/i.test(error.message))) throw error;
    }
  }
  for (const id of threads) {
    try {
      await call(`threads/${id}/modify`, { method: 'POST', body: CHANGES[action] });
    } catch (error) {
      // Deleted since the last run: nothing is left to archive, so it counts as done.
      if (error.status !== 404) throw error;
    }
  }
}

if (isMain(import.meta.url)) {
  const folder = dirname(fileURLToPath(import.meta.url));
  const state = process.env.CRYSTAL_SCOUT_STATE || join(folder, 'state');
  runMain(async () => {
    const input = JSON.parse(readFileSync(0, 'utf8'));
    await act({ folder, state, action: process.env.CRYSTAL_SCOUT_ACTION || input.action, items: input.items ?? [] });
  });
}
