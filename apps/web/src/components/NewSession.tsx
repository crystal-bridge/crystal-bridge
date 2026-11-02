import { type KeyboardEvent, type SyntheticEvent, useEffect, useMemo, useRef, useState } from 'react';
import type { Attachment, Effort, Engine, PermissionMode, Project, UsageWindow } from '@crystal-bridge/protocol';
import { toAttachments } from '../attachments.js';
import { BELT_SIZE, type Belt } from '../belt.js';
import type { HeroManifest } from '../heroes.js';
import type { SessionInfo } from '../info.js';
import { buildInventory, listedEnvelopes } from '../inventory.js';
import { slashCommands } from '../model.js';
import { usePanel } from '../panels.js';
import { Inventory } from './Inventory.js';
import { PanelToggles } from './PanelToggles.js';
import { ProjectPicker } from './ProjectPicker.js';
import { PromptBox } from './PromptBox.js';
import { SessionPanel } from './SessionPanel.js';
import { SlashMenu, useSlashMenu } from './SlashMenu.js';
import { ThemedSelect } from './ThemedSelect.js';
import { loadDraft, saveDraft } from '../drafts.js';
import { engineChoices } from '../engines.js';
import { loadDefaultMode, MODES, saveDefaultMode } from '../modes.js';
import { EFFORTS, loadDefaultEffort, saveDefaultEffort } from '../effort.js';
import { hint, w } from '../theme/words.js';

type ListedEvents = { engine: string; raw: unknown }[];

const NO_BELT: Belt = Array.from({ length: BELT_SIZE }, () => null);
/** Long enough that typing a path asks about the path, not each letter of it. */
const LIST_DELAY_MS = 500;

/** The Kingdom's list for this folder. The last one stays up while the next loads, so moving between projects doesn't blink. */
function useListing(
  node: string,
  cwd: string,
  connected: boolean,
  listInventory: ((cwd: string, signal: AbortSignal) => Promise<ListedEvents>) | undefined,
  delayMs: number,
) {
  const [events, setEvents] = useState<ListedEvents | null>(null);
  const [state, setState] = useState<'loading' | 'listed' | 'failed'>('loading');
  const list = useRef(listInventory);
  list.current = listInventory;
  const canList = connected && listInventory !== undefined;
  useEffect(() => {
    if (!canList) {
      setState('failed');
      return;
    }
    setState('loading');
    const stop = new AbortController();
    const timer = setTimeout(() => {
      void list
        .current?.(cwd, stop.signal)
        .then((listed) => {
          if (stop.signal.aborted) return;
          setEvents(listed);
          setState('listed');
        })
        .catch(() => {
          if (!stop.signal.aborted) setState('failed');
        });
    }, delayMs);
    return () => {
      clearTimeout(timer);
      stop.abort();
    };
  }, [node, cwd, canList, delayMs]);
  const envelopes = useMemo(() => listedEnvelopes(node, events ?? []), [node, events]);
  return { envelopes, listed: events !== null, state };
}

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
  /** A start from here is waiting for the Kingdom to report it running. */
  starting?: boolean;
  /** The Kingdom's Belt, and how to change it. */
  belt?: Belt;
  onBeltChange?: (belt: Belt) => void;
  /** Asks the Kingdom what a Quest could use in a folder; a blank folder is its home. */
  listInventory?: (cwd: string, signal: AbortSignal) => Promise<ListedEvents>;
  /** The wait before asking (tests). */
  listDelayMs?: number;
  /** With the art pack loaded: the Kingdom's leader, for the Party. */
  manifest?: HeroManifest;
  /** The Kingdom picks a leader per Quest, so there isn't one yet. */
  variedLeader?: boolean;
  /** The Kingdom's latest plan usage report, and when it came in. */
  plan?: UsageWindow[];
  planAt?: number;
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

