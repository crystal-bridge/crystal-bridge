import {
  type FormEvent,
  type ReactNode,
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import Markdown from 'react-markdown';
import type { Attachment, Envelope, UsageWindow } from '@crystal-bridge/protocol';
import {
  IncrementalView,
  sessionEngine,
  sessionForkedFrom,
  sessionEffort,
  sessionMode,
  sessionWorktree,
  slashCommands,
  type ViewItem,
} from '../model.js';
import { sessionInfo } from '../info.js';
import { beltFor, type Belt } from '../belt.js';
import { buildInventory } from '../inventory.js';
import { usePanel } from '../panels.js';
import { Icon } from '../theme/icons.js';
import { Tip } from './Tip.js';
import { hint, w } from '../theme/words.js';
import { Inventory } from './Inventory.js';
import { MODES } from '../modes.js';
import { SessionPanel, type SessionPanelProps } from './SessionPanel.js';
import type { Effort, PermissionMode } from '@crystal-bridge/protocol';
import { EFFORTS } from '../effort.js';
import { PermissionCard } from './PermissionCard.js';
import { TerminalCard } from './TerminalCard.js';
import { QuestionCard } from './QuestionCard.js';
import { PromptBox } from './PromptBox.js';
import { SkillLine, ToolCard } from './ToolCard.js';
import { ThemedSelect } from './ThemedSelect.js';
import { HeroSprite } from './HeroSprite.js';
import { FileOpenContext, MARKDOWN_COMPONENTS, REMARK_PLUGINS } from './markdown.js';
import { BattleCard } from './BattleCard.js';
import { loadDraft, saveDraft } from '../drafts.js';
import { attachedPaths, toAttachments } from '../attachments.js';
import { currentActivity } from '../activity.js';
import { type BattleResult, battleResults } from '../battle.js';
import type { HeroManifest } from '../heroes.js';
import type { ReplayProgress } from '../hub.js';

/** Within this many pixels of the bottom counts as reading the latest: new messages keep the view there. */
const PINNED_PX = 80;

/** Where each Quest was scrolled, so switching Quests and back returns there (for this page's lifetime). */
const scrollMemory = new Map<string, { top: number; pinned: boolean }>();

export interface SessionViewProps {
  /** The session shown, so its scroll position can be remembered across Quest switches. */
  session?: string;
  envelopes: Envelope[];
  /** How far the history has loaded; until synced, a loading screen stands in for the chat. Unset: loaded. */
  progress?: ReplayProgress;
  onAnswer: (requestId: string, behavior: 'allow' | 'deny', answers?: Record<string, string>) => void;
  /** Answers a terminal that's asking something: keystrokes, or the held message typed again. */
  onKeys?: (input: { keys?: string; retype?: boolean }) => void;
  /** Sends a follow-up, with any files attached to it (#14). */
  onSend: (text: string, attachments?: Attachment[]) => void;
  onInterrupt: () => void;
  onMode: (mode: PermissionMode) => void;
  /** Sets the Quest's effort from the next message on; undefined is the CLI's default. */
  onEffort?: (effort: Effort | undefined) => void;
  /** Closes the session for good; true also removes its worktree if it has one. */
  onClose?: (removeWorktree: boolean) => void;
  /** Starts a fork of this session: a copy of the conversation so far that continues separately from this prompt. */
  onFork?: (prompt: string) => void;
  /** Shows another session, e.g. the one this fork came from. */
  onOpen?: (session: string) => void;
  /** A session's label, if this client knows it, e.g. to name the Quest a fork came from. */
  labelOf?: (session: string) => string | undefined;
  /** This device's name for the session's Kingdom, for the side panel. */
  kingdom?: string;
  /** With the art pack loaded: the side panel's Party, and the party leader's state. */
  party?: SessionPanelProps['party'];
  /** For the Stats: bytes the hub has relayed about this Quest. */
  relayedBytes?: number;
  /** Hub `error` frames; any one of them re-enables cards whose answer is still being sent. */
  subscribeErrors: (listener: (message: string) => void) => () => void;
  /** One pane of a split: the Inventory and side panel are drawn once, shared, outside the panes. */
  compact?: boolean;
  /** Offers Split View (wide screens only): a second Quest beside this one. */
  onSplit?: () => void;
  /** The main pane of a split: leaves Split View, and carries the shared panels' toggles. */
  onExitSplit?: () => void;
  /** Text to put in the follow-up box, e.g. an Inventory pick from a split's shared panel; `seq` makes each one new. */
  insertion?: { text: string; seq: number };
  /** The Kingdom's Belt, shown with the Inventory, and how to change it. */
  belt?: Belt;
  onBeltChange?: (belt: Belt) => void;
  /** The Kingdom's latest plan usage report, for the side panel's HP. */
  plan?: UsageWindow[];
  /** When the Kingdom's plan report came in. */
  planAt?: number;
  /** Opens a file of this Quest in the read-only viewer: from Loot, tool cards and file names in replies. */
  onOpenFile?: (path: string) => void;
  /** The open file's viewer, shown in place of the side panel (full screen on a phone). Unused in a split's panes. */
  fileViewer?: ReactNode;
}

/** A Belt for a view that isn't given one. */
const NO_BELT = beltFor({}, '');

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** The local date and time an event was stored, for hover titles. */
function sentAt(ts: number | undefined): string | undefined {
  return ts === undefined ? undefined : new Date(ts).toLocaleString();
}

/** Copies a whole reply's markdown; confirms like a code block's copy button. */
function CopyReply({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={copied ? 'Copied' : 'Copy reply'}
      data-copied={copied}
      onClick={() =>
        void navigator.clipboard.writeText(text).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          },
          () => {},
        )
      }
      className="cb-copy rounded px-1.5 py-0.5 text-xs text-neutral-500 opacity-0 hover:bg-neutral-200 focus-visible:opacity-100 group-hover:opacity-100 dark:hover:bg-neutral-800"
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

/** How long a sent answer keeps its card's buttons disabled with no `permission.resolved`. */
const SENDING_TIMEOUT_MS = 10_000;
/** A toolbar button that shows only its icon; its name is the aria-label and the tooltip. */
const ICON_BUTTON =
  'inline-flex items-center rounded p-1 text-neutral-500 hover:bg-neutral-200 hover:text-neutral-800 dark:hover:bg-neutral-800 dark:hover:text-neutral-200';

function Item({
  item,
  sending,
  onAnswer,
  onKeys,
  battle,
  latest,
  manifest,
  ts,
}: {
  item: ViewItem;
  /** When the event behind this item was stored. */
  ts?: number;
  sending: boolean;
  onAnswer: SessionViewProps['onAnswer'];
  onKeys: NonNullable<SessionViewProps['onKeys']>;
  /** A turn's results under its `result`, or the Quest's under `closed`. */
  battle?: BattleResult;
  /** This `result` is the Quest's latest turn, with nothing after it yet. */
  latest?: boolean;
  manifest?: HeroManifest;
}) {
  switch (item.kind) {
    case 'user': {
      const { text, paths } = attachedPaths(item.text);
      return (
        <div
          title={sentAt(ts)}
          className="cb-sent-prompt ml-auto max-w-[80%] whitespace-pre-wrap rounded px-3 py-2 [overflow-wrap:anywhere]"
        >
          {text}
          {paths.length > 0 && (
            <span className="mt-1.5 flex flex-wrap gap-1">
              {paths.map((path) => (
                <span
                  key={path}
                  title={path}
                  className="inline-flex items-center gap-1 rounded-full bg-white/20 px-2 py-0.5 text-xs"
                >
                  <Icon name="attach" size={10} />
                  {path
                    .split('/')
                    .at(-1)!
                    .replace(/^\d+-\d+-/, '')}
                </span>
              ))}
            </span>
          )}
        </div>
      );
    }
    case 'assistant':
      return (
        // Long words and URLs wrap; code blocks and tables scroll inside their own box, never the pane.
        <div className="group">
          <div
            data-testid="assistant-text"
            title={sentAt(ts)}
            className="cb-prose min-w-0 max-w-none [overflow-wrap:anywhere] [&_code]:font-mono [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-neutral-100 [&_pre]:p-2 [&_pre]:[overflow-wrap:normal] [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto dark:[&_pre]:bg-neutral-900"
          >
            <Markdown components={MARKDOWN_COMPONENTS} remarkPlugins={REMARK_PLUGINS}>
              {item.text}
            </Markdown>
            {item.streaming && <span className="animate-pulse">▍</span>}
          </div>
          {!item.streaming && (
            <div className="flex justify-end">
              <CopyReply text={item.text} />
            </div>
          )}
        </div>
      );
    case 'tool':
      return item.name === 'Skill' ? <SkillLine tool={item} manifest={manifest} /> : <ToolCard tool={item} />;
    case 'permission':
      // Claude's questions come through the permission tool too; they need answers, not approval.
      if (item.toolName === 'AskUserQuestion') {
        return (
          <QuestionCard
            input={item.input}
            pending={item.pending && !sending}
            behavior={item.behavior}
            onAnswer={(behavior, answers) => onAnswer(item.requestId, behavior, answers)}
          />
        );
      }
      return (
        <PermissionCard
          toolName={item.toolName}
          input={item.input}
          pending={item.pending && !sending}
          behavior={item.behavior}
          onAnswer={(behavior) => onAnswer(item.requestId, behavior)}
        />
      );
    case 'terminal':
      return <TerminalCard text={item.text} held={item.held} onKeys={onKeys} />;
    case 'result':
      return battle ? (
        <BattleCard result={battle} kind="turn" manifest={manifest} latest={latest} />
      ) : (
        <div className={`text-xs ${item.isError ? 'text-red-600' : 'text-neutral-500'}`}>
          Turn {item.subtype.replaceAll('_', ' ')}
          {item.durationMs !== undefined && ` · ${(item.durationMs / 1000).toFixed(1)} s`}
          {item.costUsd !== undefined && ` · $${item.costUsd.toFixed(4)} total`}
        </div>
      );
    case 'notice':
      return <div className="text-xs italic text-neutral-500">{item.text}</div>;
    case 'ended':
      return (
        <div className="border-t border-neutral-300 pt-2 text-xs text-neutral-500 dark:border-neutral-700">
          {item.reason === 'idle' ? (
            'Paused while idle. Send a follow-up to resume.'
          ) : (
            <>
              Session ended (exit {item.exitCode ?? '–'}
              {item.signal ? `, ${item.signal}` : ''})
            </>
          )}
        </div>
      );
    case 'resumed':
      return <div className="text-xs text-neutral-500">Resumed</div>;
    case 'closed':
      return (
        <div className="space-y-2 border-t border-neutral-300 pt-2 text-xs text-neutral-500 dark:border-neutral-700">
          {battle && battle.turns > 0 && <BattleCard result={battle} kind="quest" manifest={manifest} />}
          <p>
            Session closed.
            {item.worktree?.removed && ' Worktree removed; its branch is kept.'}
            {item.worktree &&
              !item.worktree.removed &&
              ` Worktree kept: ${item.worktree.reason ?? 'it could not be removed'}.`}
          </p>
        </div>
      );
    case 'error':
      return (
        <div className="rounded bg-red-100 px-3 py-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-300">
          {item.message}
        </div>
      );
  }
}

/**
 * A message, re-rendered only when its item, its sending state or the answer callback changes: the view hands out a
 * new item object only when that message changed, so one streamed token redraws one message, not the whole Quest.
 */
const MemoItem = memo(Item);

/** Stands in for the chat while the hub replays a Quest's history: the party leader at rest, and how far it's got. */
function LoadingHistory({ progress, party }: { progress: ReplayProgress; party?: SessionPanelProps['party'] }) {
  return (
    <div role="status" className="flex h-full flex-col items-center justify-center gap-3 text-neutral-500">
      {party && <HeroSprite manifest={party.manifest} classId={party.manifest.leader} state="resting" size={64} />}
      <p className="cb-display text-xl">{w('loadingHistory')}</p>
      {progress.total !== null && (
        <p className="text-sm tabular-nums">
          {progress.received} of {progress.total}
        </p>
      )}
    </div>
  );
}

export function SessionView({
  session,
  progress,
  envelopes,
  onAnswer,
  onKeys,
  onSend,
  onInterrupt,
  onMode,
  onEffort,
  onClose = () => {},
  onFork,
  onOpen,
  labelOf,
  kingdom = '',
  party,
  relayedBytes,
  subscribeErrors,
  compact = false,
  onSplit,
  onExitSplit,
  insertion,
  belt = NO_BELT,
  onBeltChange,
  plan,
  planAt,
  onOpenFile,
  fileViewer,
}: SessionViewProps) {
  const view = useRef<IncrementalView | null>(null);
  view.current ??= new IncrementalView();
  const items = view.current.update(envelopes);
  // Answers sent but not yet resolved. Whether a card is answered comes only from `permission.resolved`
  // in the event stream; this just stops double clicks until that arrives, a hub error, or the timeout.
  const [sending, setSending] = useState<ReadonlySet<string>>(new Set());
  const sendingTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  // Kept per Quest on this device, so leaving the Quest (another tab, another Quest) or reloading doesn't lose it.
  const [draft, setDraft] = useState(() => (session ? loadDraft(`quest:${session}`) : ''));
  useEffect(() => {
    if (session) saveDraft(`quest:${session}`, draft);
  }, [session, draft]);
  // A pick from a split's shared Inventory, aimed at this pane. App keeps the last pick after it lands, so one
  // already there when the pane opens is old and must not replace the kept draft.
  const pickSeen = useRef(insertion?.seq);
  useEffect(() => {
    if (!insertion || insertion.seq === pickSeen.current) return;
    pickSeen.current = insertion.seq;
    setDraft(insertion.text);
  }, [insertion]);
  const scroller = useRef<HTMLDivElement>(null);
  const loading = progress !== undefined && !progress.synced;
  // Reading the latest messages: new ones keep the view at the bottom. Scrolled up to read: the view stays put.
  const pinned = useRef(true);
  const placed = useRef(false);
  const itemCount = useRef(0);
  const [unseen, setUnseen] = useState(false);
  // Stop needs a live process; a follow-up never does, since sending resumes an ended session.
  const closed = items.some((item) => item.kind === 'closed');
  const stopped =
    closed || [...items].reverse().find((item) => item.kind === 'ended' || item.kind === 'resumed')?.kind === 'ended';
  // A turn runs from a prompt or follow-up until its result, an end or a close; Stop has nothing to stop otherwise.
  const turnRunning =
    !stopped &&
    [...items].reverse().find((item) => ['user', 'result', 'ended', 'closed'].includes(item.kind))?.kind === 'user';
  // Item ids start with their event's seq (`e12`, `e12.1`): look up when that event was stored.
  const tsBySeq = useMemo(() => new Map(envelopes.map((e) => [e.seq, e.ts])), [envelopes]);
  const tsOf = (id: string) => {
    const seq = /^e(\d+)/.exec(id)?.[1];
    return seq === undefined ? undefined : tsBySeq.get(Number(seq));
  };
  const [confirmClose, setConfirmClose] = useState(false);
  // While the draft is just "/name", suggest the session's slash commands and skills.
  const commands = useMemo(() => slashCommands(envelopes), [envelopes]);
  const [highlight, setHighlight] = useState(0);
  const slashQuery = /^\/(\S*)$/.exec(draft)?.[1]?.toLowerCase();
  const suggestions =
    slashQuery === undefined ? [] : commands.filter((c) => c.toLowerCase().includes(slashQuery)).slice(0, 8);
  function complete(command: string) {
    setDraft(`/${command} `);
    setHighlight(0);
  }
  const [removeTree, setRemoveTree] = useState(true);
  const [forkDraft, setForkDraft] = useState<string | null>(null);

  function remember(pane: HTMLDivElement) {
    if (session) scrollMemory.set(session, { top: pane.scrollTop, pinned: pinned.current });
  }

  // Before paint, so the chat appears already in place: first where this Quest was left (or at the latest message),
  // then following new messages only while pinned to the bottom.
  useLayoutEffect(() => {
    const pane = scroller.current;
    if (!pane || loading) return;
    const grew = items.length > itemCount.current;
    itemCount.current = items.length;
    if (!placed.current) {
      placed.current = true;
      const saved = session ? scrollMemory.get(session) : undefined;
      pinned.current = saved?.pinned ?? true;
      pane.scrollTop = saved && !saved.pinned ? saved.top : pane.scrollHeight;
      return;
    }
    if (pinned.current) {
      pane.scrollTop = pane.scrollHeight;
      remember(pane);
    } else if (grew) {
      setUnseen(true);
    }
  }, [items, loading]);

  function onScroll() {
    const pane = scroller.current;
    if (!pane) return;
    pinned.current = pane.scrollHeight - pane.scrollTop - pane.clientHeight <= PINNED_PX;
    if (pinned.current) setUnseen(false);
    remember(pane);
  }

  function jumpToLatest() {
    const pane = scroller.current;
    if (!pane) return;
    pane.scrollTop = pane.scrollHeight;
    pinned.current = true;
    setUnseen(false);
    remember(pane);
  }

  useEffect(() => {
    const timers = sendingTimers.current;
    const unsubscribe = subscribeErrors(() => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      setSending(new Set());
    });
    return () => {
      unsubscribe();
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, [subscribeErrors]);

  function answer(requestId: string, behavior: 'allow' | 'deny', answers?: Record<string, string>) {
    setSending((prev) => new Set(prev).add(requestId));
    const timers = sendingTimers.current;
    clearTimeout(timers.get(requestId));
    timers.set(
      requestId,
      setTimeout(() => {
        timers.delete(requestId);
        setSending((prev) => {
          const next = new Set(prev);
          next.delete(requestId);
          return next;
        });
      }, SENDING_TIMEOUT_MS),
    );
    if (answers) onAnswer(requestId, behavior, answers);
    else onAnswer(requestId, behavior);
  }
  // One callback for the component's life, so memoised messages aren't redrawn just because this one was recreated.
  const latestAnswer = useRef(answer);
  latestAnswer.current = answer;
  const stableAnswer = useCallback<SessionViewProps['onAnswer']>(
    (requestId, behavior, answers) => latestAnswer.current(requestId, behavior, answers),
    [],
  );
  const latestKeys = useRef(onKeys);
  latestKeys.current = onKeys;
  const stableKeys = useCallback<NonNullable<SessionViewProps['onKeys']>>((input) => latestKeys.current?.(input), []);

  // Files picked for the next follow-up; kept only while the Quest is open.
  const [files, setFiles] = useState<File[]>([]);
  function send(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim() || (files.length > 0 ? 'See the attached files.' : '');
    if (!text) return;
    const picked = files;
    setDraft('');
    setFiles([]);
    if (picked.length === 0) onSend(text);
    else void toAttachments(picked).then((attachments) => onSend(text, attachments));
  }

  const mode = sessionMode(envelopes);
  const effort = sessionEffort(envelopes);
  const worktree = sessionWorktree(envelopes);
  const forkedFrom = sessionForkedFrom(envelopes);
  // The interactive CLI runs a leading `!` as a shell command; the stream engine sends it as text.
  const shell = sessionEngine(envelopes) === 'interactive' && draft.trimStart().startsWith('!');
  const sourceLabel = forkedFrom ? labelOf?.(forkedFrom) : undefined;
  function fork(event: FormEvent) {
    event.preventDefault();
    const prompt = forkDraft?.trim();
    if (!prompt || !onFork) return;
    onFork(prompt);
    setForkDraft(null);
  }
  // The panel needn't redraw on every streamed token; let React update it when it has time.
  const deferred = useDeferredValue(envelopes);
  const info = useMemo(() => sessionInfo(deferred), [deferred]);
  const activity = useMemo(() => currentActivity(deferred), [deferred]);
  const battles = useMemo(() => battleResults(deferred), [deferred]);
  // A Quest between turns ends on its latest result, shown open; a new message or a close folds it again.
  const latestResult = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const item = items[i]!;
      if (item.kind === 'result') return item.id;
      if (item.kind === 'user' || item.kind === 'closed') return undefined;
    }
    return undefined;
  }, [items]);
  // The same result object until its numbers change, so memoised messages don't redraw on every streamed token.
  const battleCache = useRef(new Map<string, { key: string; value: BattleResult }>());
  function stableBattle(id: string, value: BattleResult | undefined): BattleResult | undefined {
    if (!value) return undefined;
    const key = JSON.stringify(value);
    const cached = battleCache.current.get(id);
    if (cached?.key === key) return cached.value;
    battleCache.current.set(id, { key, value });
    return value;
  }
  // Shared with Split View's panels, so the toggles act on whichever is drawn.
  const [details, toggleDetails] = usePanel('details');
  const inventory = useMemo(() => buildInventory(deferred), [deferred]);
  const [inventoryOpen, toggleInventory] = usePanel('inventory');
  // In a split only the main pane carries the panel toggles (and the way out); alone, every Quest does.
  const panelToggles = !compact || onExitSplit !== undefined;

  // Unique per pane, since a split shows two Quests' toolbars at once.
  const modeId = `permission-mode-${session ?? 'quest'}`;

  return (
    <FileOpenContext.Provider value={onOpenFile ?? null}>
      <div className="flex h-full">
        {inventoryOpen && !compact && (
          <aside
            aria-label={w('inventory')}
            className="hidden w-64 shrink-0 overflow-y-auto border-r border-neutral-300 p-3 lg:block dark:border-neutral-700"
          >
            <Inventory
              inventory={inventory}
              onUse={setDraft}
              onSend={closed ? undefined : onSend}
              belt={belt}
              onBeltChange={onBeltChange ?? (() => {})}
              manifest={party?.manifest}
            />
          </aside>
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center justify-end gap-2 border-b border-neutral-300 px-4 py-1.5 text-xs dark:border-neutral-700">
            {worktree && (
              <span className="mr-auto font-mono text-neutral-500" title={`worktree of ${worktree.root}`}>
                {worktree.branch}
              </span>
            )}
            {forkedFrom && onOpen && (
              <button
                type="button"
                onClick={() => onOpen(forkedFrom)}
                title={sourceLabel}
                className={`${worktree ? '' : 'mr-auto '}max-w-xs truncate rounded px-2 py-0.5 text-neutral-500 hover:bg-neutral-200 dark:hover:bg-neutral-800`}
              >
                {sourceLabel ? `Forked from ${truncate(sourceLabel, 40)}` : 'Forked from…'}
              </button>
            )}
            {onFork && (
              <Tip text="Fork: copy this conversation into a new session that continues separately" align="end">
                <button
                  type="button"
                  aria-label="Fork"
                  onClick={() => setForkDraft((open) => (open === null ? '' : null))}
                  className={ICON_BUTTON}
                >
                  <Icon name="fork" />
                </button>
              </Tip>
            )}
            {onSplit && !compact && (
              <Tip text={hint('splitView')} align="end" className="hidden lg:inline-flex">
                <button type="button" aria-label={w('splitView')} onClick={onSplit} className={ICON_BUTTON}>
                  <Icon name="split" />
                </button>
              </Tip>
            )}
            {onExitSplit && (
              <Tip text={hint('exitSplit')} align="end" className="hidden lg:inline-flex">
                <button type="button" aria-label={w('exitSplit')} onClick={onExitSplit} className={ICON_BUTTON}>
                  <Icon name="exitSplit" />
                </button>
              </Tip>
            )}
            {panelToggles && (
              <>
                <Tip text={hint('inventory')} align="end" className="hidden lg:inline-flex">
                  <button
                    type="button"
                    aria-label={w('inventory')}
                    onClick={toggleInventory}
                    aria-pressed={inventoryOpen}
                    className={ICON_BUTTON}
                  >
                    <Icon name="inventory" />
                  </button>
                </Tip>
                <Tip text="Details: the side panel" align="end" className="hidden lg:inline-flex">
                  <button
                    type="button"
                    aria-label="Details"
                    onClick={toggleDetails}
                    aria-pressed={details}
                    className={ICON_BUTTON}
                  >
                    <Icon name="details" />
                  </button>
                </Tip>
              </>
            )}
            {!closed && (
              <Tip text="Close this Quest: its history stays, it takes no more follow-ups" align="end">
                <button
                  type="button"
                  aria-label="Close"
                  onClick={() => setConfirmClose((open) => !open)}
                  className={ICON_BUTTON}
                >
                  <Icon name="close" />
                </button>
              </Tip>
            )}
          </div>
          {forkDraft !== null && (
            <form
              onSubmit={fork}
              className="flex flex-wrap items-center gap-2 border-b border-neutral-300 bg-neutral-100 px-4 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            >
              <input
                aria-label="First prompt for the fork"
                placeholder="What should the fork try?"
                value={forkDraft}
                onChange={(e) => setForkDraft(e.target.value)}
                autoFocus
                className="min-w-0 flex-1 rounded border border-neutral-300 bg-white px-2 py-1 dark:border-neutral-700 dark:bg-neutral-950"
              />
              <button
                type="submit"
                disabled={!forkDraft.trim()}
                className="rounded bg-blue-600 px-2 py-0.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                Start fork
              </button>
              <button
                type="button"
                onClick={() => setForkDraft(null)}
                className="text-xs text-neutral-500 hover:underline"
              >
                Cancel
              </button>
            </form>
          )}
          {confirmClose && !closed && (
            <div className="flex flex-wrap items-center gap-3 border-b border-neutral-300 bg-neutral-100 px-4 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900">
              <span>Close this session? Its history stays; it takes no more follow-ups.</span>
              {worktree && (
                <label className="flex items-center gap-1.5 text-xs">
                  <input type="checkbox" checked={removeTree} onChange={(e) => setRemoveTree(e.target.checked)} />
                  Remove its worktree (kept if it has uncommitted changes; the branch always stays)
                </label>
              )}
              <button
                type="button"
                onClick={() => {
                  onClose(Boolean(worktree) && removeTree);
                  setConfirmClose(false);
                }}
                className="rounded bg-red-600 px-2 py-0.5 text-xs font-medium text-white hover:bg-red-700"
              >
                Close session
              </button>
              <button
                type="button"
                onClick={() => setConfirmClose(false)}
                className="text-xs text-neutral-500 hover:underline"
              >
                Cancel
              </button>
            </div>
          )}
          {/* The chat column is centred at a comfortable reading width; long replies are most of what people read. */}
          <div className="relative flex min-h-0 flex-1 flex-col">
            <div
              ref={scroller}
              onScroll={onScroll}
              data-testid="quest-scroll"
              className="flex-1 overflow-y-auto overflow-x-hidden p-4"
            >
              {loading ? (
                <LoadingHistory progress={progress} party={party} />
              ) : (
                <div className="mx-auto min-w-0 max-w-3xl space-y-3">
                  {items.map((item) => (
                    <MemoItem
                      key={item.id}
                      item={item}
                      sending={item.kind === 'permission' && sending.has(item.requestId)}
                      onAnswer={stableAnswer}
                      onKeys={stableKeys}
                      battle={
                        item.kind === 'result'
                          ? stableBattle(item.id, battles.turns.get(item.id))
                          : item.kind === 'closed'
                            ? stableBattle('quest', battles.quest)
                            : undefined
                      }
                      latest={item.id === latestResult}
                      manifest={party?.manifest}
                      ts={tsOf(item.id)}
                    />
                  ))}
                </div>
              )}
            </div>
            {unseen && (
              <button
                type="button"
                onClick={jumpToLatest}
                className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-blue-600 px-3 py-1 text-xs font-medium text-white shadow-lg hover:bg-blue-700"
              >
                {w('jumpToLatest')}
              </button>
            )}
          </div>
          {suggestions.length > 0 && (
            <ul
              role="listbox"
              aria-label="Slash commands"
              className="mx-3 mb-1 max-h-60 overflow-y-auto rounded border md:mx-auto md:w-full md:max-w-3xl border-neutral-300 bg-white text-sm shadow-lg dark:border-neutral-700 dark:bg-neutral-900"
            >
              {suggestions.map((command, i) => (
                <li
                  key={command}
                  role="option"
                  aria-selected={i === highlight}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => complete(command)}
                  className={`cursor-pointer px-2 py-1 font-mono ${i === highlight ? 'bg-blue-600 text-white' : 'hover:bg-neutral-100 dark:hover:bg-neutral-800'}`}
                >
                  /{command}
                </li>
              ))}
            </ul>
          )}
          <form onSubmit={send} className="border-t border-neutral-300 p-3 dark:border-neutral-700">
            {shell && (
              <div
                role="status"
                aria-label="Shell mode"
                title={hint('shellMode')}
                className="cb-display mx-auto mb-1 max-w-3xl text-xs text-rose-600 dark:text-rose-400"
              >
                ✦ {w('shellMode')}
              </div>
            )}
            <div className="mx-auto max-w-3xl">
              <PromptBox
                label="Follow-up"
                placeholder={closed ? 'Session closed' : 'Send a follow-up'}
                disabled={closed}
                value={draft}
                shell={shell}
                running={turnRunning}
                onStop={onInterrupt}
                files={closed ? undefined : { list: files, onChange: setFiles }}
                onChange={(text) => {
                  setDraft(text);
                  setHighlight(0);
                }}
                onKeyDown={(e) => {
                  if (suggestions.length > 0) {
                    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                      e.preventDefault();
                      const step = e.key === 'ArrowDown' ? 1 : -1;
                      setHighlight((h) => (h + step + suggestions.length) % suggestions.length);
                      return;
                    }
                    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
                      e.preventDefault();
                      complete(suggestions[Math.min(highlight, suggestions.length - 1)]!);
                      return;
                    }
                  }
                  if (e.key === 'Enter' && !e.shiftKey) send(e);
                }}
                controls={
                  <>
                    <ThemedSelect
                      id={modeId}
                      label="Permission mode"
                      icon="mode"
                      title="Permission mode: how much the Quest may do without asking"
                      value={mode ?? ''}
                      options={[
                        ...(mode === undefined ? [{ value: '', label: '…' }] : []),
                        ...MODES,
                        ...(mode !== undefined && !MODES.some((m) => m.value === mode)
                          ? [{ value: mode, label: mode }]
                          : []),
                      ]}
                      onChange={(value) => onMode(value as PermissionMode)}
                    />
                    {onEffort && (
                      <ThemedSelect
                        id={`effort-${session ?? 'quest'}`}
                        label="Effort"
                        icon="effort"
                        title="Effort: how hard the Quest thinks. Takes effect from your next message once this turn and any background work are done."
                        value={effort ?? ''}
                        options={EFFORTS}
                        onChange={(value) => onEffort((value as Effort) || undefined)}
                      />
                    )}
                  </>
                }
              />
            </div>
          </form>
        </div>
        {fileViewer && !compact ? (
          <aside aria-label={w('scroll')} className={FILE_ASIDE}>
            {fileViewer}
          </aside>
        ) : (
          details &&
          !compact && (
            <aside
              aria-label="Session details"
              className="hidden w-80 shrink-0 overflow-y-auto border-l border-neutral-300 p-3 lg:block dark:border-neutral-700"
            >
              <SessionPanel
                info={info}
                kingdom={kingdom}
                party={party}
                relayedBytes={relayedBytes}
                activity={activity}
                plan={plan}
                planAt={planAt}
              />
            </aside>
          )
        )}
      </div>
    </FileOpenContext.Provider>
  );
}

/** The viewer's place: the side panel, wider, on wide screens; the whole screen on a phone, over the chat. */
export const FILE_ASIDE =
  'fixed inset-0 z-40 flex flex-col bg-white lg:static lg:z-auto lg:w-[32rem] lg:shrink-0 lg:border-l lg:border-neutral-300 dark:bg-neutral-950 lg:dark:border-neutral-700';
