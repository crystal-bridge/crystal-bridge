import {
  type Errand,
  type ErrandCreate,
  type ErrandEdit,
  type ErrandState,
  type ListedPatrol,
  MAX_ERRAND_BODY,
  MAX_QUEST_TITLE,
  type Project,
} from '@crystal-bridge/protocol';
import { type FormEvent, type ReactNode, useId, useLayoutEffect, useRef, useState } from 'react';
import {
  closedOnes,
  type ErrandDay,
  type ErrandLayout,
  type ErrandSource,
  dayGroups,
  ERRAND_TONES,
  errandSource,
  errandTone,
  openOnes,
  type ProjectGroup,
  projectGroups,
  useErrandLayout,
} from '../errands.js';
import { projectName } from '../quests.js';
import { Icon, type IconName } from '../theme/icons.js';
import { errandWords, hint, w } from '../theme/words.js';
import { ago, agoText } from './HomeParts.js';
import { type LayoutOption, LayoutSwitch } from './LayoutSwitch.js';
import { QuestMarkdown } from './markdown.js';
import type { SessionSummary } from './SessionList.js';

export interface ErrandsPanelProps {
  /** The Kingdom's Errands, open and closed, as the hub lists them. */
  errands: Errand[];
  /** The Kingdom's Quests, to name the one that left an Errand. */
  sessions: readonly SessionSummary[];
  /** The Kingdom's Patrols, to name the one whose Quest left an Errand. */
  patrols: readonly ListedPatrol[];
  /** The Kingdom's projects, for Add Errand's picker. */
  projects?: Project[];
  now?: number;
  /** Opens the Quest that left an Errand, closed or not. */
  onOpenQuest?: (session: string) => void;
  /** Ticks an Errand done, dismisses it, or reopens it; without it, nothing can be changed. */
  onState?: (id: string, state: ErrandState) => void;
  onAdd?: (draft: ErrandCreate) => Promise<void>;
  onEdit?: (id: string, edit: ErrandEdit) => Promise<void>;
  /** Shows the Errands without Add, Edit or Dismiss; ticking one and reopening one stay, as the phone needs. */
  readOnly?: boolean;
  /**
   * The phone's list: read, copy and tick only (so read-only, whatever `readOnly` says), compact rows with a stripe in
   * each project's colour and larger ticks, and no layout switch.
   */
  phone?: boolean;
  /** Why the hub's list couldn't be read, said in place of the list. */
  error?: string | undefined;
}

/** An Errand's Markdown: compact code blocks (`QuestMarkdown compact`) that scroll in their own box, each with Copy. */
const BODY =
  'cb-prose mb-1 mt-1.5 min-w-0 text-[13px] text-neutral-700 [overflow-wrap:anywhere] dark:text-neutral-300 [&_code]:font-mono [&_pre]:[overflow-wrap:normal] [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto';

const LAYOUTS: LayoutOption<ErrandLayout>[] = [
  { mode: 'checklist', label: 'Checklist', icon: 'boardChecklist', hint: 'A checklist by project' },
  { mode: 'cards', label: 'Cards', icon: 'layoutCards', hint: 'A card each, by the day it was left' },
];

/**
 * A Kingdom's Errands on the Castle, as a checklist by project or as cards by day; the header's switch picks one for
 * this device.
 */
