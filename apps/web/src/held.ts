import type { Envelope } from '@crystal-bridge/protocol';
import { attachedPaths } from './attachments.js';
import { loadDraft, saveDraft } from './drafts.js';

/** A follow-up that has left the box but hasn't come back from the Kingdom as its `user.message`, the only proof. */
export interface HeldSend {
  /** What was sent. */
  text: string;
  /** What the box held, to put back. */
  draft: string;
  /** Kept only while the Quest is open, like files waiting in the box. */
  files: File[];
  /** The latest seq when it was sent: only an event after this can be its echo. */
  afterSeq: number;
}

const key = (session: string) => `quest-held:${session}`;

/** What's on its way, kept on the device, so leaving the Quest or reloading can't lose it. */
export function saveHeld(session: string, held: readonly HeldSend[]): void {
  const kept = held.map(({ text, draft, afterSeq }) => ({ text, draft, afterSeq }));
  saveDraft(key(session), kept.length > 0 ? JSON.stringify(kept) : '');
}

export function loadHeld(session: string): HeldSend[] {
  try {
    const kept = JSON.parse(loadDraft(key(session)) || '[]') as Omit<HeldSend, 'files'>[];
    return kept.map((send) => ({ ...send, files: [] }));
  } catch {
    return [];
  }
}

/** The sends with no echo yet, oldest first. One echo settles one send, so saying the same thing twice counts twice. */
export function unechoed(held: readonly HeldSend[], envelopes: readonly Envelope[]): HeldSend[] {
  const oldest = Math.min(...held.map((send) => send.afterSeq));
  const echoes: { seq: number; text: string }[] = [];
  for (let i = envelopes.length - 1; i >= 0 && envelopes[i]!.seq > oldest; i--) {
    const { type, seq, payload } = envelopes[i]!;
    const text = (payload as { text?: unknown } | null)?.text;
    if (type === 'user.message' && typeof text === 'string') echoes.unshift({ seq, text });
  }
  return held.filter((send) => {
    const at = echoes.findIndex(
      (echo) =>
        echo.seq > send.afterSeq &&
        // The Kingdom adds a line per attached file to the text it records.
        (echo.text === send.text || attachedPaths(echo.text).text === send.text),
    );
    if (at < 0) return true;
    echoes.splice(at, 1);
    return false;
  });
}
