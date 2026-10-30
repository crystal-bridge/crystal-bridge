import { type KeyboardEvent, type SyntheticEvent, useState } from 'react';
import type { Attachment, Effort, Engine, PermissionMode, Project } from '@crystal-bridge/protocol';
import { toAttachments } from '../attachments.js';
import { ProjectPicker } from './ProjectPicker.js';
import { PromptBox } from './PromptBox.js';
import { ThemedSelect } from './ThemedSelect.js';
import { loadDraft, saveDraft } from '../drafts.js';
import { engineChoices } from '../engines.js';
import { loadDefaultMode, MODES, saveDefaultMode } from '../modes.js';
import { EFFORTS, loadDefaultEffort, saveDefaultEffort } from '../effort.js';
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
    effort?: Effort;
    attachments?: Attachment[];
  }) => void;
}

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
  const [effort, setEffort] = useState<Effort | ''>(() => loadDefaultEffort());
  // Files for the opening prompt (#14); kept only while the form is open.
  const [files, setFiles] = useState<File[]>([]);
  const choices = engineChoices(engines);

  const ready = connected && cwd.trim() !== '' && prompt.trim() !== '';

  function submit(event: SyntheticEvent) {
    event.preventDefault();
    if (!ready) return;
    const start = {
      node,
      cwd: cwd.trim(),
      prompt: prompt.trim(),
      mode,
      worktree,
      ...(engine !== 'stream' ? { engine } : {}),
      ...(effort ? { effort } : {}),
    };
    const picked = files;
    setPrompt('');
    setFiles([]);
    saveDraft(`new-cwd:${node}`, '');
    if (picked.length === 0) onStart(start);
    else void toAttachments(picked).then((attachments) => onStart({ ...start, attachments }));
  }

  // Plain Enter stays a new line: an opening prompt is often a long brief, unlike a follow-up.
  function startOnKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) submit(event);
  }

  return (
    <form onSubmit={submit} className="mx-auto max-w-2xl space-y-4 p-6">
      <h2 className="cb-display text-3xl leading-none" title={hint('newQuest')}>
        {w('newQuest')} on {name}
      </h2>
      {!connected && <p className="text-sm text-amber-600">{name} is offline. Sessions start once it reconnects.</p>}
      <div className="block space-y-1">
        <span className="cb-label">Project</span>
        <ProjectPicker projects={projects} value={cwd} onChange={setCwd} />
      </div>
      <div className="block space-y-1">
        <span className="cb-label">Prompt</span>
        <PromptBox
          label="Prompt"
          value={prompt}
          onChange={setPrompt}
          onKeyDown={startOnKey}
          running={false}
          onStop={() => {}}
          sendDisabled={!ready}
          files={{ list: files, onChange: setFiles }}
          sendLabel="Start"
          sendTitle={`Start (${/Mac/.test(navigator.platform) ? '⌘' : 'Ctrl'} Enter)`}
          minRows={3}
          controls={
            <div className="flex min-w-0 flex-wrap gap-1.5">
              <ThemedSelect
                label="Permission mode"
                icon="mode"
                title="Permission mode: how much the Quest may do without asking"
                value={mode}
                options={MODES}
                onChange={(value) => {
                  const next = value as PermissionMode;
                  setMode(next);
                  saveDefaultMode(next);
                }}
              />
              <ThemedSelect
                label="Effort"
                icon="effort"
                title="Effort: how hard the agent thinks (the CLI's --effort); Default leaves the CLI's own"
                value={effort}
                options={EFFORTS}
                onChange={(value) => {
                  const next = value as Effort | '';
                  setEffort(next);
                  saveDefaultEffort(next);
                }}
              />
              {choices.length > 1 && (
                <ThemedSelect
                  label="Engine"
                  title="Engine: how the Kingdom runs the agent"
                  value={engine}
                  options={choices}
                  onChange={(value) => setEngine(value as Engine)}
                />
              )}
            </div>
          }
        />
      </div>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="cb-check mt-0.5"
          checked={worktree}
          onChange={(e) => setWorktree(e.target.checked)}
        />
        <span>
          <span className="cb-label">Separate worktree</span>
          <span className="block text-xs text-neutral-500">
            Work on a new branch in its own checkout (repo/.worktrees/…), so it can't collide with another session in
            the same repository. Shares the repo&apos;s memory.
          </span>
        </span>
      </label>
    </form>
  );
}