export function ErrandsPanel({
  errands,
  sessions,
  patrols,
  projects = [],
  now = Date.now(),
  onOpenQuest,
  onState,
  onAdd,
  onEdit,
  readOnly: readOnlyAsked = false,
  phone = false,
  error,
}: ErrandsPanelProps) {
  const say = errandWords();
  const readOnly = readOnlyAsked || phone;
  const [layout, setLayout] = useErrandLayout();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string>();
  const open = openOnes(errands);
  const closed = closedOnes(errands);
  const canAdd = !readOnly && onAdd !== undefined;
  const canEdit = !readOnly && onEdit !== undefined;
  const rows: RowProps = {
    sessions,
    patrols,
    now,
    onOpenQuest,
    onState,
    canDismiss: !readOnly,
    onEdit: canEdit ? setEditing : undefined,
    editForm: (errand) =>
      editing === errand.id && onEdit ? (
        <ErrandForm
          initial={errand}
          onSubmit={async (edit) => {
            await onEdit(errand.id, { title: edit.title, body: edit.body });
            setEditing(undefined);
          }}
          onCancel={() => setEditing(undefined)}
        />
      ) : undefined,
  };
  const addButton = canAdd && (
    <button
      type="button"
      aria-label={say.add}
      title={say.add}
      onClick={() => setAdding(true)}
      className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-bold text-neutral-600 ring-1 ring-neutral-300 hover:bg-neutral-100 dark:text-neutral-300 dark:ring-neutral-700 dark:hover:bg-neutral-800"
    >
      <Icon name="attach" size={14} />
      Add
    </button>
  );
  return (
    <section aria-label={w('errands')} className="space-y-1">
      <div className="flex flex-wrap items-center gap-2 px-3">
        <h2 className="cb-display text-2xl leading-none" title={hint('errands')}>
          {w('errands')}
        </h2>
        {(phone || layout === 'checklist') && open.length > 0 && (
          <span
            title={`${open.length} open`}
            className="inline-flex items-center gap-0.5 rounded-full bg-teal-600 py-0 pl-1 pr-1.5 text-xs font-bold leading-4 text-white dark:bg-teal-500 dark:text-teal-950"
          >
            <Icon name="errands" size={12} />
            {open.length}
          </span>
        )}
        <span className="flex-1" />
        {!phone && layout === 'cards' && open.length > 0 && (
          <span className="text-xs text-neutral-500">{`${open.length} open`}</span>
        )}
        {addButton}
        {!phone && <LayoutSwitch mode={layout} onMode={setLayout} options={LAYOUTS} size="compact" />}
      </div>
      {adding && onAdd && (
        <ErrandForm
          projects={projects}
          onSubmit={async (draft) => {
            await onAdd(draft);
            setAdding(false);
          }}
          onCancel={() => setAdding(false)}
        />
      )}
      {error !== undefined ? (
        <p role="alert" className="px-3 text-sm text-red-700 dark:text-red-400">
          <span className="font-bold">{say.loadFailed}</span> <span>{error}</span>
        </p>
      ) : open.length === 0 ? (
        <p className="px-3 text-sm text-neutral-500">{say.noneOpen}</p>
      ) : phone ? (
        <PhoneList open={open} {...rows} />
      ) : layout === 'cards' ? (
        <Cards open={open} {...rows} />
      ) : (
        <Checklist open={open} {...rows} />
      )}
      <ClosedFold closed={closed} onState={onState} />
      {phone && <p className="px-3 pt-1 text-[11px] text-neutral-500">Add, edit and dismiss on a wider screen.</p>}
    </section>
  );
}

/**
 * One Quest's Errands, in its side panel: the open ones, each with its details, a tick and Dismiss, then the closed ones
 * folded. A fork has its own id, so it lists none of the Quest it came from. No Add here: a hand-written Errand has no
 * Quest, so one added here couldn't belong to it. Its id is what the chat line's Show scrolls to.
 */
export function QuestErrands({
  session,
  errands,
  onState,
  readOnly = false,
}: {
  session: string;
  /** The Kingdom's Errands, open and closed; only this Quest's show. */
  errands: readonly Errand[];
  onState?: ((id: string, state: ErrandState) => void) | undefined;
  /** Without Dismiss; ticking and reopening stay. */
  readOnly?: boolean | undefined;
}) {
  const mine = errands.filter((errand) => errand.session === session);
  if (mine.length === 0) return null;
  const open = openOnes(mine);
  return (
    <section
      id={`errands-${session}`}
      aria-label={w('errands')}
      className="scroll-mt-3 rounded-lg border border-teal-300 bg-teal-50/60 dark:border-teal-800 dark:bg-teal-950/40"
    >
      <div className="flex items-center gap-2 px-2.5 pt-2">
        <span aria-hidden="true" className="text-teal-700 dark:text-teal-300">
          <Icon name="errands" size={18} />
        </span>
        <h3 className="cb-display text-xl leading-none" title={hint('errands')}>
          {w('errands')}
        </h3>
        {open.length > 0 && (
          <span
            title={`${open.length} open`}
            className="rounded-full bg-teal-600 px-1.5 text-[11px] font-bold leading-4 text-white dark:bg-teal-500 dark:text-teal-950"
          >
            {open.length}
          </span>
        )}
      </div>
      <p className="px-2.5 text-[11px] text-neutral-500">{errandWords().questLeft}</p>
      <ul className="mt-1.5 space-y-1 px-1.5 pb-2">
        {open.length === 0 ? (
          <li className="px-1 text-xs text-neutral-500">All done.</li>
        ) : (
          open.map((errand) => <QuestRow key={errand.id} errand={errand} onState={onState} canDismiss={!readOnly} />)
        )}
      </ul>
      <div className="pb-2">
        <ClosedFold closed={closedOnes(mine)} onState={onState} />
      </div>
    </section>
  );
}

