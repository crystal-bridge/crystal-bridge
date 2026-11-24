/**
 * The Library tab's reading room (docs/LIBRARY.md, "Walk the aisles: in the app"): quick-open, Recent and the folder
 * as a tree on the left, the open Tome in the middle (or its editor, in place), and its outline and the Tomes that link
 * to it on a narrow rail. On a phone it reads only: the tree in a drawer, the Tome, then the outline and backlinks.
 * Also the Castle's Library card. Nothing here raises a notification, and nothing shows outside these two places.
 */
import { type LibraryBacklink, type LibraryEntry, type LibraryTome, parseWikiLink } from '@crystal-bridge/protocol';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { shortWhen } from '../format.js';
import { isMac } from '../hotkeys.js';
import {
  backlinks,
  LIBRARY_TONE,
  type LibraryHub,
  latestTomes,
  quickOpen,
  readTome,
  recentTomes,
  rememberTome,
  tomeFileUrl,
  useLibrary,
} from '../library.js';
import { formatRoute } from '../route.js';
import { Icon, type IconName } from '../theme/icons.js';
import { hint, libraryLine, w } from '../theme/words.js';
import { NewTome, TomeEditor } from './TomeEditor.js';
import { canEdit, outlineOf, TomeReader } from './TomeReader.js';

const OFFLINE = 'that Kingdom is offline';
const isGone = (reason: string) => reason === 'gone' || reason === 'not in the Library';
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const folderOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
/** A file's name as the tree shows it: a Markdown or HTML Tome without its extension, an image as it is. */
const titleOf = (path: string) => nameOf(path).replace(/\.(?:md|html?)$/i, '');
const kindOf = (path: string): LibraryEntry['kind'] =>
  /\.md$/i.test(path) ? 'md' : /\.html?$/i.test(path) ? 'html' : 'image';

