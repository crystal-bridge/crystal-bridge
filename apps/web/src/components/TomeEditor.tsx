/**
 * The Library's editor (docs/LIBRARY.md, "Scribe your own: the editor"): a plain text box beside a live preview, as tabs
 * on a narrow screen. A save names the version the text was edited from, so a file that changed meanwhile is caught,
 * and a `library-changed` for the open Tome is caught while editing; either shows the changed-on-disk banner. Unsaved
 * text is kept as a draft on this device. Line endings stay as the file had them.
 */
import { type LibraryTome, MAX_TOME_BYTES, type TomeVersion } from '@crystal-bridge/protocol';
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { diffLines } from '../diff.js';
import { loadDraft, saveDraft } from '../drafts.js';
import type { HubClient } from '../hub.js';
import { LIBRARY_TONE, readTome, writeTome } from '../library.js';
import { Icon } from '../theme/icons.js';
import { w } from '../theme/words.js';
import { Diff } from './Diff.js';
import { canEdit, TomeReader } from './TomeReader.js';

type LibraryHub = Pick<HubClient, 'onLibraryChanged' | 'watchLibrary'>;

export interface TomeEditorProps {
  hub: LibraryHub;
  /** The Kingdom whose Library this is. */
  node: string;
  /** The Tome's path in the Library. */
  path: string;
  /** The Tome as read; absent for a new Tome, which is made on the first save. */
  tome?: LibraryTome | undefined;
  /** Every file path in the listing, for the preview's wiki links. */
  paths: readonly string[];
  /** A save went through; the file is now at this version. */
  onSaved: (version: TomeVersion) => void;
  /** Leave the editor (after a save, or Cancel). */
  onClose: () => void;
}

type View = 'write' | 'split' | 'preview';
/** What the banner knows of the file on disk: a newer version (its text once read), or that it's gone. */
type Disk = { kind: 'changed'; version: TomeVersion; content?: string } | { kind: 'gone' };
type Asking = 'reload' | 'keep' | 'recreate' | 'discard' | null;
interface Draft {
  text: string;
  base: TomeVersion | null;
}

/** The editor works in `\n`; the file's own endings are put back on save. */
const lf = (text: string) => text.replace(/\r\n/g, '\n');
const draftKey = (node: string, path: string) => `tome:${node}:${path}`;
const DRAFT_WAIT_MS = 400;
/** The preview's version for a Tome that isn't on disk yet. */
const NO_VERSION: TomeVersion = { size: 0, mtimeMs: 0, hash: '0'.repeat(64) };
const WIDE = '(min-width: 1024px)';
const VIEW_NAMES: Record<View, string> = { write: 'Write', split: 'Split', preview: 'Preview' };

function readDraft(node: string, path: string): Draft | null {
  try {
    const saved = JSON.parse(loadDraft(draftKey(node, path)) || 'null') as Partial<Draft> | null;
    return typeof saved?.text === 'string' ? { text: saved.text, base: saved.base ?? null } : null;
  } catch {
    return null;
  }
}

/** A hub refusal in plain words. */
function plain(reason: string): string {
  const tome = w('tome');
  const words: Record<string, string> = {
    exists: 'a file with that name is already there.',
    'a link': `this ${tome} is a link; edit the file it points to.`,
    'too large to edit here': `this ${tome} is too large to edit here.`,
    'too large': `the text is over ${Math.round(MAX_TOME_BYTES / 1024)} KB, the most a ${tome} can hold.`,
    'not in the Library': "that path isn't inside the Library.",
    'coding agents load this name as instructions':
      "coding agents load this name as instructions, so the Library won't write it.",
  };
  return words[reason] ?? reason;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const isGone = (reason: string) => reason === 'gone' || reason === 'not in the Library';

function useWide(): boolean {
  const query = () => typeof window.matchMedia !== 'function' || window.matchMedia(WIDE).matches;
  const [wide, setWide] = useState(query);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const list = window.matchMedia(WIDE);
    const update = () => setWide(list.matches);
    list.addEventListener?.('change', update);
    return () => list.removeEventListener?.('change', update);
  }, []);
  return wide;
}