function QuestRow({
  errand,
  onState,
  canDismiss,
}: {
  errand: Errand;
  onState?: ((id: string, state: ErrandState) => void) | undefined;
  canDismiss: boolean;
}) {
  return (
    <li
      aria-label={errand.title}
      className="group flex items-start gap-2 rounded-md bg-white p-2 text-sm ring-1 ring-neutral-200 dark:bg-neutral-950 dark:ring-neutral-800"
    >
      {onState && (
        <button
          type="button"
          aria-label={`Mark done: ${errand.title}`}
          title="Mark done"
          onClick={() => onState(errand.id, 'done')}
          className="inline-flex shrink-0 items-center justify-center rounded text-neutral-400 hover:text-emerald-600 dark:text-neutral-500 dark:hover:text-emerald-400"
        >
          <Icon name="errandOpen" size={18} />
        </button>
      )}
      <div className="min-w-0 flex-1">
        <span className="block font-medium leading-snug [overflow-wrap:anywhere]">{errand.title}</span>
        {errand.body.trim() && (
          <div className={BODY}>
            <QuestMarkdown compact>{errand.body}</QuestMarkdown>
          </div>
        )}
      </div>
      {onState && canDismiss && (
        <button
          type="button"
          aria-label={`Dismiss: ${errand.title}`}
          title="Dismiss"
          onClick={() => onState(errand.id, 'dismissed')}
          className={`inline-flex shrink-0 items-center justify-center rounded p-0.5 text-neutral-400 opacity-0 hover:bg-neutral-100 hover:text-neutral-700 focus:opacity-100 group-hover:opacity-100 dark:hover:bg-neutral-800 dark:hover:text-neutral-200 ${NO_HOVER_SHOWS}`}
        >
          <Icon name="errandDismiss" size={16} />
        </button>
      )}
    </li>
  );
}

interface RowProps {
  sessions: readonly SessionSummary[];
  patrols: readonly ListedPatrol[];
  now: number;
  onOpenQuest?: ((session: string) => void) | undefined;
  onState?: ((id: string, state: ErrandState) => void) | undefined;
  /** Whether Dismiss shows; a read-only panel keeps ticking and reopening but not this. */
  canDismiss?: boolean | undefined;
  /** Opens an Errand's edit form; without it, no Edit button shows. */
  onEdit?: ((id: string) => void) | undefined;
  /** The edit form for an Errand that is being edited, to show in place of its row or card. */
  editForm?: ((errand: Errand) => ReactNode) | undefined;
}

/** Hover-only actions stay in sight on a device that can't hover (a tablet, a touch screen), or they'd never show. */
const NO_HOVER_SHOWS = '[@media(hover:none)]:opacity-100';

/** The audition's view B: a share bar, then a washed header and a row per Errand for each project. */
function Checklist({ open, ...rest }: RowProps & { open: Errand[] }) {
  const groups = projectGroups(open);
  return (
    <div className="mx-3 overflow-hidden rounded-lg border border-neutral-200 dark:border-neutral-800">
      <div data-share-bar className="flex h-1.5">
        {groups.map((group) => (
          <span
            key={group.project ?? ''}
            className={ERRAND_TONES[group.tone].bar}
            style={{ flexGrow: group.errands.length, flexBasis: 0 }}
            title={`${group.name}: ${group.errands.length}`}
          />
        ))}
      </div>
      {groups.map((group) => (
        <ProjectRows key={group.project ?? ''} group={group} {...rest} />
      ))}
    </div>
  );
}

