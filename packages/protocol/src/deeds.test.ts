import { describe, expect, it } from 'vitest';
import {
  DeedDetail,
  DeedRecordedPayload,
  DeedsClosingOutcome,
  DeedsClosingPayload,
  DeedsPage,
  EventType,
  HubToClient,
  MAX_DEED_DETAIL,
  MAX_TALLY_LINK,
  NodeCommand,
  NodeHello,
  TurnTallyPayload,
} from './index.js';

const id = '3f2b8c1e-5a4d-4e7f-9b6a-1c2d3e4f5a6b';
const session = '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

describe('Deeds (#289)', () => {
  it('knows the three Deeds events', () => {
    for (const type of ['turn.tally', 'deed.recorded', 'deeds.closing']) {
      expect(EventType.options).toContain(type);
    }
  });

  it("takes a turn's tally, with at most 10 pull requests", () => {
    const tally = { seq: 7, files: 12, prs: ['https://example.com/acme/lantern/pull/319'] };
    expect(TurnTallyPayload.parse(tally)).toEqual(tally);
    const pr = tally.prs[0]!;
    expect(TurnTallyPayload.safeParse({ ...tally, prs: Array(11).fill(pr) }).success).toBe(false);
    expect(TurnTallyPayload.safeParse({ ...tally, prs: Array(10).fill(pr) }).success).toBe(true);
    expect(TurnTallyPayload.safeParse({ ...tally, files: -1 }).success).toBe(false);
    expect(TurnTallyPayload.safeParse({ ...tally, seq: 1.5 }).success).toBe(false);
    expect(TurnTallyPayload.safeParse({ ...tally, prs: ['javascript:alert(1)'] }).success).toBe(false);
  });

  it(`takes a pull request link of up to ${MAX_TALLY_LINK} characters`, () => {
    expect(MAX_TALLY_LINK).toBe(500);
    const link = (length: number) => `https://example.com/${'x'.repeat(length - 27)}/pull/1`;
    expect(link(MAX_TALLY_LINK)).toHaveLength(MAX_TALLY_LINK);
    const tally = (pr: string) => TurnTallyPayload.safeParse({ seq: 1, files: 0, prs: [pr] }).success;
    expect(tally(link(MAX_TALLY_LINK))).toBe(true);
    expect(tally(link(MAX_TALLY_LINK + 1))).toBe(false);
  });

  it('takes a Deed, its line trimmed, its detail optional', () => {
    const detail = 'Dropped the polyfill; the image is 30 MB smaller.';
    const parsed = DeedRecordedPayload.parse({ id, deed: '  Moved the hub to Node 24 ', detail });
    expect(parsed).toEqual({ id, deed: 'Moved the hub to Node 24', detail });
    expect(DeedRecordedPayload.parse({ id, deed: 'Moved', closing: true }).closing).toBe(true);
    expect(DeedRecordedPayload.safeParse({ id, deed: 'Moved', closing: false }).success).toBe(false);
  });

  it("refuses a line that isn't one line of 1 to 120 characters, and a detail over 280 or with a line break", () => {
    for (const deed of [' ', 'x'.repeat(121), 'Fix\nDeploy']) {
      expect(DeedRecordedPayload.safeParse({ id, deed }).success).toBe(false);
    }
    expect(DeedRecordedPayload.safeParse({ id, deed: 'ok', detail: 'x'.repeat(MAX_DEED_DETAIL + 1) }).success).toBe(
      false,
    );
    expect(DeedRecordedPayload.safeParse({ id, deed: 'ok', detail: 'a\nb' }).success).toBe(false);
    expect(DeedRecordedPayload.safeParse({ id, deed: 'ok', detail: 'x'.repeat(MAX_DEED_DETAIL) }).success).toBe(true);
    expect(DeedRecordedPayload.safeParse({ id: 'nope', deed: 'ok' }).success).toBe(false);
  });

  it('takes how the call at Close went', () => {
    const recorded = { outcome: 'recorded', costUsd: 0.08 };
    expect(DeedsClosingPayload.parse(recorded)).toEqual(recorded);
    for (const outcome of ['empty', 'timeout', 'budget', 'failed', 'unreadable']) {
      const body = { outcome, reason: 'x'.repeat(300) };
      expect(DeedsClosingPayload.parse(body)).toEqual(body);
      expect(DeedsClosingPayload.safeParse({ outcome, reason: 'x'.repeat(301) }).success).toBe(false);
    }
    expect(DeedsClosingPayload.safeParse({ outcome: 'skipped' }).success).toBe(false);
    expect(DeedsClosingOutcome.parse('writing')).toBe('writing');
    expect(DeedsClosingPayload.parse({ outcome: 'writing' })).toEqual({ outcome: 'writing' });
  });

  it('refuses a detail with a tab, a zero-width space or a bidi override', () => {
    expect(DeedDetail.parse('Image 30 MB smaller.')).toBe('Image 30 MB smaller.');
    for (const detail of ['Image\tsmaller', 'Image\u200Bsmaller', 'Image \u202Etxt.exe']) {
      expect(DeedDetail.safeParse(detail).success).toBe(false);
    }
  });

  it('reads a page of the feed, with a cursor for the rest of a full window', () => {
    const row = { id: `turn:${id}:4`, kind: 'turn', at: 5 };
    expect(DeedsPage.parse({ deeds: [row], older: 1 })).toEqual({ deeds: [row], older: 1 });
    const full = { deeds: [row], more: { at: 5, id: row.id } };
    expect(DeedsPage.parse(full)).toEqual(full);
    expect(DeedsPage.safeParse({ deeds: [], more: { at: 5 } }).success).toBe(false);
  });

  it('tells clients a forgotten Kingdom’s feed is gone', () => {
    const cleared = { kind: 'deeds', node: 'node-a', deeds: [], cleared: true };
    expect(HubToClient.parse(cleared)).toEqual(cleared);
    expect(HubToClient.safeParse({ ...cleared, cleared: false }).success).toBe(false);
  });

  it('sends rows in a deeds frame', () => {
    const project = '/r/lantern';
    const turn = {
      id: `turn:${id}:4`,
      session,
      seq: 4,
      project,
      kind: 'turn',
      text: 'Node 24 is in.',
      outcome: 'success',
      costUsd: 0.74,
      durationMs: 1320000,
      files: 4,
      prs: [],
      at: 1,
    };
    const deed = { id: `deed:${id}`, session, seq: 5, project, kind: 'closing', text: 'Released v0.8.1', at: 2 };
    const run = {
      id: `run:${id}`,
      patrol: 'backup',
      kind: 'patrol',
      text: 'Backed up 4 repos.',
      outcome: 'finished',
      durationMs: 72000,
      at: 3,
    };
    const close = { id: `close:${id}:6`, session, seq: 6, kind: 'close', outcome: 'recorded', costUsd: 0.1, at: 4 };
    const frame = { kind: 'deeds', node: 'node-a', deeds: [turn, deed, run, close] };
    expect(HubToClient.parse(frame)).toEqual(frame);
  });

  it('closes with or without the call, and a Kingdom says it makes one', () => {
    const close = NodeCommand.parse({ type: 'session.close', session, deeds: true });
    expect(close).toMatchObject({ type: 'session.close', deeds: true });
    expect(NodeHello.parse({ kind: 'hello', node: 'node-a', deeds: true }).deeds).toBe(true);
  });
});
