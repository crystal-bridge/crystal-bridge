import { describe, expect, it } from 'vitest';
import { NodeCommand, Resume } from './commands.js';
import { EventType } from './envelope.js';
import { MAX_QUEST_TITLE, QuestTitle, SessionTitled, TitleToolInput } from './titles.js';

const session = '11111111-1111-4111-8111-111111111111';

describe('Quest titles', () => {
  it('is a known event type', () => {
    expect(EventType.safeParse('session.titled').success).toBe(true);
  });

  it('a title is one line, trimmed, and not too long', () => {
    expect(QuestTitle.parse('  The Siege of the Flaky Smoke Test ')).toBe('The Siege of the Flaky Smoke Test');
    expect(QuestTitle.safeParse('').success).toBe(false);
    expect(QuestTitle.safeParse('   ').success).toBe(false);
    expect(QuestTitle.safeParse('two\nlines').success).toBe(false);
    expect(QuestTitle.safeParse('x'.repeat(MAX_QUEST_TITLE)).success).toBe(true);
    expect(QuestTitle.safeParse('x'.repeat(MAX_QUEST_TITLE + 1)).success).toBe(false);
  });

  it('session.titled carries the plain title, the themed one when the Quest gave it, and who named it', () => {
    const named = { title: 'Fix the flaky smoke test', themed: 'The Siege of the Flaky Smoke Test', by: 'quest' };
    expect(SessionTitled.safeParse(named).success).toBe(true);
    expect(SessionTitled.safeParse({ title: 'My name for it', by: 'you' }).success).toBe(true);
    expect(SessionTitled.safeParse({ title: 'x', by: 'someone' }).success).toBe(false);
    expect(SessionTitled.safeParse({ by: 'you' }).success).toBe(false);
  });

  it('the title tool takes a themed and a plain title', () => {
    expect(TitleToolInput.safeParse({ themed: 'The Siege', plain: 'Fix the smoke test' }).success).toBe(true);
    expect(TitleToolInput.safeParse({ plain: 'Fix the smoke test' }).success).toBe(false);
  });

  it('session.title renames a Quest from the app, and a rebuilt session knows it was renamed by you', () => {
    expect(NodeCommand.safeParse({ type: 'session.title', session, title: 'Mine' }).success).toBe(true);
    expect(NodeCommand.safeParse({ type: 'session.title', session, title: '' }).success).toBe(false);
    expect(NodeCommand.safeParse({ type: 'session.title', session }).success).toBe(false);
    expect(Resume.safeParse({ cwd: '/w', nextSeq: 3, titledByYou: true }).success).toBe(true);
  });
});