function ProjectRows({ group, ...rest }: RowProps & { group: ProjectGroup }) {
  const tone = ERRAND_TONES[group.tone];
  return (
    <div
      role="group"
      aria-label={group.name}
      className="border-b border-neutral-200 last:border-b-0 dark:border-neutral-800"
    >
      <div className={`flex items-center gap-2 bg-linear-to-r ${tone.wash} to-transparent to-70% px-2.5 py-1.5`}>
        <span aria-hidden="true" className={`size-2.5 shrink-0 rounded-sm ${tone.dot}`} />
        <span title={group.project} className={`min-w-0 flex-1 truncate text-xs font-bold ${tone.text}`}>
          {group.name}
        </span>
        <span className="text-[11px] font-bold text-neutral-500">{group.errands.length}</span>
      </div>
      <ul>
        {group.errands.map((errand) => (
          <ErrandRow key={errand.id} errand={errand} {...rest} />
        ))}
      </ul>
    </div>
  );
}

function ErrandRow({ errand, now, onState, canDismiss, onEdit, editForm, ...known }: RowProps & { errand: Errand }) {
  const form = editForm?.(errand);
  if (form) return <li className="px-2.5 py-1">{form}</li>;
  return (
    <li
      aria-label={errand.title}
      className="group flex items-start gap-2 px-2.5 py-1 hover:bg-neutral-50 dark:hover:bg-neutral-900"
    >
      {onState && (
        <button
          type="button"
          aria-label={`Mark done: ${errand.title}`}
          title="Mark done"
          onClick={() => onState(errand.id, 'done')}
          // A 28px target round the 18px tick, its margins drawing it back to where the tick alone sat.
          className="-mx-[5px] -mt-px inline-flex size-7 shrink-0 items-center justify-center self-start rounded text-neutral-400 hover:text-emerald-600 dark:text-neutral-500 dark:hover:text-emerald-400"
        >
          <Icon name="errandOpen" size={18} />
        </button>
      )}
      <div className="min-w-0 flex-1 text-sm">
        <TitleFold errand={errand} />
        <SourceLine errand={errand} now={now} {...known} />
      </div>
      <span className={`flex opacity-0 focus-within:opacity-100 group-hover:opacity-100 ${NO_HOVER_SHOWS}`}>
        {onEdit && <EditButton errand={errand} onEdit={onEdit} className="mt-1" />}
        {onState && canDismiss && (
          <button
            type="button"
            aria-label={`Dismiss: ${errand.title}`}
            title="Dismiss"
            onClick={() => onState(errand.id, 'dismissed')}
            className="mt-1 inline-flex shrink-0 items-center justify-center self-start rounded p-0.5 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
          >
            <Icon name="errandDismiss" size={16} />
          </button>
        )}
      </span>
    </li>
  );
}

/** The audition's phone view: a row per Errand, newest first, striped in its project's colour, with a thumb-sized tick. */
function PhoneList({ open, ...rest }: RowProps & { open: Errand[] }) {
  const newest = [...open].sort((a, b) => b.created - a.created);
  return (
    <ul className="mx-3 divide-y divide-neutral-200 overflow-hidden rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
      {newest.map((errand) => (
        <PhoneRow key={errand.id} errand={errand} {...rest} />
      ))}
    </ul>
  );
}

function PhoneRow({ errand, now, onState, sessions, patrols, onOpenQuest }: RowProps & { errand: Errand }) {
  const tone = ERRAND_TONES[errandTone(errand.project)];
  return (
    <li aria-label={errand.title} className={`flex gap-2.5 border-l-4 ${tone.stripe} px-2.5 py-2`}>
      {onState && (
        <button
          type="button"
          aria-label={`Mark done: ${errand.title}`}
          title="Mark done"
          onClick={() => onState(errand.id, 'done')}
          className="mt-0.5 inline-flex shrink-0 items-center justify-center self-start rounded text-neutral-400 hover:text-emerald-600 dark:text-neutral-500 dark:hover:text-emerald-400"
        >
          <Icon name="errandOpen" size={24} />
        </button>
      )}
      <div className="min-w-0 flex-1 text-sm">
        <TitleFold errand={errand} wrap />
        <PhoneSource errand={errand} now={now} sessions={sessions} patrols={patrols} onOpenQuest={onOpenQuest} />
      </div>
    </li>
  );
}