const BUTTON =
  'inline-flex items-center gap-1 rounded border border-neutral-300 px-2 py-1 text-xs font-bold hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800';
const PRIMARY =
  'inline-flex items-center gap-1 rounded bg-purple-600 px-2.5 py-1 text-xs font-bold text-white hover:bg-purple-700 disabled:opacity-50 dark:bg-purple-500 dark:text-purple-950 dark:hover:bg-purple-400';
const BANNER_BUTTON =
  'inline-flex items-center gap-1 rounded border border-amber-400 bg-white px-2 py-1 text-xs font-bold hover:bg-amber-100 dark:border-amber-700 dark:bg-amber-950 dark:hover:bg-amber-900';
const BANNER_STRONG =
  'rounded bg-amber-600 px-2 py-1 text-xs font-bold text-white hover:bg-amber-700 dark:bg-amber-500 dark:text-amber-950 dark:hover:bg-amber-400';

/** A question asked in place, as the app's other confirms are: a Yes button and a way back. */
function Ask({ question, yes, onYes, onNo }: { question: string; yes: string; onYes: () => void; onNo: () => void }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span className="font-bold">{question}</span>
      <button type="button" onClick={onYes} className={BANNER_STRONG}>
        {yes}
      </button>
      <button type="button" onClick={onNo} className={BANNER_BUTTON}>
        Keep editing
      </button>
    </span>
  );
}

