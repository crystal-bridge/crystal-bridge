import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Envelope, PROTOCOL_VERSION } from '../packages/protocol/src/index.js';
import { demoWorld } from './demo-scenes.js';

describe('the demo world', () => {
  const world = demoWorld();
  const events = world.stories.flatMap((story) => story.events);

  it('keeps a background agent in the Party: launched, with nothing yet to say it finished', () => {
    const payloads = events.flatMap((event) => (event.type === 'claude.event' ? [event.payload] : []));
    const raws = payloads.map((payload) => (payload as { raw: Record<string, unknown> }).raw);
    assert.ok(raws.some((raw) => (raw.tool_use_result as { isAsync?: boolean } | undefined)?.isAsync));
    assert.ok(!raws.some((raw) => raw.subtype === 'task_notification'));
  });

  it('is made of valid envelopes, in order, one stream per Quest', () => {
    assert.equal(PROTOCOL_VERSION, 1);
    for (const story of world.stories) {
      assert.equal(story.events[0]!.type, 'session.started');
      story.events.forEach((event, seq) => {
        Envelope.parse(event);
        assert.equal(event.seq, seq);
        assert.equal(event.session, story.session);
      });
    }
  });

  it('only places Quests on Kingdoms that exist', () => {
    const ids = new Set(world.kingdoms.map((kingdom) => kingdom.id));
    for (const story of world.stories) assert.ok(ids.has(story.node));
  });

  it('never names a real model', () => {
    const models = [...JSON.stringify(events).matchAll(/"model":"([^"]+)"/g)].map((match) => match[1]);
    assert.ok(models.length > 0);
    assert.deepEqual([...new Set(models)], ['claude-model']);
  });

  it('leaves something waiting on the user, and every approval carries the story on', () => {
    const asks = events.filter((event) => event.type === 'permission.request');
    assert.ok(asks.length >= 3);
    assert.ok(world.onApprove.size >= 2);
    for (const continueStory of world.onApprove.values()) {
      const more = continueStory();
      assert.equal(more[0]!.type, 'permission.resolved');
      assert.equal(more.at(-1)!.type, 'turn.finished');
    }
  });
});