/** A fold's "has details" cue after its title, turning down while open; `group/fold` is the `details` it belongs to. */
function Caret() {
  return (
    <span
      aria-hidden="true"
      className="inline-flex shrink-0 text-neutral-400 transition-transform group-open/fold:rotate-90 dark:text-neutral-500"
    >
      <Icon name="caret" size={10} />
    </span>
  );
}

/** No browser marker on a fold's summary: the Caret stands in for it. */
const SUMMARY = 'list-none [&::-webkit-details-marker]:hidden';

/**
 * An Errand's title, with its details folded under it and a Caret after it as the cue; a title alone without them.
 * One line that truncates on the Checklist, or that wraps (`wrap`) on the phone.
 */
function TitleFold({ errand, wrap = false }: { errand: Errand; wrap?: boolean }) {
  const look = wrap ? 'font-medium leading-snug [overflow-wrap:anywhere]' : 'min-w-0 truncate font-medium leading-6';
  if (!errand.body.trim()) return <span className={`block ${look}`}>{errand.title}</span>;
  return (
    <details className="group/fold">
      <summary className={wrap ? SUMMARY : `flex min-w-0 items-center gap-1 ${SUMMARY}`}>
        <span className={look}>{errand.title}</span>
        {wrap ? (
          <span className="ml-1 inline-flex align-middle">
            <Caret />
          </span>
        ) : (
          <Caret />
        )}
      </summary>
      <div className={BODY}>
        <QuestMarkdown compact>{errand.body}</QuestMarkdown>
      </div>
    </details>
  );
}

/**
 * The phone's source line: the project and age, as the stripe's colour alone doesn't name it, after the icon of what
 * left it; the project opens that Quest.
 */
function PhoneSource({
  errand,
  now,
  sessions,
  patrols,
  onOpenQuest,
}: Pick<RowProps, 'sessions' | 'patrols' | 'now' | 'onOpenQuest'> & { errand: Errand }) {
  const source = errandSource(errand, { sessions, patrols });
  const label = sourceLabel(source);
  const project = errand.project === undefined ? 'No project' : projectName(errand.project);
  return (
    <span
      data-source
      className="mt-0.5 flex min-w-0 items-center gap-1 text-[11px] text-neutral-500 dark:text-neutral-400"
    >
      <span title={label} className="inline-flex shrink-0">
        <Icon name={SOURCE_LOOKS[source.kind].icon} size={12} />
      </span>
      {source.kind !== 'hand' && onOpenQuest ? (
        <button
          type="button"
          onClick={() => onOpenQuest(source.session)}
          aria-label={`Open ${w('quest')}: ${source.kind === 'quest' ? source.label : source.name}`}
          title={`Open this ${w('quest')}`}
          className="min-w-0 truncate text-left hover:underline"
        >
          {project}
        </button>
      ) : (
        <span className="min-w-0 truncate">{project}</span>
      )}
      <span aria-hidden="true">·</span>
      <span className="shrink-0">{ago(errand.created, now)}</span>
    </span>
  );
}

/** What left an Errand, in words: the Quest's name, the Patrol's, or you. */
function sourceLabel(source: ErrandSource): string {
  return source.kind === 'quest'
    ? source.label
    : source.kind === 'patrol'
      ? `${w('patrol')}: ${source.name}`
      : 'Written by you';
}

/**
 * What left an Errand, and how long ago: the Quest or Patrol (a link to its Quest), or you. It sits outside the title's
 * `summary`, so the link is a button of its own that keyboards and screen readers reach.
 */