/** Editing a Markdown Tome, or writing a new one. Truncated, HTML, image and link Tomes never open here. */
export function TomeEditor({ hub, node, path, tome, paths, onSaved, onClose }: TomeEditorProps) {
  const key = draftKey(node, path);
  const [openedWith] = useState(() => (tome ? lf(tome.content) : `# ${titleOf(path)}\n\n`));
  const [text, setText] = useState(openedWith);
  /** The text the file holds as far as we know; null while it isn't on disk yet. */
  const [saved, setSaved] = useState<string | null>(tome ? openedWith : null);
  const [base, setBase] = useState<TomeVersion | null>(tome?.version ?? null);
  const [crlf, setCrlf] = useState(() => /\r\n/.test(tome?.content ?? ''));
  const [disk, setDisk] = useState<Disk | null>(null);
  const [asking, setAsking] = useState<Asking>(null);
  const [showChanges, setShowChanges] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [offer, setOffer] = useState<Draft | null>(() => {
    const draft = readDraft(node, path);
    return draft && draft.text !== openedWith ? draft : null;
  });
  const [view, setView] = useState<View>('split');
  const wide = useWide();
  const shown: View = !wide && view === 'split' ? 'write' : view;
  const gutter = useRef<HTMLDivElement>(null);

  const unsaved = saved === null || text !== saved;
  const edited = text !== (saved ?? openedWith);

  // The latest of everything, for callbacks that outlive a render (the socket, the keyboard, a pending request).
  const live = useRef({ text, base, crlf, busy, alive: true, recheck: false });
  live.current = { ...live.current, text, base, crlf, busy };
  useEffect(() => {
    live.current.alive = true;
    return () => {
      live.current.alive = false;
    };
  }, []);

  /** Reads the file as it is now: the Tome, 'gone', or undefined after showing why it couldn't be read. */
  const learn = useCallback(async (): Promise<LibraryTome | 'gone' | undefined> => {
    try {
      return await readTome(node, path);
    } catch (failure) {
      const reason = message(failure);
      if (isGone(reason)) return 'gone';
      if (live.current.alive) setError(`Couldn't read the file on disk: ${plain(reason)}`);
      return undefined;
    }
  }, [node, path]);

  /** Shows the banner for what the file on disk is now, if that isn't the version the text was edited from. */
  const showDisk = useCallback((now: LibraryTome | 'gone' | undefined) => {
    if (!live.current.alive || now === undefined) return;
    if (now === 'gone') {
      // A new Tome isn't on disk yet, so its absence is no news.
      if (live.current.base !== null) setDisk({ kind: 'gone' });
      return;
    }
    if (now.version.hash === live.current.base?.hash) {
      setDisk((was) => (was?.kind === 'gone' ? null : was));
      return;
    }
    setDisk({ kind: 'changed', version: now.version, content: lf(now.content) });
  }, []);

  const check = useCallback(() => {
    if (live.current.busy) {
      live.current.recheck = true;
      return;
    }
    void learn().then(showDisk);
  }, [learn, showDisk]);

  useEffect(() => {
    const unwatch = hub.watchLibrary(node);
    const stop = hub.onLibraryChanged((frame) => {
      if (frame.node === node && (frame.all || frame.paths?.includes(path))) check();
    });
    return () => {
      unwatch();
      stop();
    };
  }, [hub, node, path, check]);

  // The draft follows the text, a moment after typing stops; while a draft is on offer, it's left alone.
  useEffect(() => {
    if (offer) return;
    const timer = setTimeout(() => {
      saveDraft(key, unsaved && edited ? JSON.stringify({ text, base } satisfies Draft) : '');
    }, DRAFT_WAIT_MS);
    return () => clearTimeout(timer);
  }, [key, text, base, unsaved, edited, offer]);

  const finish = () => {
    setDisk(null);
    setAsking(null);
    setShowChanges(false);
  };

  const write = async (over: TomeVersion | null) => {
    const { text: now, crlf: endings } = live.current;
    setBusy(true);
    live.current.busy = true;
    setError(null);
    try {
      const result = await writeTome(node, path, endings ? now.replace(/\n/g, '\r\n') : now, over);
      if (!live.current.alive) return;
      if (result.saved) {
        setBase(result.version);
        live.current.base = result.version;
        setSaved(now);
        finish();
        saveDraft(key, '');
        onSaved(result.version);
      } else {
        setAsking(null);
        setDisk({ kind: 'changed', version: result.conflict });
        showDisk(await learn());
      }
    } catch (failure) {
      if (!live.current.alive) return;
      const reason = message(failure);
      setAsking(null);
      if (reason === 'gone') setDisk({ kind: 'gone' });
      else if (reason === 'exists' && tome) showDisk(await learn());
      else setError(`Couldn't save: ${plain(reason)}`);
    } finally {
      live.current.busy = false;
      if (live.current.alive) setBusy(false);
      if (live.current.recheck) {
        live.current.recheck = false;
        check();
      }
    }
  };

  const save = () => {
    if (live.current.busy || offer) return;
    if (disk?.kind === 'gone') setAsking('recreate');
    else void write(live.current.base);
  };
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 's') {
        event.preventDefault();
        saveRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const reload = async () => {
    setAsking(null);
    let content = disk?.kind === 'changed' ? disk.content : undefined;
    let version = disk?.kind === 'changed' ? disk.version : undefined;
    let raw: string | undefined;
    if (content === undefined) {
      const now = await learn();
      if (now === 'gone') return showDisk(now);
      if (!now || !live.current.alive) return;
      raw = now.content;
      content = lf(now.content);
      version = now.version;
    }
    setText(content);
    setSaved(content);
    setBase(version ?? null);
    if (raw !== undefined) setCrlf(/\r\n/.test(raw));
    finish();
    saveDraft(key, '');
  };

  const keepMine = async () => {
    setAsking(null);
    const now = await learn();
    if (now === undefined || !live.current.alive) return;
    await write(now === 'gone' ? null : now.version);
  };

  const cancel = () => {
    if (unsaved && edited) setAsking('discard');
    else onClose();
  };
  const discard = () => {
    saveDraft(key, '');
    onClose();
  };

  const restore = (draft: Draft) => {
    setOffer(null);
    setText(draft.text);
    if (!tome) return;
    setBase(draft.base);
    if (draft.base?.hash !== tome.version.hash)
      setDisk({ kind: 'changed', version: tome.version, content: lf(tome.content) });
  };
  const forget = () => {
    setOffer(null);
    saveDraft(key, '');
  };

  const preview = useMemo<LibraryTome>(
    () => ({ path, kind: 'md', content: text, encoding: 'utf8', truncated: false, version: base ?? NO_VERSION }),
    [path, text, base],
  );
  const noOpen = useCallback(() => {}, []);
  const lines = useMemo(() => text.split('\n').length, [text]);

  if (tome && !canEdit(tome)) {
    return (
      <div role="note" className="p-4 text-sm text-neutral-600 dark:text-neutral-400">
        {tome.link
          ? `This ${w('tome')} is a link; edit the file it points to.`
          : `This ${w('tome')} can't be edited here.`}{' '}
        <button type="button" onClick={onClose} className={BUTTON}>
          Close
        </button>
      </div>
    );
  }

  const views: View[] = wide ? ['write', 'split', 'preview'] : ['write', 'preview'];
  const showWrite = shown !== 'preview';
  const showPreview = shown !== 'write';

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-neutral-200 px-4 py-2 dark:border-neutral-800">
        <span className="inline-flex min-w-0 items-center gap-1.5 text-sm">
          <span className={LIBRARY_TONE.text}>
            <Icon name="quillInk" size={16} />
          </span>
          <b>{tome ? 'Editing' : `New ${w('tome')}`}</b>
          <span className="truncate font-mono text-neutral-500">{path}</span>
          {unsaved && (
            <span className="rounded-full bg-amber-400 px-1.5 text-[10px] font-bold uppercase text-amber-950">
              unsaved
            </span>
          )}
        </span>
        <span className="flex-1" />
        <span
          role="group"
          aria-label="View"
          className="inline-flex rounded-md bg-neutral-100 p-0.5 dark:bg-neutral-800"
        >
          {views.map((one) => (
            <button
              key={one}
              type="button"
              aria-pressed={shown === one}
              onClick={() => setView(one)}
              className={`rounded px-2 py-0.5 text-xs font-bold ${shown === one ? 'bg-white shadow-sm dark:bg-neutral-700' : 'text-neutral-500'}`}
            >
              {VIEW_NAMES[one]}
            </button>
          ))}
        </span>
        {asking === 'discard' ? (
          <Ask question="Drop your changes?" yes="Yes, discard" onYes={discard} onNo={() => setAsking(null)} />
        ) : (
          <>
            <button type="button" onClick={cancel} className={BUTTON}>
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              disabled={busy || offer !== null}
              className={PRIMARY}
              aria-keyshortcuts="Control+S Meta+S"
            >
              {busy ? 'Saving…' : 'Save'}
              <kbd className="ml-1 rounded bg-white/20 px-1 font-mono text-[10px]">Ctrl S</kbd>
            </button>
          </>
        )}
      </div>

      {offer && (
        <div
          role="note"
          className="flex flex-wrap items-center gap-2 border-b border-purple-200 bg-purple-50 px-4 py-2 text-sm text-purple-950 dark:border-purple-900 dark:bg-purple-950/50 dark:text-purple-100"
        >
          <span className="min-w-0 flex-1">This device kept a draft of this {w('tome')} that was never saved.</span>
          <button type="button" onClick={() => restore(offer)} className={PRIMARY}>
            Restore draft
          </button>
          <button type="button" onClick={forget} className={BUTTON}>
            Discard draft
          </button>
        </div>
      )}

      {disk?.kind === 'changed' && (
        <div
          role="alert"
          aria-label="Changed on disk"
          className="flex flex-wrap items-center gap-3 border-b border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-100"
        >
          <span className="text-amber-600 dark:text-amber-400">
            <Icon name="markWarning" size={20} />
          </span>
          <span className="min-w-0 flex-1">
            <b>Changed on disk</b> while you were editing. Your text is kept until you choose.
          </span>
          {asking === 'reload' ? (
            <Ask
              question="Drop your edits and load the file on disk?"
              yes="Yes, reload"
              onYes={() => void reload()}
              onNo={() => setAsking(null)}
            />
          ) : asking === 'keep' ? (
            <Ask
              question="Save your text over the newer file?"
              yes="Yes, keep mine"
              onYes={() => void keepMine()}
              onNo={() => setAsking(null)}
            />
          ) : (
            <>
              <button
                type="button"
                aria-pressed={showChanges}
                onClick={() => setShowChanges((on) => !on)}
                className={BANNER_BUTTON}
              >
                Show changes
              </button>
              <button type="button" onClick={() => setAsking('reload')} disabled={busy} className={BANNER_BUTTON}>
                <Icon name="cycle" size={14} />
                Reload
              </button>
              <button type="button" onClick={() => setAsking('keep')} disabled={busy} className={BANNER_STRONG}>
                Keep mine
              </button>
            </>
          )}
        </div>
      )}

      {disk?.kind === 'gone' && (
        <div
          role="alert"
          aria-label="Removed from disk"
          className="flex flex-wrap items-center gap-3 border-b border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-100"
        >
          <span className="text-amber-600 dark:text-amber-400">
            <Icon name="markWarning" size={20} />
          </span>
          <span className="min-w-0 flex-1">
            <b>Removed from disk</b> while you were editing. Your text is kept; Save makes the file again.
          </span>
          {asking === 'recreate' && (
            <Ask
              question="Make the file again?"
              yes="Yes, make it again"
              onYes={() => void write(null)}
              onNo={() => setAsking(null)}
            />
          )}
        </div>
      )}

      {showChanges && disk?.kind === 'changed' && (
        <section
          aria-label="Changes: the file on disk (−) against your text (+)"
          className="border-b border-neutral-200 px-4 py-2 dark:border-neutral-800"
        >
          <div className="mb-1 text-xs text-neutral-500">The file on disk (−) against your text (+)</div>
          {disk.content === undefined ? (
            <p className="text-xs text-neutral-500">Reading the file on disk…</p>
          ) : (
            <Diff lines={diffLines(disk.content, text)} />
          )}
        </section>
      )}

      {error && (
        <p
          role="alert"
          className="border-b border-red-200 bg-red-50 px-4 py-1.5 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/50 dark:text-red-200"
        >
          {error}
        </p>
      )}

      <div className={`grid min-h-0 flex-1 ${showWrite && showPreview ? 'grid-cols-2' : 'grid-cols-1'}`}>
        {showWrite && (
          <div className="flex min-h-0 border-r border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-900/50">
            <div
              ref={gutter}
              data-gutter
              aria-hidden="true"
              className="shrink-0 overflow-hidden py-2 pr-2 pl-3 text-right font-mono text-[13px] leading-6 text-neutral-400 select-none"
            >
              {Array.from({ length: lines }, (_, i) => (
                <div key={i}>{i + 1}</div>
              ))}
            </div>
            <textarea
              aria-label={`Markdown of ${path}`}
              value={text}
              onChange={(event) => setText(event.target.value)}
              onScroll={(event) => {
                if (gutter.current) gutter.current.scrollTop = event.currentTarget.scrollTop;
              }}
              readOnly={offer !== null}
              spellCheck
              wrap="off"
              className="min-h-[60vh] flex-1 resize-none bg-transparent py-2 pr-3 font-mono text-[13px] leading-6 whitespace-pre text-neutral-900 outline-none dark:text-neutral-100"
            />
          </div>
        )}
        {showPreview && (
          <div className="min-h-0 overflow-auto px-6 py-4">
            <div className="mb-2 inline-flex items-center gap-1 text-[11px] font-bold tracking-wide text-neutral-400 uppercase">
              <Icon name="markEye" size={14} />
              Preview
            </div>
            <TomeReader node={node} tome={preview} paths={paths} onOpen={noOpen} />
          </div>
        )}
      </div>
    </div>
  );
}