/** How long ago, short: "now", "12m", "2h", "yesterday", or the date. */
function ago(at: number, now: number): string {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h`;
  if (minutes < 48 * 60) return 'yesterday';
  return shortWhen(at, now);
}

/** A phone gets the read-only room: Tailwind's md, as the rest of the app splits it. */
function useWide(): boolean {
  const WIDE = '(min-width: 768px)';
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

// Each top-level folder gets a hue of its own, so the shelves scan apart. Spelled out whole for the stylesheet build;
// no blue, which means "needs you".
const FOLDER_TONES = [
  {
    icon: 'text-orange-600 dark:text-orange-400',
    chip: 'bg-orange-100 text-orange-900 dark:bg-orange-950 dark:text-orange-200',
  },
  {
    icon: 'text-emerald-600 dark:text-emerald-400',
    chip: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200',
  },
  { icon: 'text-pink-600 dark:text-pink-400', chip: 'bg-pink-100 text-pink-900 dark:bg-pink-950 dark:text-pink-200' },
  { icon: 'text-lime-600 dark:text-lime-400', chip: 'bg-lime-100 text-lime-900 dark:bg-lime-950 dark:text-lime-200' },
  {
    icon: 'text-amber-600 dark:text-amber-400',
    chip: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
  },
  { icon: 'text-teal-600 dark:text-teal-400', chip: 'bg-teal-100 text-teal-900 dark:bg-teal-950 dark:text-teal-200' },
  { icon: 'text-rose-600 dark:text-rose-400', chip: 'bg-rose-100 text-rose-900 dark:bg-rose-950 dark:text-rose-200' },
  {
    icon: 'text-fuchsia-600 dark:text-fuchsia-400',
    chip: 'bg-fuchsia-100 text-fuchsia-900 dark:bg-fuchsia-950 dark:text-fuchsia-200',
  },
] as const;
const TOP_TONE = {
  icon: 'text-stone-500 dark:text-stone-400',
  chip: 'bg-stone-200 text-stone-800 dark:bg-stone-800 dark:text-stone-200',
};

type Tone = { icon: string; chip: string };

/** A file's tone, by its top-level folder; a file at the top is stone. */
function hashTone(path: string): Tone {
  if (!path.includes('/')) return TOP_TONE;
  let hash = 0;
  for (const char of path.split('/')[0]!) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return FOLDER_TONES[hash % FOLDER_TONES.length]!;
}

/** Tones by the top-level folders' order, so the first eight never share a hue; past those, by name. */
function tonesFor(root: Folder): (path: string) => Tone {
  const order = new Map(root.folders.map((folder, index) => [folder.path, index]));
  return (path) => {
    if (!path.includes('/')) return TOP_TONE;
    const at = order.get(path.split('/')[0]!);
    return at !== undefined && at < FOLDER_TONES.length ? FOLDER_TONES[at]! : hashTone(path);
  };
}

const ToneContext = createContext<(path: string) => Tone>(hashTone);

const SELECTED = 'bg-purple-100 font-bold text-purple-900 dark:bg-purple-900/60 dark:text-purple-100';
const HOVER = 'hover:bg-neutral-100 dark:hover:bg-neutral-900';
const BUTTON =
  'inline-flex items-center gap-1 rounded border border-neutral-300 px-2 py-1 text-xs font-bold hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800';
const PRIMARY =
  'inline-flex items-center gap-1 rounded bg-purple-600 px-2.5 py-1 text-xs font-bold text-white hover:bg-purple-700 dark:bg-purple-500 dark:text-purple-950 dark:hover:bg-purple-400';
const TILE =
  'grid shrink-0 place-items-center rounded-md bg-purple-100 text-purple-700 ring-1 ring-purple-300 dark:bg-purple-950 dark:text-purple-300 dark:ring-purple-800';

/** A file's icon in its kind's colour: pink for an HTML page, green for an image, grey for Markdown. */
function FileIcon({ path, size = 14 }: { path: string; size?: number }) {
  const kind = kindOf(path);
  const [name, colour]: [IconName, string] =
    kind === 'html'
      ? ['htmlTome', 'text-pink-600 dark:text-pink-400']
      : kind === 'image'
        ? ['markEye', 'text-emerald-600 dark:text-emerald-400']
        : ['tome', 'text-neutral-400 dark:text-neutral-500'];
  return (
    <span aria-hidden="true" className={`shrink-0 ${colour}`}>
      <Icon name={name} size={size} />
    </span>
  );
}

function HtmlMark() {
  return <span className="font-mono text-[10px] text-pink-600 dark:text-pink-400">html</span>;
}

function RailHead({ icon, children }: { icon: IconName; children: ReactNode }) {
  return (
    <h3 className="mb-1.5 flex items-center gap-1.5 text-[11px] font-bold tracking-wide text-neutral-500 uppercase">
      <Icon name={icon} size={14} />
      {children}
    </h3>
  );
}

// ---------- quick-open ----------

/** Find a Tome by name (`quickOpen`): arrows move, Enter opens, Esc clears. */
function QuickOpen({
  entries,
  onOpen,
  inputRef,
  hotkey = false,
  wide = true,
}: {
  entries: readonly LibraryEntry[];
  onOpen: (path: string) => void;
  inputRef?: React.RefObject<HTMLInputElement | null>;
  /** Shows the Ctrl/Cmd+K hint, where that key reaches it. */
  hotkey?: boolean;
  wide?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [at, setAt] = useState(0);
  const list = useId();
  const results = useMemo(() => quickOpen(entries, query).slice(0, 8), [entries, query]);
  const choose = (path: string) => {
    setQuery('');
    setAt(0);
    onOpen(path);
  };
  const onKey = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setAt((now) => Math.min(now + 1, results.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setAt((now) => Math.max(now - 1, 0));
    } else if (event.key === 'Enter') {
      const chosen = results[at] ?? results[0];
      if (chosen) {
        event.preventDefault();
        choose(chosen.path);
      }
    } else if (event.key === 'Escape' && query) {
      event.stopPropagation();
      setQuery('');
    }
  };
  const open = results.length > 0;
  const kbd =
    'rounded border border-neutral-300 bg-white px-1 font-mono text-[10px] leading-4 font-bold text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900';
  return (
    <div className={`relative ${wide ? 'w-full' : 'min-w-0 flex-1'}`}>
      <label className="flex items-center gap-2 rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm focus-within:border-purple-400 focus-within:ring-1 focus-within:ring-purple-300 dark:border-neutral-700 dark:bg-neutral-950 dark:focus-within:border-purple-600 dark:focus-within:ring-purple-800">
        <span aria-hidden="true" className="text-neutral-400">
          <Icon name="magnifyingGlass" size={16} />
        </span>
        <input
          ref={inputRef}
          role="combobox"
          aria-label={`Find a ${w('tome')}`}
          aria-expanded={open}
          aria-controls={list}
          aria-autocomplete="list"
          placeholder={`Find a ${w('tome')}…`}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setAt(0);
          }}
          onKeyDown={onKey}
          className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-neutral-400"
        />
        {hotkey && !query && (
          <span aria-hidden="true" className="hidden gap-0.5 lg:inline-flex">
            <kbd className={kbd}>{isMac() ? '⌘' : 'Ctrl'}</kbd>
            <kbd className={kbd}>K</kbd>
          </span>
        )}
      </label>
      {open && (
        <ul
          id={list}
          role="listbox"
          aria-label={`${w('tomes')} found`}
          className="absolute inset-x-0 top-full z-20 mt-1 max-h-80 overflow-auto rounded-md border border-neutral-200 bg-white p-1 text-sm shadow-lg dark:border-neutral-800 dark:bg-neutral-950"
        >
          {results.map((entry, index) => (
            <li
              key={entry.path}
              role="option"
              aria-selected={index === at}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(entry.path)}
              onMouseEnter={() => setAt(index)}
              className={`flex cursor-pointer items-center gap-2 rounded px-2 py-1 ${index === at ? SELECTED : HOVER}`}
            >
              <FileIcon path={entry.path} />
              <span className="min-w-0 flex-1 truncate">{titleOf(entry.path)}</span>
              <span className="truncate font-mono text-[11px] text-neutral-500 dark:text-neutral-400">
                {folderOf(entry.path)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------- the tree ----------

interface Folder {
  path: string;
  folders: Folder[];
  files: LibraryEntry[];
}

/** The listing as nested folders, folders before files, each in the listing's (sorted) order. */
function treeOf(entries: readonly LibraryEntry[]): Folder {
  const root: Folder = { path: '', folders: [], files: [] };
  const folders = new Map<string, Folder>([['', root]]);
  const folderFor = (path: string): Folder => {
    let folder = folders.get(path);
    if (!folder) {
      folder = { path, folders: [], files: [] };
      folders.set(path, folder);
      folderFor(folderOf(path)).folders.push(folder);
    }
    return folder;
  };
  for (const entry of entries) {
    if (entry.kind === 'folder') folderFor(entry.path);
    else folderFor(folderOf(entry.path)).files.push(entry);
  }
  return root;
}

function Tree({
  root,
  open,
  onOpen,
  expanded,
  onToggle,
  tap = false,
}: {
  root: Folder;
  /** The open Tome. */
  open: string | undefined;
  onOpen: (path: string) => void;
  expanded: (folder: string) => boolean;
  onToggle: (folder: string) => void;
  /** Full-width rows big enough to tap, on a phone. */
  tap?: boolean;
}) {
  const toneOf = useContext(ToneContext);
  const row = tap ? 'py-2' : 'py-1';
  const files = (folder: Folder) =>
    folder.files.map((entry) => (
      <li key={entry.path} role="none">
        <button
          type="button"
          role="treeitem"
          aria-selected={entry.path === open}
          onClick={() => onOpen(entry.path)}
          title={entry.path}
          className={`flex w-full items-center gap-1.5 rounded px-1.5 text-left ${row} ${entry.path === open ? SELECTED : `text-neutral-700 dark:text-neutral-300 ${HOVER}`}`}
        >
          <FileIcon path={entry.path} />
          <span className="min-w-0 flex-1 truncate">
            {entry.kind === 'image' ? nameOf(entry.path) : titleOf(entry.path)}
          </span>
          {entry.kind === 'html' && <HtmlMark />}
        </button>
      </li>
    ));
  const folders = (parent: Folder): ReactNode =>
    parent.folders.map((folder) => {
      const on = expanded(folder.path);
      const name = nameOf(folder.path);
      return (
        <li key={folder.path} role="treeitem" aria-label={name} aria-expanded={on}>
          <button
            type="button"
            onClick={() => onToggle(folder.path)}
            className={`flex w-full items-center gap-1.5 rounded px-1.5 text-left font-bold ${row} ${HOVER}`}
          >
            <span aria-hidden="true" className={`text-neutral-400 transition-transform ${on ? 'rotate-90' : ''}`}>
              <Icon name="caret" size={10} />
            </span>
            <span aria-hidden="true" className={toneOf(`${folder.path}/x`).icon}>
              <Icon name="libraryFolder" size={16} />
            </span>
            <span className="min-w-0 flex-1 truncate">{name}</span>
            <span className="text-[11px] font-normal text-neutral-500 dark:text-neutral-400">
              {folder.folders.length + folder.files.length}
            </span>
          </button>
          {on && (
            <ul role="group" className="ml-3.5 border-l border-neutral-200 pl-1.5 dark:border-neutral-800">
              {folders(folder)}
              {files(folder)}
            </ul>
          )}
        </li>
      );
    });
  return (
    <ul role="tree" aria-label={w('tomes')} className="space-y-0.5 text-sm">
      {folders(root)}
      {files(root)}
    </ul>
  );
}

function Recent({
  paths,
  open,
  onOpen,
  tap = false,
}: {
  paths: readonly string[];
  open: string | undefined;
  onOpen: (path: string) => void;
  tap?: boolean;
}) {
  if (paths.length === 0) return null;
  return (
    <section aria-label="Recent">
      <RailHead icon="markClock">Recent</RailHead>
      <ul className="space-y-0.5 text-sm">
        {paths.map((path) => (
          <li key={path}>
            <button
              type="button"
              onClick={() => onOpen(path)}
              title={path}
              className={`flex w-full items-center gap-2 rounded px-1.5 text-left ${tap ? 'py-2' : 'py-1'} ${path === open ? SELECTED : HOVER}`}
            >
              <FileIcon path={path} />
              <span className="min-w-0 flex-1 truncate">{titleOf(path)}</span>
              {folderOf(path) && (
                <span className="truncate text-[11px] text-neutral-500 dark:text-neutral-400">{folderOf(path)}</span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------- cards for the states ----------

function StateCard({
  icon,
  tone,
  title,
  children,
}: {
  icon: ReactNode;
  tone: 'purple' | 'grey' | 'amber';
  title: string;
  children?: ReactNode;
}) {
  const box =
    tone === 'purple'
      ? 'border-2 border-dashed border-purple-300 dark:border-purple-800'
      : tone === 'amber'
        ? 'border border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/40'
        : 'border border-neutral-300 bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900';
  return (
    <div className="grid place-items-center px-6 py-14">
      <div className={`flex max-w-xl flex-col items-center gap-3 rounded-xl px-8 py-10 text-center ${box}`}>
        {icon}
        <p className="cb-display text-3xl leading-none">{title}</p>
        {children}
      </div>
    </div>
  );
}

const shelfIcon = (closed = false) => (
  <span
    className={`relative grid size-16 place-items-center rounded-full ${closed ? 'bg-neutral-200 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400' : 'bg-purple-50 text-purple-500 dark:bg-purple-950 dark:text-purple-300'}`}
  >
    <Icon name="library" size={40} />
    {closed && (
      <span className="absolute -right-1 -bottom-1 grid size-7 place-items-center rounded-full bg-white text-neutral-600 ring-2 ring-neutral-300 dark:bg-neutral-950 dark:text-neutral-300 dark:ring-neutral-700">
        <Icon name="padlock" size={14} />
      </span>
    )}
  </span>
);

const closedLine = (kingdom: string) => `The ${w('library')} is closed: ${kingdom} is offline.`;

function ClosedCard({ kingdom }: { kingdom: string }) {
  return (
    <StateCard icon={shelfIcon(true)} tone="grey" title={closedLine(kingdom)}>
      <p className="text-sm text-neutral-600 dark:text-neutral-400">
        The {w('tomes')} live on the {w('kingdom')}'s disk, so they open again when it reconnects. The hub keeps no copy
        to show while it's away.
      </p>
    </StateCard>
  );
}

// ---------- the room ----------

export interface LibraryRoomProps {
  hub: LibraryHub;
  /** The Kingdom whose Library this is, and its name as shown. */
  node: string;
  kingdom: string;
  /** The Kingdom is connected; offline, the room shows what it has, read-only, under a banner. */
  online: boolean;
  /** The Library's folder on the Kingdom, as its hello said. */
  dir?: string | undefined;
  /** The route's path: a Tome, a folder, or nothing for the Library's top. */
  path?: string | undefined;
  /** Goes to a path in the Library (a new history entry), or its top. */
  onPath: (path: string | undefined) => void;
}

interface Read {
  path: string;
  tome?: LibraryTome;
  /** Why the last read failed; the Tome read before it stays. */
  error?: string;
  gone?: boolean;
}

export function LibraryRoom({ hub, node, kingdom, online, dir, path, onPath }: LibraryRoomProps) {
  const wide = useWide();
  const listing = useLibrary(hub, node);
  const offline = !online || listing.error === OFFLINE;
  const files = useMemo(() => listing.entries.filter((entry) => entry.kind !== 'folder'), [listing.entries]);
  const paths = useMemo(() => files.map((entry) => entry.path), [files]);
  const folders = useMemo(
    () => new Set(listing.entries.filter((entry) => entry.kind === 'folder').map((entry) => entry.path)),
    [listing.entries],
  );
  const tomeCount = files.filter((entry) => entry.kind !== 'image').length;
  const root = useMemo(() => treeOf(listing.entries), [listing.entries]);
  const toneOf = useMemo(() => tonesFor(root), [root]);

  const isFolder = path !== undefined && folders.has(path);
  const tomePath = path !== undefined && !isFolder ? path : undefined;
  const openFolder = isFolder ? path : tomePath ? folderOf(tomePath) : '';

  const [read, setRead] = useState<Read | null>(null);
  const [tick, setTick] = useState(0);
  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState<{ folder: string; name?: string } | null>(null);
  const [linked, setLinked] = useState<LibraryBacklink[] | undefined>(undefined);
  const [recent, setRecent] = useState(() => recentTomes(node));
  /** The heading a `[[Tome#Heading]]` link asked for, with the Tome it's in; let go once the reader scrolls there. */
  const [heading, setHeading] = useState<{ path: string; at: string } | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(new Map());
  const find = useRef<HTMLInputElement>(null);
  const editingNow = useRef(false);
  editingNow.current = editing;

  // Leaving a Tome leaves its editor, and its heading.
  useEffect(() => {
    setEditing(false);
    setCreating(null);
    setDrawer(false);
    setHeading((asked) => (asked?.path === path ? asked : null));
  }, [node, path]);

  // A route path is known to be a file, not a folder, only once the listing is in.
  const filePath = listing.loading ? undefined : tomePath;

  // Opening a Tome puts it first among Recent.
  useEffect(() => {
    if (!filePath) return;
    rememberTome(node, filePath);
    setRecent(recentTomes(node));
  }, [node, filePath]);

  useEffect(() => {
    if (!tomePath || kindOf(tomePath) === 'image') {
      setRead(tomePath ? { path: tomePath } : null);
      return;
    }
    let live = true;
    setRead((now) => (now?.path === tomePath ? now : { path: tomePath }));
    readTome(node, tomePath).then(
      (tome) => {
        if (live) setRead({ path: tomePath, tome });
      },
      (error: unknown) => {
        if (!live) return;
        const reason = message(error);
        setRead((now) => {
          const kept = now?.path === tomePath ? now.tome : undefined;
          return { path: tomePath, ...(kept ? { tome: kept } : {}), error: reason, gone: isGone(reason) };
        });
      },
    );
    return () => {
      live = false;
    };
  }, [node, tomePath, tick]);

  useEffect(() => {
    setLinked(undefined);
    if (!filePath) return;
    let live = true;
    backlinks(node, filePath).then(
      (found) => {
        if (live) setLinked(found);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [node, filePath, tick]);

  // A change to the open Tome on disk reads it again; the editor watches for itself while it's open.
  useEffect(
    () =>
      hub.onLibraryChanged((frame) => {
        if (frame.node !== node || !tomePath || editingNow.current) return;
        if (frame.all || frame.paths?.includes(tomePath)) setTick((now) => now + 1);
      }),
    [hub, node, tomePath],
  );

  // Back online: read the open Tome again.
  const wasOnline = useRef(online);
  useEffect(() => {
    if (online && !wasOnline.current) setTick((now) => now + 1);
    wasOnline.current = online;
  }, [online]);

  // Ctrl+K (Cmd+K on a Mac) finds a Tome while the Library shows.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'k')
        return;
      event.preventDefault();
      if (!wide) setDrawer(true);
      // The drawer's box mounts with this render.
      setTimeout(() => find.current?.focus(), 0);
      find.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [wide]);

  const openTome = useCallback(
    (next: string, at?: string) => {
      setHeading(at ? { path: next, at } : null);
      setDrawer(false);
      if (next !== path) onPath(next);
    },
    [onPath, path],
  );

  const letHeadingGo = useCallback(() => setHeading(null), []);

  const ancestors = useMemo(() => {
    const set = new Set<string>();
    let at = openFolder;
    while (at) {
      set.add(at);
      at = folderOf(at);
    }
    return set;
  }, [openFolder]);
  const small = listing.entries.length <= 60;
  const expanded = (folder: string) =>
    toggled.get(folder) ?? (ancestors.has(folder) || (small && !folder.includes('/')));
  const toggle = (folder: string) => setToggled((now) => new Map(now).set(folder, !expanded(folder)));

  const shownRecent = useMemo(
    () => (listing.loading ? [] : recent.filter((one) => paths.includes(one)).slice(0, 5)),
    [recent, paths, listing.loading],
  );

  const tome = read?.path === tomePath ? read?.tome : undefined;
  const gone = read?.path === tomePath && read?.gone === true;
  const writable = wide && !offline;
  const missing = useCallback(
    (target: string) => setCreating({ folder: tomePath ? folderOf(tomePath) : openFolder, name: target }),
    [tomePath, openFolder],
  );
  const outline = useMemo(() => (tome?.kind === 'md' ? outlineOf(tome.content) : []), [tome]);

  const copyLink = () =>
    navigator.clipboard
      ?.writeText(
        `${window.location.origin}${window.location.pathname}${formatRoute(tomePath ? { page: 'library', node, path: tomePath } : { page: 'library', node })}`,
      )
      .catch(() => {});

  const newTomeButton = writable && listing.entries.length > 0 && (
    <button
      type="button"
      onClick={() => setCreating({ folder: openFolder })}
      title={`New ${w('tome')} in ${openFolder || `the ${w('library')}'s top folder`}`}
      aria-label={`New ${w('tome')}`}
      className={`ml-auto inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[11px] font-bold tracking-normal normal-case hover:bg-purple-100 dark:hover:bg-purple-950 ${LIBRARY_TONE.text}`}
    >
      <Icon name="quillInk" size={14} />
      New
    </button>
  );

  const left = (tap: boolean) => (
    <>
      <QuickOpen entries={listing.entries} onOpen={openTome} inputRef={find} hotkey={!tap} />
      <Recent paths={shownRecent} open={tomePath} onOpen={openTome} tap={tap} />
      <section aria-label={`${w('tomes')}: the folder`}>
        <RailHead icon="library">
          {w('tomes')}
          {!tap && newTomeButton}
        </RailHead>
        <Tree root={root} open={tomePath} onOpen={openTome} expanded={expanded} onToggle={toggle} tap={tap} />
        {listing.truncated && (
          <p className="mt-2 text-[11px] text-neutral-500">
            The listing stops at 10,000 entries; find the rest by name.
          </p>
        )}
      </section>
    </>
  );

  // ----- the middle -----
  let main: ReactNode;
  if (creating && writable) {
    main = (
      <NewTome
        hub={hub}
        node={node}
        paths={paths}
        folder={creating.folder}
        {...(creating.name !== undefined ? { name: creating.name } : {})}
        onSaved={(made) => {
          setCreating(null);
          onPath(made);
        }}
        onClose={() => setCreating(null)}
      />
    );
  } else if (editing && tome && writable && tomePath) {
    main = (
      <TomeEditor
        hub={hub}
        node={node}
        path={tomePath}
        tome={tome}
        paths={paths}
        onSaved={() => {}}
        onClose={() => {
          setEditing(false);
          setTick((now) => now + 1);
        }}
      />
    );
  } else if (tomePath) {
    const image = kindOf(tomePath) === 'image';
    const failed = read?.path === tomePath && read.error && !tome;
    main = (
      <>
        <TomeBar
          path={tomePath}
          when={tome?.version.mtimeMs}
          onPath={onPath}
          onCopy={copyLink}
          onEdit={writable && tome && canEdit(tome) && !gone ? () => setEditing(true) : undefined}
          phone={!wide}
        />
        {offline && (tome || image) && <Banner tone="grey" icon="padlock" text={closedLine(kingdom)} />}
        {gone && tome && (
          <Banner tone="rose" icon="markWarning" text={`This ${w('tome')} is gone from the ${w('library')}.`} />
        )}
        {image ? (
          <div className="p-4">
            <img
              src={tomeFileUrl(node, tomePath)}
              alt={nameOf(tomePath)}
              className="mx-auto max-w-full rounded-md ring-1 ring-neutral-200 dark:ring-neutral-800"
            />
          </div>
        ) : tome ? (
          <div className={wide ? 'px-8 py-5' : 'px-4 py-3'}>
            <div className="mx-auto max-w-3xl">
              <TomeReader
                node={node}
                tome={tome}
                paths={paths}
                onOpen={openTome}
                {...(writable && !gone ? { onMissing: missing } : {})}
                {...(heading?.path === tomePath ? { heading: heading.at, onHeading: letHeadingGo } : {})}
              />
            </div>
          </div>
        ) : failed && offline ? (
          <ClosedCard kingdom={kingdom} />
        ) : failed ? (
          <StateCard
            icon={shelfIcon()}
            tone="amber"
            title={read.gone ? `No ${w('tome')} here` : `Can't open this ${w('tome')}`}
          >
            <p className="text-sm text-neutral-600 dark:text-neutral-400">
              {read.gone ? `Nothing in the ${w('library')} is at ${tomePath}.` : read.error}
            </p>
          </StateCard>
        ) : (
          <p className="p-6 text-sm text-neutral-500">Opening…</p>
        )}
      </>
    );
  } else if (offline) {
    main = <ClosedCard kingdom={kingdom} />;
  } else if (listing.loading) {
    main = <p className="p-6 text-sm text-neutral-500">Opening the {w('library')}…</p>;
  } else if (listing.error) {
    main = (
      <StateCard icon={shelfIcon()} tone="amber" title={`The ${w('library')} can't be read`}>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          {kingdom} says: {listing.error}.
        </p>
        {dir && (
          <p className="text-[12px] text-neutral-500">
            Its folder is <code className="font-mono">{dir}</code>. Check it's there and Crystal can read it.
          </p>
        )}
      </StateCard>
    );
  } else if (listing.entries.length === 0) {
    main = (
      <StateCard icon={shelfIcon()} tone="purple" title={`The ${w('library')} is still empty`}>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Put Markdown or HTML files in its folder on {kingdom} and they open here. An Obsidian vault or a git
          repository works as it is.
        </p>
        {dir && (
          <code className="rounded border border-neutral-200 bg-neutral-50 px-2 py-1 font-mono text-sm dark:border-neutral-800 dark:bg-neutral-900">
            {dir}
          </code>
        )}
        <p className="text-[12px] text-neutral-500">
          To use another folder, set <code className="font-mono">CRYSTAL_LIBRARY_DIR</code> in Crystal's environment on{' '}
          {kingdom} and restart Crystal there.
        </p>
        {writable && (
          <button type="button" onClick={() => setCreating({ folder: '' })} className={PRIMARY}>
            <Icon name="quillInk" size={14} />
            New {w('tome')}
          </button>
        )}
      </StateCard>
    );
  } else {
    main = <FolderView root={root} folder={openFolder} onOpen={openTome} onPath={onPath} entries={listing.entries} />;
  }

  // ----- the rail: outline and backlinks -----
  const outlineList = tome && outline.length > 0 && (
    <section aria-label="Outline">
      <RailHead icon="scrollUnfurled">Outline</RailHead>
      <ul className="space-y-0.5 border-l-2 border-neutral-200 text-[13px] dark:border-neutral-800">
        {outline.map((entry) => (
          <li key={entry.id}>
            <button
              type="button"
              onClick={() =>
                document.getElementById(entry.id)?.scrollIntoView?.({ block: 'start', behavior: 'smooth' })
              }
              style={{ paddingLeft: `${0.5 + (Math.min(entry.depth, 4) - 1) * 0.75}rem` }}
              className={`-ml-0.5 block w-full border-l-2 border-transparent py-0.5 text-left hover:border-purple-400 hover:text-purple-700 dark:hover:text-purple-300 ${entry.depth === 1 ? 'font-bold text-neutral-800 dark:text-neutral-200' : 'text-neutral-600 dark:text-neutral-400'}`}
            >
              {entry.text || '…'}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
  const linkedList = tomePath && (tome || kindOf(tomePath) === 'image') && linked !== undefined && (
    <section aria-label={`Linked from · ${linked.length}`}>
      <RailHead icon="deedLink">Linked from · {linked.length}</RailHead>
      {linked.length === 0 ? (
        <p className="text-[12px] text-neutral-500">No {w('tome')} links here yet.</p>
      ) : (
        <ul className="space-y-2">
          {linked.map((link) => {
            const tone = toneOf(link.path);
            return (
              <li key={link.path}>
                <button
                  type="button"
                  onClick={() => openTome(link.path)}
                  title={link.path}
                  className="block w-full rounded-md border border-neutral-200 p-2 text-left hover:border-purple-300 hover:bg-purple-50/50 dark:border-neutral-800 dark:hover:border-purple-800 dark:hover:bg-purple-950/30"
                >
                  <span className="flex items-center gap-1.5 text-[13px] font-bold">
                    <span aria-hidden="true" className={tone.icon}>
                      <Icon name="tome" size={14} />
                    </span>
                    <span className="min-w-0 truncate">{titleOf(link.path)}</span>
                    {folderOf(link.path) && (
                      <span className={`ml-auto shrink-0 rounded px-1 text-[10px] font-normal ${tone.chip}`}>
                        {nameOf(folderOf(link.path))}
                      </span>
                    )}
                  </span>
                  <span className="mt-1 line-clamp-3 block text-[12px] leading-snug text-neutral-500">
                    <LinkLine line={link.line} />
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
  const rail = (outlineList || linkedList) && !editing && !creating && (
    <>
      {outlineList}
      {linkedList}
    </>
  );

  const header = (
    <div className="flex flex-wrap items-center gap-2 border-b border-neutral-200 bg-linear-to-r from-purple-50 via-white to-white px-4 py-2 dark:border-neutral-800 dark:from-purple-950/60 dark:via-neutral-950 dark:to-neutral-950">
      <span className={`${TILE} size-7`} aria-hidden="true">
        <Icon name="library" size={20} />
      </span>
      <h1 className="cb-display text-2xl leading-none" title={hint('library')}>
        {w('library')}
      </h1>
      <span className="text-sm text-purple-800 italic dark:text-purple-300" title={libraryLine(kingdom).plain}>
        {libraryLine(kingdom).themed}
      </span>
      <span className="flex-1" />
      {dir && (
        <span className="inline-flex min-w-0 items-center gap-1 font-mono text-[11px] text-neutral-500">
          <span aria-hidden="true">
            <Icon name="libraryFolder" size={14} />
          </span>
          <span className="truncate">{dir}</span>
          {!listing.loading && !listing.error && (
            <>
              <span aria-hidden="true">·</span>
              <span>{`${tomeCount} ${tomeCount === 1 ? w('tome') : w('tomes')}`}</span>
            </>
          )}
        </span>
      )}
    </div>
  );

  if (!wide) {
    return (
      <ToneContext.Provider value={toneOf}>
        <div className="relative h-full overflow-y-auto">
          <div className="flex items-center gap-2 border-b border-neutral-200 bg-linear-to-r from-purple-50 to-white px-3 py-2 dark:border-neutral-800 dark:from-purple-950/60 dark:to-neutral-950">
            <button
              type="button"
              onClick={() => setDrawer(true)}
              title={`Browse the ${w('library')}`}
              className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-md border border-neutral-300 px-2.5 text-sm font-bold dark:border-neutral-700"
            >
              <span aria-hidden="true">
                <Icon name="drawerList" size={18} />
              </span>
              {w('tomes')}
            </button>
            <div className="min-w-0 flex-1">
              <div className={`flex items-center gap-1 text-[11px] text-neutral-500`}>
                <span className={LIBRARY_TONE.text}>{w('library')}</span>
                {openFolder && <span className="truncate">· {openFolder}</span>}
              </div>
              <div className="truncate text-sm font-bold">{tomePath ? titleOf(tomePath) : kingdom}</div>
            </div>
          </div>
          {main}
          {rail && (
            <div className="space-y-5 border-t border-neutral-200 px-4 py-4 dark:border-neutral-800">{rail}</div>
          )}
          {drawer && (
            <>
              <div
                aria-hidden="true"
                className="fixed inset-0 z-30 bg-neutral-950/40"
                onClick={() => setDrawer(false)}
              />
              <div
                role="dialog"
                aria-label={w('library')}
                className="fixed inset-y-0 left-0 z-40 flex w-[85vw] max-w-sm flex-col gap-4 overflow-y-auto bg-white p-3 shadow-xl dark:bg-neutral-950"
              >
                <div className="flex items-center gap-2">
                  <span className={`${TILE} size-7`} aria-hidden="true">
                    <Icon name="library" size={20} />
                  </span>
                  <span className="cb-display flex-1 text-2xl leading-none">{w('library')}</span>
                  <button
                    type="button"
                    onClick={() => setDrawer(false)}
                    aria-label="Close"
                    className="grid size-9 place-items-center rounded text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-900"
                  >
                    <span aria-hidden="true" className="text-xl leading-none">
                      ×
                    </span>
                  </button>
                </div>
                {left(true)}
              </div>
            </>
          )}
        </div>
      </ToneContext.Provider>
    );
  }

  return (
    <ToneContext.Provider value={toneOf}>
      <div className="flex h-full min-h-0 flex-col">
        {header}
        <div className="flex min-h-0 flex-1">
          {listing.entries.length > 0 && (
            <aside
              aria-label={w('tomes')}
              className="flex w-72 shrink-0 flex-col gap-4 overflow-y-auto border-r border-neutral-200 bg-neutral-50/60 p-3 dark:border-neutral-800 dark:bg-neutral-900/40"
            >
              {left(false)}
            </aside>
          )}
          <main className="flex min-w-0 flex-1 overflow-hidden">
            <div className="min-w-0 flex-1 overflow-y-auto">{main}</div>
            {rail && (
              <aside className="w-56 shrink-0 space-y-5 overflow-y-auto border-l border-neutral-200 p-3 xl:w-64 dark:border-neutral-800">
                {rail}
              </aside>
            )}
          </main>
        </div>
      </div>
    </ToneContext.Provider>
  );
}

/** A backlink's line as it reads: wiki links by their label, in the Library's purple, without Markdown's marks. */
function LinkLine({ line }: { line: string }) {
  const plain = (text: string) => text.replace(/\*\*|__|`/g, '');
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of line.matchAll(/!?\[\[([^[\]\n]+?)\]\]/g)) {
    if (match.index > last) parts.push(plain(line.slice(last, match.index)));
    const link = parseWikiLink(match[1]!);
    parts.push(
      <b key={match.index} className={LIBRARY_TONE.text}>
        {link.label || link.target || link.heading}
      </b>,
    );
    last = match.index + match[0].length;
  }
  if (last < line.length) parts.push(plain(line.slice(last)));
  return <>{parts}</>;
}

function Banner({ tone, icon, text }: { tone: 'grey' | 'rose'; icon: IconName; text: string }) {
  const colours =
    tone === 'rose'
      ? 'border-rose-300 bg-rose-50 text-rose-900 dark:border-rose-800 dark:bg-rose-950/50 dark:text-rose-100'
      : 'border-neutral-300 bg-neutral-100 text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200';
  return (
    <p role="status" className={`flex items-center gap-2 border-b px-4 py-2 text-sm font-bold ${colours}`}>
      <Icon name={icon} size={16} />
      {text}
    </p>
  );
}

/** The bar over a Tome: its path as crumbs, when it changed, Copy link and Edit. */
function TomeBar({
  path,
  when,
  onPath,
  onCopy,
  onEdit,
  phone,
}: {
  path: string;
  when: number | undefined;
  onPath: (path: string | undefined) => void;
  onCopy: () => void;
  onEdit: (() => void) | undefined;
  phone: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const parts = path.split('/');
  const crumb = 'whitespace-nowrap hover:text-purple-700 hover:underline dark:hover:text-purple-300';
  const slash = (
    <span aria-hidden="true" className="text-neutral-300 dark:text-neutral-700">
      /
    </span>
  );
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-neutral-200 px-4 py-2 dark:border-neutral-800">
      <nav aria-label="Path" className="flex min-w-0 flex-1 items-center gap-1 text-sm text-neutral-500">
        <button type="button" onClick={() => onPath(undefined)} className={crumb}>
          {w('library').toLowerCase()}
        </button>
        {parts.slice(0, -1).map((part, index) => (
          <span key={index} className="inline-flex items-center gap-1">
            {slash}
            <button type="button" onClick={() => onPath(parts.slice(0, index + 1).join('/'))} className={crumb}>
              {part}
            </button>
          </span>
        ))}
        {slash}
        <span className="truncate font-bold text-neutral-900 dark:text-neutral-100">{parts.at(-1)}</span>
      </nav>
      {when !== undefined && !phone && (
        <span className="text-[11px] text-neutral-500" title={new Date(when).toLocaleString()}>
          changed {ago(when, Date.now())}
        </span>
      )}
      <button
        type="button"
        onClick={() => {
          onCopy();
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        className={BUTTON}
      >
        <Icon name="deedLink" size={14} />
        {copied ? 'Copied' : 'Copy link'}
      </button>
      {onEdit && (
        <button type="button" onClick={onEdit} className={PRIMARY}>
          <Icon name="edit" size={14} />
          Edit
        </button>
      )}
    </div>
  );
}

/** A folder, or the Library's top, when no Tome is open: what's in it, and the Tomes changed last. */
function FolderView({
  root,
  folder,
  entries,
  onOpen,
  onPath,
}: {
  root: Folder;
  folder: string;
  entries: readonly LibraryEntry[];
  onOpen: (path: string) => void;
  onPath: (path: string | undefined) => void;
}) {
  const find = (at: Folder): Folder | undefined =>
    at.path === folder ? at : at.folders.map(find).find((one) => one !== undefined);
  const toneOf = useContext(ToneContext);
  const here = find(root) ?? root;
  const latest = folder ? [] : latestTomes(entries, 5);
  const now = Date.now();
  const row = `flex w-full items-center gap-2 rounded px-2 py-1.5 text-left ${HOVER}`;
  return (
    <div className="mx-auto max-w-3xl space-y-5 px-8 py-6">
      <h2 className="cb-display flex items-center gap-2 text-3xl leading-none">
        <span aria-hidden="true" className={folder ? toneOf(`${folder}/x`).icon : LIBRARY_TONE.text}>
          <Icon name={folder ? 'libraryFolder' : 'library'} size={28} />
        </span>
        {folder ? nameOf(folder) : w('library')}
      </h2>
      {latest.length > 0 && (
        <section aria-label="Changed last">
          <RailHead icon="markClock">Changed last</RailHead>
          <ul>
            {latest.map((entry) => (
              <li key={entry.path}>
                <button type="button" onClick={() => onOpen(entry.path)} className={row}>
                  <FileIcon path={entry.path} />
                  <span className="min-w-0 flex-1 truncate">{titleOf(entry.path)}</span>
                  <span className="truncate font-mono text-[11px] text-neutral-500 dark:text-neutral-400">
                    {folderOf(entry.path)}
                  </span>
                  <span className="text-[11px] text-neutral-500 dark:text-neutral-400">{ago(entry.mtimeMs!, now)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section aria-label={folder ? `In ${nameOf(folder)}` : `On the shelves`}>
        <RailHead icon="libraryFolder">{folder ? `In ${folder}` : 'On the shelves'}</RailHead>
        <ul>
          {here.folders.map((sub) => (
            <li key={sub.path}>
              <button type="button" onClick={() => onPath(sub.path)} className={`${row} font-bold`}>
                <span aria-hidden="true" className={toneOf(`${sub.path}/x`).icon}>
                  <Icon name="libraryFolder" size={16} />
                </span>
                <span className="min-w-0 flex-1 truncate">{nameOf(sub.path)}</span>
                <span className="text-[11px] font-normal text-neutral-500 dark:text-neutral-400">
                  {sub.folders.length + sub.files.length}
                </span>
              </button>
            </li>
          ))}
          {here.files.map((entry) => (
            <li key={entry.path}>
              <button type="button" onClick={() => onOpen(entry.path)} className={row}>
                <FileIcon path={entry.path} />
                <span className="min-w-0 flex-1 truncate">
                  {entry.kind === 'image' ? nameOf(entry.path) : titleOf(entry.path)}
                </span>
                {entry.kind === 'html' && <HtmlMark />}
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

// ---------- the Castle's card ----------

export interface LibraryCardProps {
  hub: LibraryHub;
  node: string;
  dir: string;
  /** Opens the Library at a Tome, or at its top. */
  onOpen: (path?: string) => void;
}

/** The Castle's Library card, under Errands: the three Tomes changed last, quick-open, and Open the Library. */
export function LibraryCard({ hub, node, dir, onOpen }: LibraryCardProps) {
  const listing = useLibrary(hub, node);
  const latest = useMemo(() => latestTomes(listing.entries, 3), [listing.entries]);
  const count = listing.entries.filter((entry) => entry.kind === 'md' || entry.kind === 'html').length;
  const now = Date.now();
  return (
    <section aria-label={w('library')} className="space-y-2">
      <div className="flex items-center gap-2 px-3">
        <span className={`${TILE} size-7`} aria-hidden="true">
          <Icon name="library" size={20} />
        </span>
        <h2 className="cb-display text-2xl leading-none" title={hint('library')}>
          {w('library')}
        </h2>
      </div>
      <div className="mx-3 rounded-lg border border-purple-300 bg-purple-50 p-3 dark:border-purple-800 dark:bg-purple-950/40">
        <div className="mb-2 flex min-w-0 items-center gap-1 text-xs text-neutral-500">
          <span aria-hidden="true">
            <Icon name="libraryFolder" size={14} />
          </span>
          <span className="truncate font-mono" title={dir}>
            {dir}
          </span>
          {!listing.loading && !listing.error && (
            <span className="shrink-0">
              · {count} {count === 1 ? w('tome') : w('tomes')}
            </span>
          )}
        </div>
        {listing.error ? (
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            {listing.error === OFFLINE
              ? `Closed while the ${w('kingdom')} is offline.`
              : `Can't be read: ${listing.error}.`}
          </p>
        ) : !listing.loading && latest.length === 0 ? (
          <p className="text-sm text-neutral-600 dark:text-neutral-400">Still empty.</p>
        ) : (
          <ul className="space-y-0.5 text-sm">
            {latest.map((entry) => (
              <li key={entry.path}>
                <button
                  type="button"
                  onClick={() => onOpen(entry.path)}
                  title={entry.path}
                  className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-purple-100 dark:hover:bg-purple-900/40"
                >
                  <FileIcon path={entry.path} />
                  <span className="min-w-0 flex-1 truncate">{titleOf(entry.path)}</span>
                  <span className="text-[11px] text-neutral-500 dark:text-neutral-400">{ago(entry.mtimeMs!, now)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => onOpen(undefined)} className={PRIMARY}>
            <Icon name="openBook" size={14} />
            Open the {w('library')}
          </button>
          <QuickOpen entries={listing.entries} onOpen={(path) => onOpen(path)} wide={false} />
        </div>
      </div>
    </section>
  );
}