function SourceLine({
  errand,
  now,
  sessions,
  patrols,
  onOpenQuest,
  age = true,
}: Pick<RowProps, 'sessions' | 'patrols' | 'now' | 'onOpenQuest'> & { errand: Errand; age?: boolean }) {
  const source = errandSource(errand, { sessions, patrols });
  const { icon } = SOURCE_LOOKS[source.kind];
  const label = sourceLabel(source);
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-neutral-500 dark:text-neutral-400">
      <Icon name={icon} size={12} />
      {source.kind !== 'hand' && onOpenQuest ? (
        <button
          type="button"
          onClick={() => onOpenQuest(source.session)}
          title={`Open this ${w('quest')}`}
          className="min-w-0 truncate text-left hover:underline"
        >
          {label}
        </button>
      ) : (
        <span className="min-w-0 truncate">{label}</span>
      )}
      {age && (
        <>
          <span aria-hidden="true">·</span>
          <span className="shrink-0">{ago(errand.created, now)}</span>
        </>
      )}
    </span>
  );
}

/** Each source's icon, and its tile on a card: indigo for a Quest, teal for a Patrol, fuchsia by hand. */
const SOURCE_LOOKS: Record<ErrandSource['kind'], { icon: IconName; short: string; tile: string }> = {
  quest: {
    icon: 'scrollUnfurled',
    short: w('quest'),
    tile: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-200',
  },
  patrol: {
    icon: 'errandPatrol',
    short: w('patrol'),
    tile: 'bg-teal-100 text-teal-800 dark:bg-teal-950 dark:text-teal-200',
  },
  hand: {
    icon: 'quillInk',
    short: 'By hand',
    tile: 'bg-fuchsia-100 text-fuchsia-800 dark:bg-fuchsia-950 dark:text-fuchsia-200',
  },
};

const DAY_NAMES: Record<ErrandDay, string> = { today: 'Today', yesterday: 'Yesterday', earlier: 'Earlier' };