/** A Tome's title from its file name: no folder, no `.md`. */
function titleOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '');
}

// ---------- New Tome ----------

/** The names coding agents load as instructions; the Library never makes one (docs/LIBRARY.md). */
const RESERVED = new Set(['claude.md', 'agents.md']);

/** Where a new Tome named `name` goes in `folder` ('' for the Library's top), with `.md` added if it lacks one. */
export function newTomePath(folder: string, name: string): string {
  const trimmed = name.trim();
  const file = /\.md$/i.test(trimmed) ? trimmed : `${trimmed}.md`;
  return folder ? `${folder}/${file}` : file;
}

/** Why a new Tome can't have this name, before anything is sent; undefined when it can (or nothing is typed yet). */
export function newTomeProblem(folder: string, name: string, paths: readonly string[]): string | undefined {
  const trimmed = name.trim();
  if (!trimmed) return undefined;
  const path = newTomePath(folder, trimmed);
  const file = path.slice(path.lastIndexOf('/') + 1);
  if (RESERVED.has(file.toLowerCase()))
    return 'Not that name: coding agents load CLAUDE.md and AGENTS.md as instructions, and a Library can be a project folder.';
  if (trimmed.startsWith('.')) return "A name can't start with a dot.";
  if (/[/\\:]/.test(trimmed)) return "A name can't hold /, \\ or :.";
  const lower = path.toLowerCase();
  if (paths.some((one) => one.toLowerCase() === lower)) return `There's already a ${w('tome')} with that name here.`;
  return undefined;
}

