import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const FORM = new URL('../.github/DISCUSSION_TEMPLATE/party-member-needed.yml', import.meta.url);

describe('the Party Member Needed form', () => {
  it('asks for the setup, what to try, the evidence and how to answer', () => {
    const form = readFileSync(FORM, 'utf8');
    for (const label of ['The setup we need', 'What to try', 'What it costs', 'Evidence to collect', 'How to answer']) {
      assert.match(form, new RegExp(`label: ${label}`));
    }
  });

  it('tells a tester what never to post', () => {
    assert.match(readFileSync(FORM, 'utf8'), /tokens/i);
  });
});
