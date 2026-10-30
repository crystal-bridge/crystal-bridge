import { useState } from 'react';
import type { Engine, ExternalSession } from '@crystal-bridge/protocol';
import { engineChoices } from '../engines.js';
import { formatUntil } from './NodeUsage.js';

/** A transcript that changed this recently is probably still open in a terminal. */
const LIVE_MS = 2 * 60_000;

export interface FoundSessionsProps {
  /** The Kingdom's display name. */
  name: string;
  sessions: ExternalSession[];
  connected: boolean;
  /** Engines the Kingdom runs (its hello); the choice shows only when there's more than the default. */
  engines?: Engine[];
  /** Adopts a session; `engine` is set only when one other than the default was chosen. */
  onAdopt: (id: string, engine?: Engine) => void;
  now?: number;
}

/** Sessions the Kingdom's engine ran outside the bridge, e.g. in a terminal, offered for adoption. */
export function FoundSessions({ name, sessions, connected, engines, onAdopt, now = Date.now() }: FoundSessionsProps) {
  const [open, setOpen] = useState<string | null>(null);
  const [engine, setEngine] = useState<Engine>('stream');
  const choices = engineChoices(engines);
  if (sessions.length === 0) return null;

  return (
    <section className="border-t border-neutral-300 pt-2 dark:border-neutral-700">
      <h3 className="px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-neutral-500">Found on {name}</h3>
      <ul>
        {sessions.map((session) => {
          const live = now - session.updatedAt < LIVE_MS;
          const folder = session.cwd.split('/').filter(Boolean).at(-1) ?? session.cwd;
          return (
            <li key={session.id} className="px-3 py-1.5 text-sm">
              <button
                type="button"
                onClick={() => setOpen((current) => (current === session.id ? null : session.id))}
                className="block w-full truncate text-left text-neutral-700 hover:text-neutral-950 dark:text-neutral-300 dark:hover:text-white"
              >
                {session.title}
              </button>
              <div className="truncate text-xs text-neutral-500" title={session.cwd}>
                {folder} · {live ? 'just now' : `${formatUntil(now, session.updatedAt)} ago`}
              </div>
              {open === session.id && (
                <div className="mt-1 space-y-1 rounded bg-neutral-200 p-2 text-xs dark:bg-neutral-800">
                  <p>
                    Bring this conversation ({session.messages} messages) into Crystal Bridge. Its history shows here,
                    and your first follow-up resumes it in {session.cwd}.
                  </p>
                  {live && (
                    <p className="text-amber-600 dark:text-amber-400">
                      It changed in the last two minutes, so it may still be open in a terminal. Close it there first,
                      or both will write to the same conversation.
                    </p>
                  )}
                  {choices.length > 0 && (
                    <label className="flex items-center gap-2">
                      <span>Engine</span>
                      <select
                        value={engine}
                        onChange={(e) => setEngine(e.target.value as Engine)}
                        className="min-w-0 flex-1 rounded border border-neutral-300 bg-white px-1 py-0.5 dark:border-neutral-700 dark:bg-neutral-900"
                      >
                        {choices.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <button
                    type="button"
                    disabled={!connected}
                    onClick={() => (engine === 'stream' ? onAdopt(session.id) : onAdopt(session.id, engine))}
                    className="rounded bg-blue-600 px-2 py-1 font-medium text-white hover:enabled:bg-blue-700 disabled:opacity-40"
                  >
                    Adopt
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
