import type { Errand, ErrandCreate, ErrandEdit, ErrandState, ListedPatrol, Project } from '@crystal-bridge/protocol';
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
import { hint, w } from '../theme/words.js';
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
  /** Shows the Errands to read and copy, with no way to change them. */
  readOnly?: boolean;
}

/** Markdown as the chat shows it: code blocks scroll in their own box, each with its copy button. */
const BODY =
  'cb-prose mb-1 mt-1.5 min-w-0 text-[13px] text-neutral-700 [overflow-wrap:anywhere] dark:text-neutral-300 [&_code]:font-mono [&_pre]:overflow-x-auto [&_pre]:bg-neutral-100 [&_pre]:p-2 [&_pre]:text-[12px] [&_pre]:[overflow-wrap:normal] [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto dark:[&_pre]:bg-neutral-900';

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
  now = Date.now(),
  onOpenQuest,
  onState,
  readOnly = false,
}: ErrandsPanelProps) {
  const [layout, setLayout] = useErrandLayout();
  const open = openOnes(errands);
  const closed = closedOnes(errands);
  const change = readOnly ? undefined : onState;
  const rows = { sessions, patrols, now, onOpenQuest, onState: change };
  return (
    <section aria-label={w('errands')} className="space-y-1">
      <div className="flex flex-wrap items-center gap-2 px-3">
        <h2 className="cb-display text-2xl leading-none" title={hint('errands')}>
          {w('errands')}
        </h2>
        {layout === 'checklist' && open.length > 0 && (
          <span
            title={`${open.length} open`}
            className="inline-flex items-center gap-0.5 rounded-full bg-teal-600 py-0 pl-1 pr-1.5 text-xs font-bold leading-4 text-white dark:bg-teal-500 dark:text-teal-950"
          >
            <Icon name="errands" size={12} />
            {open.length}
          </span>
        )}
        <span className="flex-1" />
        {layout === 'cards' && open.length > 0 && (
          <span className="text-xs text-neutral-500">{`${open.length} open`}</span>
        )}
        <LayoutSwitch mode={layout} onMode={setLayout} options={LAYOUTS} />
      </div>
      {open.length === 0 ? (
        <p className="px-3 text-sm text-neutral-500">{`No open ${w('errands')}.`}</p>
      ) : layout === 'cards' ? (
        <Cards open={open} {...rows} />
      ) : (
        <Checklist open={open} {...rows} />
      )}
      <ClosedFold closed={closed} onState={change} />
    </section>
  );
}

interface RowProps {
  sessions: readonly SessionSummary[];
  patrols: readonly ListedPatrol[];
  now: number;
  onOpenQuest?: ((session: string) => void) | undefined;
  onState?: ((id: string, state: ErrandState) => void) | undefined;
}

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

function ErrandRow({ errand, now, onState, ...known }: RowProps & { errand: Errand }) {
  const title = <span className="block truncate font-medium leading-6">{errand.title}</span>;
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
          className="mt-1 inline-flex shrink-0 items-center justify-center self-start rounded text-neutral-400 hover:text-emerald-600 dark:text-neutral-500 dark:hover:text-emerald-400"
        >
          <Icon name="errandOpen" size={18} />
        </button>
      )}
      <div className="min-w-0 flex-1 text-sm">
        {errand.body.trim() ? (
          <details>
            <summary>{title}</summary>
            <div className={BODY}>
              <QuestMarkdown>{errand.body}</QuestMarkdown>
            </div>
          </details>
        ) : (
          title
        )}
        <SourceLine errand={errand} now={now} {...known} />
      </div>
      {onState && (
        <span className="opacity-0 focus-within:opacity-100 group-hover:opacity-100">
          <button
            type="button"
            aria-label={`Dismiss: ${errand.title}`}
            title="Dismiss"
            onClick={() => onState(errand.id, 'dismissed')}
            className="mt-1 inline-flex shrink-0 items-center justify-center self-start rounded p-0.5 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
          >
            <Icon name="errandDismiss" size={16} />
          </button>
        </span>
      )}
    </li>
  );
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
}: Omit<RowProps, 'onState'> & { errand: Errand; age?: boolean }) {
  const source = errandSource(errand, { sessions, patrols });
  const { icon } = SOURCE_LOOKS[source.kind];
  const label =
    source.kind === 'quest'
      ? source.label
      : source.kind === 'patrol'
        ? `${w('patrol')}: ${source.name}`
        : 'Written by you';
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
    short: 'Quest',
    tile: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-200',
  },
  patrol: {
    icon: 'errandPatrol',
    short: 'Patrol',
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

function ErrandCard({ errand, now, onState, ...known }: RowProps & { errand: Errand }) {
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
          {onState && (
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
        {errand.body.trim() && (
          <div className="max-h-44 overflow-hidden">
            <div className={BODY}>
              <QuestMarkdown>{errand.body}</QuestMarkdown>
            </div>
          </div>
        )}
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
    <details className="mx-3 mt-1 text-sm">
      <summary className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-xs font-bold text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-900">
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