export function NewSession({
  node,
  name,
  connected,
  projects,
  engines,
  initialCwd,
  starting = false,
  belt = NO_BELT,
  onBeltChange,
  listInventory,
  listDelayMs = LIST_DELAY_MS,
  manifest,
  variedLeader = false,
  plan,
  planAt,
  onStart,
}: NewSessionProps) {
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
  const [inventoryOpen] = usePanel('inventory');
  const [details] = usePanel('details');

  const folder = cwd.trim();
  const { envelopes, listed, state } = useListing(node, folder, connected, listInventory, listDelayMs);
  const inventory = useMemo(() => buildInventory(envelopes), [envelopes]);
  const commands = useMemo(() => slashCommands(envelopes), [envelopes]);
  const slash = useSlashMenu(prompt, commands, setPrompt);
  const preview =
    state === 'failed'
      ? `The ${w('inventory')} appears once the ${w('quest')} starts.`
      : state === 'loading' && !listed
        ? `Asking ${name} what it holds…`
        : `Live from ${name}.`;
  const info: SessionInfo = {
    ...(folder ? { cwd: folder } : {}),
    mode,
    ...(effort ? { effort } : {}),
    costUsd: 0,
    stats: { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, turns: 0, workingMs: 0 },
    outputs: [],
    tasks: [],
    party: [],
  };
  // In front of the brief, not over it: this box can hold a long one, and an Inventory pick has no undo.
  const use = (text: string) => setPrompt(prompt.startsWith(text) ? prompt : `${text}${prompt}`);

  // Files being read for a start that hasn't gone out yet.
  const [reading, setReading] = useState(false);
  const [unreadable, setUnreadable] = useState(false);
  const busy = starting || reading;
  const ready = connected && cwd.trim() !== '' && prompt.trim() !== '' && !busy;

  // Everything stays until the Kingdom reports the Quest started: App clears the drafts then. On a failure it's all here.
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
    if (files.length === 0) {
      onStart(start);
      return;
    }
    setReading(true);
    setUnreadable(false);
    void toAttachments(files)
      .then((attachments) => onStart({ ...start, attachments }))
      .catch(() => setUnreadable(true))
      .finally(() => setReading(false));
  }

  // Plain Enter stays a new line: an opening prompt is often a long brief, unlike a follow-up.
  function startOnKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (slash.onKey(event)) return;
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) submit(event);
  }

  return (
    <div className="flex h-full">
      {inventoryOpen && (
        <aside
          aria-label={w('inventory')}
          className="hidden w-64 shrink-0 overflow-y-auto border-r border-neutral-300 p-3 lg:block dark:border-neutral-700"
        >
          <Inventory
            inventory={inventory}
            onUse={use}
            belt={belt}
            onBeltChange={onBeltChange ?? (() => {})}
            manifest={manifest}
            preview={preview}
          />
        </aside>
      )}
      <form onSubmit={submit} className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-end gap-2 border-b border-neutral-300 px-4 py-1.5 text-xs dark:border-neutral-700">
          <PanelToggles />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <div className="mx-auto max-w-3xl space-y-4">
            <h2 className="cb-display text-3xl leading-none" title={hint('newQuest')}>
              {w('newQuest')} on {name}
            </h2>
            {!connected && (
              <p className="text-sm text-amber-600">{name} is offline. Sessions start once it reconnects.</p>
            )}
            {starting && (
              <p role="status" title={hint('starting')} className="cb-display text-xl text-neutral-500">
                {w('starting')}
              </p>
            )}
            <div className="block space-y-1">
              <span className="cb-label">Project</span>
              <ProjectPicker projects={projects} value={cwd} onChange={setCwd} />
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
                  Work on a new branch in its own checkout (repo/.worktrees/…), so it can&apos;t collide with another
                  session in the same repository. Shares the repo&apos;s memory.
                </span>
              </span>
            </label>
            {unreadable && (
              <p role="alert" className="text-sm text-red-600 dark:text-red-400">
                {`A file couldn't be read, so nothing started. Take it off and try again; your ${w('quest')} is still here.`}
              </p>
            )}
          </div>
        </div>
        <SlashMenu menu={slash} />
        <div className="border-t border-neutral-300 p-3 dark:border-neutral-700">
          <div className="mx-auto max-w-3xl">
            <PromptBox
              label="Prompt"
              placeholder={`What should this ${w('quest')} do?`}
              disabled={busy}
              value={prompt}
              onChange={(text) => {
                setPrompt(text);
                slash.reset();
              }}
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
        </div>
      </form>
      {details && (
        <aside
          aria-label="Session details"
          className="hidden w-80 shrink-0 overflow-y-auto border-l border-neutral-300 p-3 lg:block dark:border-neutral-700"
        >
          <SessionPanel
            info={info}
            kingdom={name}
            party={manifest && !variedLeader ? { manifest, leaderState: 'resting' } : undefined}
            partyNote={manifest && variedLeader ? `Your leader is chosen when the ${w('quest')} starts` : undefined}
            plan={plan}
            planAt={planAt}
            preStart
          />
        </aside>
      )}
    </div>
  );
}