/** The audition's view C: a small rule per day, then a grid of cards, each topped in its project's colour. */
function Cards({ open, ...rest }: RowProps & { open: Errand[] }) {
  return (
    <div className="space-y-3 px-3">
      {dayGroups(open, rest.now).map(({ day, errands }) => (
        <div key={day}>
          <div className="mb-1.5 flex items-center gap-2">
            <h3 className="text-xs font-bold uppercase tracking-wide text-neutral-500">{DAY_NAMES[day]}</h3>
            <span aria-hidden="true" className="h-px flex-1 bg-neutral-200 dark:bg-neutral-800" />
          </div>
          <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
            {errands.map((errand) => (
              <ErrandCard key={errand.id} errand={errand} {...rest} />
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function ErrandCard({ errand, now, onState, canDismiss, onEdit, editForm, ...known }: RowProps & { errand: Errand }) {
  const form = editForm?.(errand);
  if (form) return <li className="rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">{form}</li>;
  const source = errandSource(errand, known);
  const look = SOURCE_LOOKS[source.kind];
  const tone = ERRAND_TONES[errandTone(errand.project)];
  return (
    <li
      aria-label={errand.title}
      className="flex flex-col overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-sm dark:border-neutral-800 dark:bg-neutral-950"
    >
      <div data-card-top className={`h-1.5 ${tone.bar}`} />
      <div className="flex flex-1 flex-col gap-2 p-3">
        <div className="flex items-start gap-2.5">
          <span title={look.short} className={`grid size-9 shrink-0 place-items-center rounded-lg ${look.tile}`}>
            <Icon name={look.icon} size={22} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="font-bold leading-snug [overflow-wrap:anywhere]">{errand.title}</div>
            <div className="mt-0.5">
              <SourceLine errand={errand} now={now} age={false} {...known} />
            </div>
          </div>
          {onEdit && <EditButton errand={errand} onEdit={onEdit} />}
          {onState && canDismiss && (
            <button
              type="button"
              aria-label={`Dismiss: ${errand.title}`}
              title="Dismiss"
              onClick={() => onState(errand.id, 'dismissed')}
              className="inline-flex shrink-0 items-center justify-center self-start rounded p-0.5 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
            >
              <Icon name="errandDismiss" size={16} />
            </button>
          )}
        </div>
        {errand.body.trim() && <CardBody body={errand.body} />}
        <div className="mt-auto flex items-center gap-2 pt-1">
          <ProjectChip project={errand.project} />
          <span className="shrink-0 text-[11px] text-neutral-500">{agoText(errand.created, now)}</span>
          <span className="flex-1" />
          {onState && (
            <button
              type="button"
              onClick={() => onState(errand.id, 'done')}
              className="inline-flex items-center gap-1 rounded-md bg-emerald-100 px-2 py-1 text-xs font-bold text-emerald-900 ring-1 ring-emerald-300 hover:brightness-105 dark:bg-emerald-950 dark:text-emerald-200 dark:ring-emerald-800"
            >
              <Icon name="errandDone" size={14} />
              Done
            </button>
          )}
        </div>
      </div>
    </li>
  );
}

/**
 * A card's body, clipped at a set height so the cards line up. Copy takes a whole code block, so nothing it takes may be
 * out of sight: a body taller than the clip fades at the cut and gets Show all, which lets the card grow to show it.
 */
function CardBody({ body }: { body: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  const [expanded, setExpanded] = useState(false);
  useLayoutEffect(() => {
    const element = box.current;
    // Open, nothing is clipped to measure: it keeps the answer it had while clipped.
    if (!element || expanded) return;
    const check = () => setOverflows(element.scrollHeight > element.clientHeight + 1);
    check();
    if (typeof ResizeObserver === 'undefined') return;
    // The card's width, a font arriving or a picture loading can each change what fits.
    const observer = new ResizeObserver(check);
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    return () => observer.disconnect();
  }, [body, expanded]);
  return (
    <div>
      <div ref={box} data-card-body className={`relative ${expanded ? '' : 'max-h-44 overflow-hidden'}`}>
        <div className={BODY}>
          <QuestMarkdown compact>{body}</QuestMarkdown>
        </div>
        {overflows && !expanded && (
          <div
            data-card-fade
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-linear-to-t from-white to-transparent dark:from-neutral-950"
          />
        )}
      </div>
      {overflows && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
          className="mt-1 inline-flex items-center gap-1 rounded px-1 text-xs font-bold text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          <span aria-hidden="true" className={`inline-flex ${expanded ? '-rotate-90' : 'rotate-90'}`}>
            <Icon name="caret" size={10} />
          </span>
          {expanded ? 'Show less' : 'Show all'}
        </button>
      )}
    </div>
  );
}

function EditButton({
  errand,
  onEdit,
  className = '',
}: {
  errand: Errand;
  onEdit: (id: string) => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-label={`Edit: ${errand.title}`}
      title="Edit"
      onClick={() => onEdit(errand.id)}
      className={`inline-flex shrink-0 items-center justify-center self-start rounded p-0.5 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200 ${className}`}
    >
      <Icon name="edit" size={16} />
    </button>
  );
}

const FIELD =
  'w-full rounded border border-neutral-300 bg-white px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-950';

/**
 * Writes an Errand by hand, or edits one (`initial`): a title, Markdown details and, for a new one, a project. An edit
 * changes the title and details only; the project stays as it was made. The hub's refusal shows here and keeps the form.
 */
export function ErrandForm({
  initial,
  projects = [],
  onSubmit,
  onCancel,
}: {
  initial?: Errand | undefined;
  projects?: Project[] | undefined;
  onSubmit: (draft: ErrandCreate) => Promise<void>;
  onCancel: () => void;
}) {
  const id = useId();
  const [title, setTitle] = useState(initial?.title ?? '');
  const [body, setBody] = useState(initial?.body ?? '');
  const [project, setProject] = useState('');
  const [problem, setProblem] = useState<string>();
  const [saving, setSaving] = useState(false);
  const tooLong = body.length > MAX_ERRAND_BODY;
  const heading = initial ? errandWords().edit : errandWords().byYou;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (tooLong || saving) return;
    const trimmed = title.trim();
    if (!trimmed) return setProblem('Give it a title.');
    setProblem(undefined);
    setSaving(true);
    try {
      await onSubmit({ title: trimmed, body, ...(project ? { project } : {}) });
    } catch (failure) {
      setProblem(failure instanceof Error ? failure.message : String(failure));
      setSaving(false);
    }
  }

  return (
    <form
      aria-label={heading}
      onSubmit={submit}
      className="mx-3 mb-2 space-y-2 rounded-md border border-dashed border-neutral-300 p-3 dark:border-neutral-700"
    >
      <div className="flex items-center gap-2 text-xs font-bold text-fuchsia-700 dark:text-fuchsia-300">
        <Icon name="quillInk" size={16} />
        {heading}
      </div>
      <input
        aria-label="Title"
        required
        maxLength={MAX_QUEST_TITLE}
        placeholder="What to do"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        className={FIELD}
      />
      <textarea
        aria-label="Details"
        rows={3}
        placeholder="Details, in Markdown: commands in fenced ``` blocks get a Copy button"
        value={body}
        onChange={(event) => setBody(event.target.value)}
        className={`${FIELD} font-mono text-xs`}
      />
      {tooLong && (
        <p role="alert" className="text-xs text-red-700 dark:text-red-400">{`At most ${MAX_ERRAND_BODY} characters`}</p>
      )}
      {problem && (
        <p role="alert" className="text-xs text-red-700 dark:text-red-400">
          {problem}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {!initial && (
          <select
            id={`${id}-project`}
            aria-label="Project"
            value={project}
            onChange={(event) => setProject(event.target.value)}
            className="rounded border border-neutral-300 bg-white px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-950"
          >
            <option value="">No project</option>
            {projects.map((p) => (
              <option key={p.path} value={p.path}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        <span className="flex-1" />
        <button
          type="button"
          onClick={onCancel}
          className="rounded px-2 py-1 text-xs hover:bg-neutral-100 dark:hover:bg-neutral-800"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={saving}
          className="rounded bg-neutral-800 px-2.5 py-1 text-xs font-bold text-white hover:bg-neutral-700 disabled:opacity-60 dark:bg-neutral-200 dark:text-neutral-900"
        >
          {initial ? 'Save' : 'Add'}
        </button>
      </div>
    </form>
  );
}

/** An Errand's project in its colour, or No project. */
function ProjectChip({ project }: { project: string | undefined }) {
  const tone = ERRAND_TONES[errandTone(project)];
  return (
    <span
      title={project}
      className={`inline-flex min-w-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-bold ring-1 ${tone.chip}`}
    >
      <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${tone.dot}`} />
      <span className="truncate">{project === undefined ? 'No project' : projectName(project)}</span>
    </span>
  );
}

/** Done and dismissed Errands, folded under a count, each with Reopen; the hub deletes them 30 days after closing. */
function ClosedFold({
  closed,
  onState,
}: {
  closed: Errand[];
  onState?: ((id: string, state: ErrandState) => void) | undefined;
}) {
  if (closed.length === 0) return null;
  return (
    <details className="group/fold mx-3 mt-1 text-sm">
      <summary
        className={`inline-flex items-center gap-1 rounded px-1 py-0.5 text-xs font-bold text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-900 ${SUMMARY}`}
      >
        <Caret />
        <span>Done and dismissed</span>{' '}
        <span className="rounded-full bg-neutral-200 px-1.5 text-[10px] text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
          {closed.length}
        </span>
      </summary>
      <ul className="mt-1 space-y-0.5">
        {closed.map((errand) => {
          const done = errand.state === 'done';
          return (
            <li key={errand.id} className="flex items-center gap-2 rounded px-1 py-1 text-neutral-500">
              <span
                role="img"
                aria-label={done ? 'Done' : 'Dismissed'}
                title={done ? 'Done' : 'Dismissed'}
                className={done ? 'text-emerald-600 dark:text-emerald-400' : undefined}
              >
                <Icon name={done ? 'errandDone' : 'errandDismissed'} size={16} />
              </span>
              <span className={`min-w-0 flex-1 truncate ${done ? 'line-through' : ''}`}>{errand.title}</span>
              {onState && (
                <button
                  type="button"
                  aria-label={`Reopen: ${errand.title}`}
                  onClick={() => onState(errand.id, 'open')}
                  className="text-xs underline"
                >
                  Reopen
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <p className="px-1 pt-1 text-[11px] text-neutral-500">Deleted 30 days after they're closed.</p>
    </details>
  );
}
