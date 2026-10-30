import { type FormEvent, useState } from 'react';
import type { Engine, PermissionMode, Project } from '@crystal-bridge/protocol';
import { ProjectPicker } from './ProjectPicker.js';
import { loadDraft, saveDraft } from '../drafts.js';
import { engineChoices } from '../engines.js';
import { loadDefaultMode, MODES, saveDefaultMode } from '../modes.js';
import { hint, w } from '../theme/words.js';

export interface NewSessionProps {
  /** The Kingdom this session starts on: the active tab. */
  node: string;
  name: string;
  connected: boolean;
  /** The Kingdom's project folders, for the picker. */
  projects: Project[];
  /** Engines the Kingdom runs (its hello); the choice shows only when there's more than the default. */
  engines?: Engine[];
  /** A folder to start with, e.g. from the Castle's most-used folders. */
  initialCwd?: string;
  onStart: (start: {
    node: string;
    cwd: string;
    prompt: string;
    mode: PermissionMode;
    worktree: boolean;
    engine?: Engine;
  }) => void;
}

const input =
  'w-full rounded border border-neutral-300 bg-white px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900';

export function NewSession({ node, name, connected, projects, engines, initialCwd, onStart }: NewSessionProps) {
  // Unsent drafts are kept per Kingdom, so leaving this view (another tab, a Quest) doesn't lose them.
  const [cwd, setCwdState] = useState(() => initialCwd ?? loadDraft(`new-cwd:${node}`));
  const [prompt, setPromptState] = useState(() => loadDraft(`new:${node}`));
  const setCwd = (value: string) => {
    setCwdState(value);
    saveDraft(`new-cwd:${node}`, value);
  };
  const setPrompt = (value: string) => {
    setPromptState(value);
    saveDraft(`new:${node}`, value);
  };
  const [mode, setMode] = useState<PermissionMode>(() => loadDefaultMode());
  const [worktree, setWorktree] = useState(false);
  const [engine, setEngine] = useState<Engine>('stream');
  const choices = engineChoices(engines);

  const ready = connected && cwd.trim() !== '' && prompt.trim() !== '';

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready) return;
    onStart({
      node,
      cwd: cwd.trim(),
      prompt: prompt.trim(),
      mode,
      worktree,
      ...(engine !== 'stream' ? { engine } : {}),
    });
    setPrompt('');
    saveDraft(`new-cwd:${node}`, '');
  }

  return (
    <form onSubmit={submit} className="mx-auto max-w-2xl space-y-4 p-6">
      <h2 className="cb-display text-3xl leading-none" title={hint('newQuest')}>
        {w('newQuest')} on {name}
      </h2>
      {!connected && <p className="text-sm text-amber-600">{name} is offline. Sessions start once it reconnects.</p>}
      <div className="block space-y-1">
        <span className="text-sm">Project</span>
        <ProjectPicker projects={projects} value={cwd} onChange={setCwd} />
      </div>
      <label className="block space-y-1">
        <span className="text-sm">Prompt</span>
        <textarea className={input} rows={6} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      </label>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-1" checked={worktree} onChange={(e) => setWorktree(e.target.checked)} />
        <span>
          Separate worktree
          <span className="block text-xs text-neutral-500">
            Work on a new branch in its own checkout (repo/.worktrees/…), so it can't collide with another session in
            the same repository. Shares the repo&apos;s memory.
          </span>
        </span>
      </label>
      <label className="block space-y-1">
        <span className="text-sm">Permission mode</span>
        <select
          className={input}
          value={mode}
          onChange={(e) => {
            const next = e.target.value as PermissionMode;
            setMode(next);
            saveDefaultMode(next);
          }}
        >
          {MODES.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </label>
      {choices.length > 1 && (
        <label className="block space-y-1">
          <span className="text-sm">Engine</span>
          <select className={input} value={engine} onChange={(e) => setEngine(e.target.value as Engine)}>
            {choices.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      )}
      <button
        type="submit"
        disabled={!ready}
        className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:enabled:bg-blue-700 disabled:opacity-40"
      >
        Start
      </button>
    </form>
  );
}
