import { describe, expect, it } from 'vitest';
import {
  ErrandCreate,
  ErrandEdit,
  ErrandLeftPayload,
  ErrandStateChange,
  EventType,
  HubToClient,
  MAX_ERRAND_BODY,
} from './index.js';

const id = '3f2b8c1e-5a4d-4e7f-9b6a-1c2d3e4f5a6b';
const session = '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

describe('Errands (#288)', () => {
  it('knows errand.left as an event type', () => {
    expect(EventType.options).toContain('errand.left');
  });

  it('takes an Errand a Quest leaves, its title trimmed', () => {
    const body = 'Open a large log and press **Export**.';
    expect(ErrandLeftPayload.parse({ id, title: '  Try the new export by hand ', body })).toEqual({
      id,
      title: 'Try the new export by hand',
      body,
    });
  });

  it("refuses a title that isn't one line of 1 to 120 characters, and a body over 8000", () => {
    for (const title of [' ', 'x'.repeat(121), 'Fix\nDeploy prod', 'Fix typo‮saeler']) {
      expect(ErrandLeftPayload.safeParse({ id, title, body: '' }).success).toBe(false);
    }
    expect(ErrandLeftPayload.safeParse({ id, title: 'ok', body: 'x'.repeat(MAX_ERRAND_BODY + 1) }).success).toBe(false);
    expect(ErrandLeftPayload.safeParse({ id, title: 'ok', body: 'x'.repeat(MAX_ERRAND_BODY) }).success).toBe(true);
    expect(ErrandLeftPayload.safeParse({ id: 'nope', title: 'ok', body: '' }).success).toBe(false);
  });

  it('takes an Errand by hand with an optional body and project', () => {
    expect(ErrandCreate.parse({ title: 'Renew the certificate' })).toEqual({
      title: 'Renew the certificate',
      body: '',
    });
    expect(ErrandCreate.parse({ title: 'Renew the certificate', project: '/r/lantern' }).project).toBe('/r/lantern');
    expect(ErrandCreate.safeParse({ title: 'x', project: '' }).success).toBe(false);
    expect(ErrandCreate.safeParse({ title: 'x', project: '/r/a\n/b' }).success).toBe(false);
  });

  it('takes an edit and a state', () => {
    expect(ErrandEdit.safeParse({ title: 'x' }).success).toBe(false);
    expect(ErrandEdit.safeParse({ body: '' }).success).toBe(false);
    expect(ErrandEdit.safeParse({ title: 'x', body: '' }).success).toBe(true);
    for (const state of ['open', 'done', 'dismissed']) {
      expect(ErrandStateChange.safeParse({ state }).success).toBe(true);
    }
    expect(ErrandStateChange.safeParse({ state: 'closed' }).success).toBe(false);
  });

  it("sends a Kingdom's Errands in an errands frame", () => {
    const row = {
      id,
      session,
      seq: 4,
      project: '/r/lantern',
      title: 'Run the smoke test',
      body: '',
      state: 'open',
      by: 'quest',
      created: 1,
      updated: 1,
      patrol: 'sweep',
    };
    const hand = { id, title: 'Renew', body: '', state: 'open', by: 'you', created: 1, updated: 1 };
    const done = { ...hand, state: 'done', closed: 2 };
    const frame = { kind: 'errands', node: 'node-a', errands: [row, hand, done] };
    expect(HubToClient.parse(frame)).toEqual(frame);
  });
});