export interface NewTomeProps {
  hub: LibraryHub;
  node: string;
  /** The folder it goes in: the open folder, or for a missing wiki link the linking Tome's folder ('' at the top). */
  folder: string;
  /** A name to start from, such as a missing wiki link's target. */
  name?: string;
  /** Every file path in the listing. */
  paths: readonly string[];
  /** The new Tome was made at `path`, at this version. */
  onSaved: (path: string, version: TomeVersion) => void;
  onClose: () => void;
}

/** New Tome: a name in the folder, its full path shown, then the editor; the first save makes the file. */
export function NewTome({ hub, node, folder, name: initial = '', paths, onSaved, onClose }: NewTomeProps) {
  const [name, setName] = useState(initial);
  const [path, setPath] = useState<string | null>(null);
  const problem = newTomeProblem(folder, name, paths);

  if (path) {
    return (
      <TomeEditor
        hub={hub}
        node={node}
        path={path}
        paths={paths}
        onSaved={(version) => onSaved(path, version)}
        onClose={onClose}
      />
    );
  }

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() && !problem) setPath(newTomePath(folder, name));
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-2 p-4 text-sm">
      <label className="flex flex-col gap-1">
        <span className="font-bold">New {w('tome')}: Name</span>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          autoFocus
          className="rounded border border-neutral-300 bg-white px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900"
        />
      </label>
      {name.trim() && (
        <p className="text-neutral-500">
          Makes <code className="font-mono text-neutral-800 dark:text-neutral-200">{newTomePath(folder, name)}</code>
        </p>
      )}
      {problem && (
        <p role="alert" className="text-red-700 dark:text-red-300">
          {problem}
        </p>
      )}
      <div className="flex gap-2">
        <button type="submit" disabled={!name.trim() || problem !== undefined} className={PRIMARY}>
          <Icon name="quillInk" size={14} />
          Write it
        </button>
        <button type="button" onClick={onClose} className={BUTTON}>
          Cancel
        </button>
      </div>
    </form>
  );
}
