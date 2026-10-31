import { describe, expect, it } from 'vitest';
import {
  KINGDOM_PACKAGE,
  ReleaseVersion,
  isOlderVersion,
  joinCommand,
  ClientMessage,
  Envelope,
  FileReply,
  HubToClient,
  NodeCommand,
  NodeError,
  NodeExternal,
  NodeHello,
  NodeProjects,
  PROTOCOL_VERSION,
  UsagePayload,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BASE64,
} from './index.js';

const session = '123e4567-e89b-12d3-a456-426614174000';

describe('Envelope', () => {
  it('accepts a claude.event envelope', () => {
    const result = Envelope.safeParse({
      node: 'local',
      session,
      seq: 0,
      ts: Date.now(),
      type: 'claude.event',
      payload: { engine: 'claude', raw: { type: 'system', subtype: 'init' } },
    });
    expect(result.success).toBe(true);
  });

  it('accepts a user.message envelope', () => {
    const result = Envelope.safeParse({
      node: 'local',
      session,
      seq: 3,
      ts: Date.now(),
      type: 'user.message',
      payload: { text: 'follow up' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts a session.resumed envelope', () => {
    const result = Envelope.safeParse({
      node: 'local',
      session,
      seq: 7,
      ts: Date.now(),
      type: 'session.resumed',
      payload: {},
    });
    expect(result.success).toBe(true);
  });

  it('accepts a usage envelope with an engine-neutral payload', () => {
    const payload = {
      windows: [{ id: 'five_hour', label: '5h', usedPct: 9, resetsAt: 1700000000000, status: 'allowed' }],
    };
    expect(Envelope.safeParse({ node: 'local', session, seq: 4, ts: Date.now(), type: 'usage', payload }).success).toBe(
      true,
    );
    expect(UsagePayload.safeParse(payload).success).toBe(true);
    expect(
      UsagePayload.safeParse({ windows: [{ id: 'x', label: 'x', usedPct: 'lots', resetsAt: null, status: 'allowed' }] })
        .success,
    ).toBe(false);
  });

  it('rejects a negative seq', () => {
    const result = Envelope.safeParse({
      node: 'local',
      session,
      seq: -1,
      ts: Date.now(),
      type: 'claude.event',
      payload: { engine: 'claude', raw: {} },
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown type', () => {
    const result = Envelope.safeParse({
      node: 'local',
      session,
      seq: 0,
      ts: Date.now(),
      type: 'bogus.type',
      payload: {},
    });
    expect(result.success).toBe(false);
  });

  it('rejects a missing node', () => {
    const result = Envelope.safeParse({
      session,
      seq: 0,
      ts: Date.now(),
      type: 'claude.event',
      payload: { engine: 'claude', raw: {} },
    });
    expect(result.success).toBe(false);
  });
});

describe('NodeCommand', () => {
  it('accepts session.start', () => {
    const result = NodeCommand.safeParse({
      type: 'session.start',
      node: 'local',
      session,
      cwd: '/tmp/repo',
      prompt: 'say hello',
    });
    expect(result.success).toBe(true);
  });

  it('accepts session.start forking another session, and only by uuid', () => {
    const start = { type: 'session.start', node: 'local', session, cwd: '/tmp/repo', prompt: 'try again' };
    expect(NodeCommand.safeParse({ ...start, forkFrom: session }).success).toBe(true);
    expect(NodeCommand.safeParse({ ...start, forkFrom: 'latest' }).success).toBe(false);
  });

  it('accepts session.start on a named engine, and only a known one', () => {
    const start = { type: 'session.start', node: 'local', session, cwd: '/tmp/repo', prompt: 'p' };
    expect(NodeCommand.safeParse({ ...start, engine: 'interactive' }).success).toBe(true);
    expect(NodeCommand.safeParse({ ...start, engine: 'stream' }).success).toBe(true);
    expect(NodeCommand.safeParse({ ...start, engine: 'telepathy' }).success).toBe(false);
  });

  it('accepts session.start with an effort level, and only a known one; and an effort in a resume', () => {
    const start = { type: 'session.start', node: 'local', session, cwd: '/tmp/repo', prompt: 'p' };
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
      expect(NodeCommand.safeParse({ ...start, effort }).success).toBe(true);
    }
    expect(NodeCommand.safeParse({ ...start, effort: 'eleven' }).success).toBe(false);
    const resume = { cwd: '/w', nextSeq: 3, effort: 'high' };
    const parsed = NodeCommand.parse({ type: 'session.send', session, text: 'x', resume });
    expect(parsed).toMatchObject({ resume: { effort: 'high' } });
  });

  it('accepts files attached to a prompt or follow-up, within limits', () => {
    const file = { name: 'shot.png', type: 'image/png', data: 'iVBORw0KGgo=' };
    const start = { type: 'session.start', node: 'local', session, cwd: '/tmp/repo', prompt: 'look' };
    expect(NodeCommand.safeParse({ ...start, attachments: [file] }).success).toBe(true);
    expect(
      NodeCommand.safeParse({ type: 'session.send', session, text: 'and this', attachments: [file] }).success,
    ).toBe(true);
    const many = Array.from({ length: MAX_ATTACHMENTS + 1 }, () => file);
    expect(NodeCommand.safeParse({ ...start, attachments: many }).success).toBe(false);
    const huge = { ...file, data: 'A'.repeat(MAX_ATTACHMENT_BASE64 + 4) };
    expect(NodeCommand.safeParse({ ...start, attachments: [huge] }).success).toBe(false);
    expect(NodeCommand.safeParse({ ...start, attachments: [{ ...file, data: 'not base64!' }] }).success).toBe(false);
  });

  it('accepts an engine on session.adopt and in a resume', () => {
    expect(NodeCommand.safeParse({ type: 'session.adopt', node: 'n', session, engine: 'interactive' }).success).toBe(
      true,
    );
    const resume = { cwd: '/w', nextSeq: 3, engine: 'interactive' };
    expect(NodeCommand.safeParse({ type: 'session.send', session, text: 'x', resume }).success).toBe(true);
    expect(NodeCommand.safeParse({ type: 'session.close', session, resume }).success).toBe(true);
    expect(NodeCommand.safeParse({ type: 'session.adopt', node: 'n', session, engine: 'warp' }).success).toBe(false);
  });

  it('accepts session.send', () => {
    const result = NodeCommand.safeParse({
      type: 'session.send',
      session,
      text: 'follow up',
    });
    expect(result.success).toBe(true);
  });

  it('accepts session.interrupt', () => {
    const result = NodeCommand.safeParse({
      type: 'session.interrupt',
      session,
    });
    expect(result.success).toBe(true);
  });

  it('accepts permission.answer', () => {
    const result = NodeCommand.safeParse({
      type: 'permission.answer',
      session,
      requestId: 'req-1',
      behavior: 'allow',
    });
    expect(result.success).toBe(true);
  });

  it('accepts permission.answer with an optional message', () => {
    const result = NodeCommand.safeParse({
      type: 'permission.answer',
      session,
      requestId: 'req-1',
      behavior: 'deny',
      message: 'no',
    });
    expect(result.success).toBe(true);
  });

  it('rejects permission.answer with behavior maybe', () => {
    const result = NodeCommand.safeParse({
      type: 'permission.answer',
      session,
      requestId: 'req-1',
      behavior: 'maybe',
    });
    expect(result.success).toBe(false);
  });
});

describe('ClientMessage', () => {
  it('accepts a subscribe message', () => {
    const result = ClientMessage.safeParse({
      kind: 'subscribe',
      session,
      fromSeq: 0,
    });
    expect(result.success).toBe(true);
  });

  it('accepts a wrapped command message', () => {
    const result = ClientMessage.safeParse({
      kind: 'command',
      command: {
        type: 'session.interrupt',
        session,
      },
    });
    expect(result.success).toBe(true);
  });
});

describe('HubToClient', () => {
  it('accepts a replay batch with its total, and a synced marker with the last seq', () => {
    const event = { node: 'local', session, seq: 0, ts: 1, type: 'claude.event', payload: {} };
    expect(HubToClient.safeParse({ kind: 'events', session, events: [event], total: 1 }).success).toBe(true);
    expect(HubToClient.safeParse({ kind: 'events', session, events: [event] }).success).toBe(false);
    expect(HubToClient.safeParse({ kind: 'synced', session, seq: -1 }).success).toBe(true);
    expect(HubToClient.safeParse({ kind: 'synced', session, seq: -2 }).success).toBe(false);
  });

  it('accepts an event frame wrapping an envelope', () => {
    const result = HubToClient.safeParse({
      kind: 'event',
      event: {
        node: 'local',
        session,
        seq: 0,
        ts: Date.now(),
        type: 'claude.event',
        payload: { engine: 'claude', raw: {} },
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts an error frame', () => {
    const result = HubToClient.safeParse({ kind: 'error', message: 'node offline' });
    expect(result.success).toBe(true);
  });

  it('rejects an event frame with an invalid envelope', () => {
    const result = HubToClient.safeParse({
      kind: 'event',
      event: { node: 'local', session, seq: -1, ts: Date.now(), type: 'claude.event', payload: {} },
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown kind', () => {
    const result = HubToClient.safeParse({ kind: 'bogus' });
    expect(result.success).toBe(false);
  });
});

describe('NodeError', () => {
  it('accepts a node-error about a session', () => {
    const result = NodeError.safeParse({ kind: 'node-error', session, message: 'unknown session' });
    expect(result.success).toBe(true);
  });

  it('accepts a node-error with no session', () => {
    const result = NodeError.safeParse({ kind: 'node-error', message: 'something broke' });
    expect(result.success).toBe(true);
  });

  it('rejects a node-error without a message', () => {
    const result = NodeError.safeParse({ kind: 'node-error', session });
    expect(result.success).toBe(false);
  });
});

describe('session recovery fields', () => {
  it('NodeHello accepts the ids of the sessions the node still holds, and works without them', () => {
    expect(NodeHello.safeParse({ kind: 'hello', node: 'local', sessions: [session] }).success).toBe(true);
    expect(NodeHello.safeParse({ kind: 'hello', node: 'local' }).success).toBe(true);
    expect(NodeHello.safeParse({ kind: 'hello', node: 'local', sessions: ['not-a-uuid'] }).success).toBe(false);
  });

  it('session.send accepts an optional resume with the cwd and next seq', () => {
    const send = { type: 'session.send', session, text: 'hi', resume: { cwd: '/tmp/work', nextSeq: 12 } };
    expect(NodeCommand.safeParse(send).success).toBe(true);
    expect(NodeCommand.safeParse({ ...send, resume: { cwd: '/tmp/work', nextSeq: -1 } }).success).toBe(false);
  });
});

describe('external sessions', () => {
  const found = { id: session, cwd: '/home/me/code', title: 'Fix it', updatedAt: 1, messages: 4 };

  it('NodeExternal carries the sessions a node found outside the bridge', () => {
    expect(NodeExternal.safeParse({ kind: 'external', sessions: [found] }).success).toBe(true);
    expect(NodeExternal.safeParse({ kind: 'external', sessions: [{ ...found, id: 'nope' }] }).success).toBe(false);
  });

  it('session.adopt names the node and the session to take over', () => {
    expect(NodeCommand.safeParse({ type: 'session.adopt', node: 'local', session }).success).toBe(true);
    expect(NodeCommand.safeParse({ type: 'session.adopt', session }).success).toBe(false);
  });
});

describe('permission modes', () => {
  it('session.start takes an optional mode, and session.mode changes it', () => {
    const start = { type: 'session.start', node: 'local', session, cwd: '/w', prompt: 'p' };
    expect(NodeCommand.safeParse({ ...start, mode: 'auto' }).success).toBe(true);
    expect(NodeCommand.safeParse(start).success).toBe(true);
    for (const mode of ['manual', 'acceptEdits', 'auto', 'plan']) {
      expect(NodeCommand.safeParse({ type: 'session.mode', session, mode }).success).toBe(true);
    }
  });

  it('never accepts a mode that turns approvals off entirely', () => {
    for (const mode of ['bypassPermissions', 'dontAsk', 'yolo']) {
      expect(NodeCommand.safeParse({ type: 'session.mode', session, mode }).success).toBe(false);
      expect(
        NodeCommand.safeParse({ type: 'session.start', node: 'local', session, cwd: '/w', prompt: 'p', mode }).success,
      ).toBe(false);
    }
  });
});

describe('question answers', () => {
  it('permission.answer can carry answers to AskUserQuestion, keyed by question', () => {
    const answer = {
      type: 'permission.answer',
      session,
      requestId: 'r',
      behavior: 'allow',
      answers: { 'Which color?': 'Blue' },
    };
    expect(NodeCommand.safeParse(answer).success).toBe(true);
    expect(NodeCommand.safeParse({ ...answer, answers: { q: 5 } }).success).toBe(false);
  });
});

describe('attention', () => {
  it('accepts a turn.finished envelope', () => {
    const payload = { outcome: 'success', summary: 'Done.' };
    expect(Envelope.safeParse({ node: 'local', session, seq: 9, ts: 1, type: 'turn.finished', payload }).success).toBe(
      true,
    );
  });

  it('HubToClient carries attention frames for sessions that need the user, finished, or failed', () => {
    for (const reason of ['needs-you', 'done', 'failed']) {
      const frame = { kind: 'attention', node: 'local', session, label: 'Fix it', reason, detail: 'Bash' };
      expect(HubToClient.safeParse(frame).success).toBe(true);
    }
    expect(
      HubToClient.safeParse({ kind: 'attention', node: 'local', session, label: 'x', reason: 'bored' }).success,
    ).toBe(false);
  });
});

describe('protocol version', () => {
  it('hello may list the engines the node can run Quests on, including ones this hub does not know yet', () => {
    expect(NodeHello.safeParse({ kind: 'hello', node: 'n', engines: ['stream', 'interactive'] }).success).toBe(true);
    // A newer node's engine must not get it refused by an older hub; the hub keeps only engines it knows.
    expect(NodeHello.safeParse({ kind: 'hello', node: 'n', engines: ['telepathy'] }).success).toBe(true);
    expect(NodeHello.safeParse({ kind: 'hello', node: 'n', engines: [7] }).success).toBe(false);
  });

  it('hello may carry the protocol version; one without it is version 1', () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(NodeHello.safeParse({ kind: 'hello', node: 'n', protocol: 1 }).success).toBe(true);
    expect(NodeHello.safeParse({ kind: 'hello', node: 'n' }).success).toBe(true);
  });
});

describe('projects', () => {
  it('NodeProjects lists a node-s project folders, with when each was last used', () => {
    const frame = {
      kind: 'projects',
      projects: [
        { path: '/home/me/code/app', name: 'app', lastUsed: 5 },
        { path: '/x', name: 'x' },
      ],
    };
    expect(NodeProjects.safeParse(frame).success).toBe(true);
    expect(NodeProjects.safeParse({ kind: 'projects', projects: [{ path: '/x' }] }).success).toBe(false);
  });
});

describe('worktrees', () => {
  it('session.start can ask for a separate worktree', () => {
    const start = { type: 'session.start', node: 'local', session, cwd: '/w', prompt: 'p', worktree: true };
    expect(NodeCommand.safeParse(start).success).toBe(true);
  });
});

describe('closing sessions', () => {
  it('session.close may ask to remove the worktree and may carry the hub-filled resume', () => {
    expect(NodeCommand.safeParse({ type: 'session.close', session, removeWorktree: true }).success).toBe(true);
    expect(NodeCommand.safeParse({ type: 'session.close', session, resume: { cwd: '/w', nextSeq: 4 } }).success).toBe(
      true,
    );
  });

  it('accepts a session.closed envelope', () => {
    const payload = { worktree: { removed: false, reason: 'it has uncommitted changes' } };
    expect(Envelope.safeParse({ node: 'n', session, seq: 5, ts: 1, type: 'session.closed', payload }).success).toBe(
      true,
    );
  });
});

describe('file viewer', () => {
  const requestId = '123e4567-e89b-42d3-a456-426614174999';

  it('accepts a file.read command for a session, with an optional hub-filled cwd', () => {
    expect(NodeCommand.safeParse({ type: 'file.read', session, requestId, path: 'docs/README.md' }).success).toBe(true);
    expect(
      NodeCommand.safeParse({ type: 'file.read', session, requestId, path: 'a.md', cwd: '/srv/repo' }).success,
    ).toBe(true);
    expect(NodeCommand.safeParse({ type: 'file.read', session, requestId, path: '' }).success).toBe(false);
    expect(NodeCommand.safeParse({ type: 'file.read', session, requestId: 'x', path: 'a' }).success).toBe(false);
  });

  it('carries a file reply from node to hub and hub to client', () => {
    const ok = { kind: 'file', requestId, ok: true, path: 'a.md', content: '# Hi', size: 4, truncated: false };
    expect(FileReply.safeParse(ok).success).toBe(true);
    expect(HubToClient.safeParse(ok).success).toBe(true);
    const refused = { kind: 'file', requestId, ok: false, reason: 'outside this Quest-s folder' };
    expect(HubToClient.safeParse(refused).success).toBe(true);
  });
});

describe('installing a Kingdom', () => {
  it('builds the command that joins a machine to a hub', () => {
    const command = joinCommand('https://hub.example.com', 'CODE');
    expect(command).toBe(
      `npx --yes --package=${KINGDOM_PACKAGE} crystal-bridge-kingdom join https://hub.example.com CODE`,
    );
  });
});

describe('ReleaseVersion', () => {
  it.each(['1.2.3', '0.2.0-alpha.1', '10.0.0-rc-2'])('takes %s', (version) => {
    expect(ReleaseVersion.safeParse(version).success).toBe(true);
  });

  it.each(['', 'latest', 'v1.2.3', '1.2', '1.2.3/../..', '../1.2.3', '1.2.3-..', '1.2.3-a/b', '1.2.3\n', '1.2.3 x'])(
    'refuses %j, which could leave the releases folder or the URL',
    (version) => {
      expect(ReleaseVersion.safeParse(version).success).toBe(false);
    },
  );
});

describe('isOlderVersion', () => {
  it('orders versions, pre-releases before their release, numbers as numbers', () => {
    expect(isOlderVersion('1.2.3', '1.2.4')).toBe(true);
    expect(isOlderVersion('1.9.0', '1.10.0')).toBe(true);
    expect(isOlderVersion('1.0.0-alpha.2', '1.0.0-alpha.10')).toBe(true);
    expect(isOlderVersion('1.0.0-rc.1', '1.0.0')).toBe(true);
    expect(isOlderVersion('1.0.0', '1.0.0-rc.1')).toBe(false);
    expect(isOlderVersion('1.0.0', '1.0.0')).toBe(false);
  });

  it('never calls a commit, a dev build or nothing older', () => {
    expect(isOlderVersion('0d821f4', '1.0.0')).toBe(false);
    expect(isOlderVersion('1.0.0', 'dev')).toBe(false);
    expect(isOlderVersion(undefined, '1.0.0')).toBe(false);
  });
});
