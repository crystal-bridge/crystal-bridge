import { type CSSProperties, type ReactNode, useState } from 'react';
import type { BoardItem, BoardItemState, BoardQuest, ScoutManifest } from '@crystal-bridge/protocol';
import { actionsFor } from '../boards.js';
import { useFolded } from '../boardPrefs.js';
import {
  FOLD_AT,
  needsYou,
  type ProjectSection,
  projectSections,
  projectOf,
  rowLook,
  visibleRows,
} from '../projects.js';
import { markIcon } from '../theme/boardIcons.js';
import { markToneClass, PROJECT_CLASSES, projectTone, SENDER_CLASSES, toneChipClass } from '../theme/boardTones.js';
import { Icon, type IconName } from '../theme/icons.js';
import {
  Avatar,
  type ButtonLook,
  ItemActions,
  itemNote,
  monogram,
  NewMark,
  QuestAllButton,
  QuestComposer,
  questBatch,
  ROW_TOOLS,
  SourceMark,
  titleNote,
} from './BoardParts.js';
import { ago } from './HomeParts.js';

/**
 * The `projects` Board view (docs/SCOUTS.md): a card per project, its rows drawn from the Scout's looks, beside the
 * Needs-you window, which takes Counsel's place. What the Scout's fields mean lives in `scout.json`; this draws slots.
 */

type Look = NonNullable<ScoutManifest['projects']>;
type ScoutLook = NonNullable<Look['kind']>['values'][string];

export interface ProjectsViewProps {
  /** The Board's open items. */
  items: readonly BoardItem[];
  manifest: ScoutManifest;
  look: Look;
  now: number;
  /** The Kingdom and Scout, which key this device's folds. */
  node: string;
  scout: string;
  isMarked: (item: BoardItem) => boolean;
  act: (ids: string[], state: BoardItemState, until?: number) => void;
  perform: (key: string, ids: string[]) => Promise<void>;
  /** Starts a Quest the user wrote; without it, no "Quest on all". */
  start?: (ask: BoardQuest) => Promise<void>;
  /** What shows when nothing is open. */
  empty: ReactNode;
  /** The folded sections under the projects: Snoozed, Set aside, Gone, Recent runs. */
  past: ReactNode;
}

/** A look's icon in its tone, named by its label; a look with no known icon draws a dot. */
function LookIcon({ look, size = 16 }: { look: ScoutLook; size?: number }) {
  const icon = markIcon(look.icon);
  const named = look.label !== undefined ? { role: 'img', 'aria-label': look.label, title: look.label } : {};
  return (
    <span
      {...named}
      {...(look.label === undefined ? { 'aria-hidden': true } : {})}
      className={`inline-flex shrink-0 items-center justify-center ${markToneClass(look.tone)}`}
    >
      {icon ? (
        <Icon name={icon} size={size} />
      ) : (
        <span className="h-2 w-2 rounded-full bg-current" style={{ margin: (size - 8) / 2 }} />
      )}
    </span>
  );
}

/** A chip saying why an item is here: the reason's icon and words in its tone. */
function ReasonChip({ look }: { look: ScoutLook }) {
  const icon = markIcon(look.icon);
  return (
    <span
      data-reason
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-md px-2 py-0.5 text-[11.5px] font-bold ring-1 ${toneChipClass(look.tone)}`}
    >
      {icon && <Icon name={icon} size={14} />}
      {look.label}
    </span>
  );
}

/** A label tinted from its own colour, readable in both themes. */
function LabelPill({ name, color }: { name: string; color: string }) {
  return (
    <span
      style={
        {
          '--l': color,
          backgroundColor: `color-mix(in srgb, ${color} 16%, transparent)`,
          borderColor: `color-mix(in srgb, ${color} 55%, transparent)`,
        } as CSSProperties
      }
      className="inline-flex items-center whitespace-nowrap rounded-full border px-[7px] py-[3px] text-[11px] leading-none text-[color-mix(in_srgb,var(--l)_55%,black)] dark:text-[color-mix(in_srgb,var(--l)_65%,white)]"
    >
      {name}
    </span>
  );
}

/** A count of a section's items by the kind's drawing (so a pull request and a draft count together). */
interface KindCount {
  icon: IconName | undefined;
  look: ScoutLook;
  count: number;
  /** The kinds' labels and counts, for the tooltip. */
  parts: { label: string; count: number }[];
}

function kindCounts(items: readonly BoardItem[], look: Look): KindCount[] {
  const counts = new Map<string, KindCount>();
  for (const item of items) {
    const kind = rowLook(item, look).kind;
    if (!kind) continue;
    const icon = markIcon(kind.icon);
    const key = icon ?? `look:${kind.icon ?? ''}:${kind.tone ?? ''}`;
    const entry = counts.get(key) ?? { icon, look: kind, count: 0, parts: [] };
    entry.count += 1;
    const label = kind.label ?? '';
    const part = entry.parts.find((one) => one.label === label);
    if (part) part.count += 1;
    else entry.parts.push({ label, count: 1 });
    counts.set(key, entry);
  }
  // In the order the Scout lists its kinds.
  const order = Object.values(look.kind?.values ?? {});
  return [...counts.values()].sort((a, b) => order.indexOf(a.look) - order.indexOf(b.look));
}

const countTitle = (parts: { label: string; count: number }[]): string =>
  parts.map(({ label, count }) => `${count} ${label}`.trim()).join(', ');

/** A thin bar of a section's health: items with a red mark, then the rest by kind, each in its tone. */
function HealthBar({ items, look }: { items: readonly BoardItem[]; look: Look }) {
  const failing = items.filter((item) => rowLook(item, look).marks.some((mark) => mark.look.tone === 'red'));
  const rest = items.filter((item) => !failing.includes(item));
  const segments: { tone: string | undefined; count: number; title: string }[] = [];
  if (failing.length > 0) segments.push({ tone: 'red', count: failing.length, title: `${failing.length} failing` });
  let counted = failing.length;
  for (const kind of kindCounts(rest, look)) {
    segments.push({ tone: kind.look.tone, count: kind.count, title: countTitle(kind.parts) });
    counted += kind.count;
  }
  const other = items.length - counted;
  if (other > 0) segments.push({ tone: undefined, count: other, title: `${other} other` });
  const title = segments.map((segment) => segment.title).join(' · ');
  return (
    <span
      role="img"
      aria-label={title}
      title={title}
      className="flex h-1.5 w-[90px] shrink-0 overflow-hidden rounded-sm bg-neutral-200 dark:bg-neutral-800"
    >
      {segments.map((segment, at) => (
        <span
          key={at}
          className={`h-full bg-current ${markToneClass(segment.tone)}`}
          style={{ width: `${(segment.count / items.length) * 100}%` }}
        />
      ))}
    </span>
  );
}

/** One item's row: kind, title with its reason, labels and size, then marks, comments, age and who. */
function ProjectRow({
  item,
  look,
  manifest,
  now,
  marked,
  act,
  perform,
}: {
  item: BoardItem;
  look: Look;
  manifest: ScoutManifest;
  now: number;
  marked: boolean;
  act: ProjectsViewProps['act'];
  perform: ProjectsViewProps['perform'];
}) {
  const row = rowLook(item, look);
  return (
    <li
      {...(row.mine ? { 'data-mine': true } : {})}
      title={itemNote(item)}
      className={`group relative grid grid-cols-[22px_minmax(0,1fr)_auto] items-center gap-2.5 px-3.5 py-2 hover:bg-neutral-50 dark:hover:bg-neutral-800/50 ${row.mine ? 'shadow-[inset_3px_0_0_var(--color-gold)]' : ''}`}
    >
      <span className="flex justify-center">{row.kind && <LookIcon look={row.kind} size={18} />}</span>
      <span className="min-w-0">
        <span className="flex min-w-0 items-center gap-1.5">
          {item.url ? (
            <a
              href={item.url}
              target="_blank"
              rel="noopener noreferrer"
              title={titleNote(item)}
              className={`truncate hover:underline ${marked ? 'font-bold' : 'font-medium'}`}
            >
              {item.title}
            </a>
          ) : (
            <span title={titleNote(item)} className={`truncate ${marked ? 'font-bold' : 'font-medium'}`}>
              {item.title}
            </span>
          )}
          {marked && <NewMark />}
          <SourceMark item={item} />
        </span>
        {(row.reason || item.labels?.length || row.added !== undefined || row.removed !== undefined) && (
          <span className="mt-1 flex flex-wrap items-center gap-1.5">
            {row.reason && <ReasonChip look={row.reason} />}
            {item.labels?.map((label) => (
              <LabelPill key={label.name} name={label.name} color={label.color} />
            ))}
            {(row.added !== undefined || row.removed !== undefined) && (
              <span className="font-mono text-[11.5px]">
                {row.added !== undefined && (
                  <span className="text-emerald-700 dark:text-emerald-400">{`+${row.added}`}</span>
                )}
                {row.added !== undefined && row.removed !== undefined && ' '}
                {row.removed !== undefined && (
                  <span className="text-red-700 dark:text-red-400">{`−${row.removed}`}</span>
                )}
              </span>
            )}
          </span>
        )}
      </span>
      <span className="flex items-center gap-2.5 whitespace-nowrap text-xs text-neutral-500">
        {row.marks.map(({ field, look: mark }) => (
          <LookIcon key={field} look={mark} size={15} />
        ))}
        {row.comments !== undefined && row.comments > 0 && (
          <span
            title={`${row.comments} ${row.comments === 1 ? 'comment' : 'comments'}`}
            className="inline-flex items-center gap-1"
          >
            <Icon name="markChat" size={14} />
            {row.comments}
          </span>
        )}
        {row.when !== undefined && (
          <span className="tabular-nums" title={new Date(row.when).toLocaleString()}>
            {ago(row.when, now)}
          </span>
        )}
        {row.who !== undefined && <Avatar who={row.who} {...(row.whoKey ? { whoKey: row.whoKey } : {})} small named />}
      </span>
      {/* The item's buttons, out of the way until hover or focus, as on a mail-style Board. */}
      <span data-row-tools className={ROW_TOOLS}>
        <ItemActions item={item} manifest={manifest} now={now} act={act} perform={perform} />
      </span>
    </li>
  );
}

/** A project's card: a header in its colour with counts and health, then its rows, folded past eight. */
function ProjectCard({
  section,
  look,
  folded,
  onFold,
  expanded,
  onExpand,
  row,
}: {
  section: ProjectSection;
  look: Look;
  folded: boolean;
  onFold: () => void;
  expanded: boolean;
  onExpand: (expanded: boolean) => void;
  row: (item: BoardItem) => ReactNode;
}) {
  const { shown, hidden } = visibleRows(section.items, expanded);
  const short = section.name.split('/').pop() || section.name;
  return (
    <section
      aria-label={section.name}
      className="overflow-hidden rounded-xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900"
    >
      <div
        className={`flex items-center gap-2.5 border-b border-neutral-200 bg-linear-to-r to-transparent to-60% px-3.5 py-2.5 dark:border-neutral-800 ${PROJECT_CLASSES[section.tone].wash}`}
      >
        <span
          aria-hidden
          data-tone={section.tone}
          className={`cb-display grid h-[30px] w-[30px] shrink-0 place-items-center rounded-lg text-lg ring-1 ring-black/10 dark:ring-white/15 ${SENDER_CLASSES[section.tone].avatar}`}
        >
          {monogram(short)}
        </span>
        <div className="min-w-0">
          <h3 className="cb-display truncate text-[21px] leading-none">
            {section.url ? (
              <a href={section.url} target="_blank" rel="noopener noreferrer" className="hover:underline">
                {section.name}
              </a>
            ) : (
              section.name
            )}
          </h3>
          {(section.owned !== undefined || section.description) && (
            <p className="mt-0.5 flex min-w-0 items-center gap-1 text-[11px] text-neutral-500">
              {section.owned === true && (
                <span role="img" aria-label="Yours" title="Yours" className="text-gold">
                  <Icon name="markCrown" size={12} />
                </span>
              )}
              {section.owned === false && (
                <>
                  <span role="img" aria-label="You contribute" title="You contribute">
                    <Icon name="markHandshake" size={12} />
                  </span>
                  <span className="shrink-0">showing your items</span>
                  {section.description && <span aria-hidden>·</span>}
                </>
              )}
              {section.description && <span className="truncate">{section.description}</span>}
            </p>
          )}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-3 text-xs text-neutral-600 dark:text-neutral-400">
          {kindCounts(section.items, look).map((kind, at) => (
            <span key={at} title={countTitle(kind.parts)} className="inline-flex items-center gap-1">
              <span aria-hidden className={markToneClass(kind.look.tone)}>
                {kind.icon ? <Icon name={kind.icon} size={15} /> : '•'}
              </span>
              {kind.count}
            </span>
          ))}
          <HealthBar items={section.items} look={look} />
        </div>
        <button
          type="button"
          aria-expanded={!folded}
          aria-label={`${folded ? 'Unfold' : 'Fold'} ${section.name}`}
          title={folded ? 'Show its items' : 'Fold it away on this device'}
          onClick={onFold}
          className="rounded px-1.5 text-neutral-500 hover:bg-black/5 hover:text-neutral-950 dark:hover:bg-white/10 dark:hover:text-white"
        >
          <span aria-hidden>{folded ? '▸' : '▾'}</span>
        </button>
      </div>
      {!folded && (
        <>
          <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">{shown.map(row)}</ul>
          {section.items.length > FOLD_AT && (
            <button
              type="button"
              onClick={() => onExpand(hidden > 0)}
              className="w-full border-t border-neutral-100 px-3.5 py-1.5 text-left text-xs text-sky-700 hover:bg-neutral-50 dark:border-neutral-800 dark:text-sky-400 dark:hover:bg-neutral-800/50"
            >
              {hidden > 0 ? `Show ${hidden} more` : 'Show fewer'}
            </button>
          )}
        </>
      )}
    </section>
  );
}

/** Classes for buttons inside the blue window: the suggested one in the reason's tone, the rest ghosts. */
const ghost =
  'cb-display rounded border border-white/30 px-2.5 text-base leading-6 text-white/85 hover:bg-white/10 disabled:opacity-50';

/** What needs you, in the blue window that means it: a card per item with its reason, why, and what to press. */
function NeedsYou({
  items,
  open,
  look,
  manifest,
  now,
  act,
  perform,
  start,
}: {
  items: readonly BoardItem[];
  open: readonly BoardItem[];
  look: Look;
  manifest: ScoutManifest;
  now: number;
  act: ProjectsViewProps['act'];
  perform: ProjectsViewProps['perform'];
  start?: ProjectsViewProps['start'];
}) {
  const [composing, setComposing] = useState<BoardItem[] | null>(null);
  if (items.length === 0) {
    return (
      <section aria-label="Needs you" className="rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
        <h2 className="cb-display text-[22px] leading-none">Needs you</h2>
        <p className="mt-1 text-sm text-neutral-500">Nothing needs you right now.</p>
      </section>
    );
  }
  const batch = questBatch(items);
  return (
    <section aria-label="Needs you" className="cb-window space-y-2 rounded-[10px] p-3">
      <div className="flex items-center gap-2">
        <h2 className="cb-display flex items-center gap-2 text-[22px] leading-none">
          <span className="text-gold-bright">
            <Icon name="markHand" size={20} />
          </span>
          Needs you
        </h2>
        <span className="cb-display text-base text-white/75">{items.length}</span>
        {start && !composing && (
          <span className="ml-auto">
            <QuestAllButton
              label={batch.label}
              what="what needs you here"
              onPress={() => setComposing(batch.best)}
              className="rounded border border-window-border bg-white/15 px-2 py-0.5 text-xs font-bold text-white hover:bg-white/25"
            />
          </span>
        )}
      </div>
      {start && composing && (
        // The composer keeps the page's own colours, so its fields read as they do everywhere.
        <div className="rounded-md bg-white text-neutral-950 dark:bg-neutral-950 dark:text-white">
          <QuestComposer
            key={composing.map((item) => item.id).join(' ')}
            items={composing}
            open={open}
            manifest={manifest}
            start={start}
            onClose={() => setComposing(null)}
          />
        </div>
      )}
      {items.map((item) => {
        const row = rowLook(item, look);
        const tone = projectTone(projectOf(item));
        const offered = actionsFor(item, manifest);
        // The suggested action, then Open and Later where the item offers them, as the item's own buttons do.
        const keys = [
          ...offered.filter(({ key }) => key === item.suggested),
          offered.find(({ key, action }) => action.kind === 'link' && key !== item.suggested),
          offered.find(({ key, action }) => action.kind === 'snooze' && key !== item.suggested),
        ].flatMap((found) => (found ? [found.key] : []));
        const buttons: ButtonLook = {
          suggested: `cb-display rounded px-2.5 text-base leading-6 ring-1 hover:brightness-105 disabled:opacity-50 ${toneChipClass(row.reason?.tone)}`,
          plain: ghost,
          row: 'mt-2 flex flex-wrap gap-1.5',
        };
        return (
          <article key={item.id} className="rounded-lg border border-white/20 bg-black/25 p-2.5">
            <div className="flex items-center justify-between gap-2">
              {row.reason && <ReasonChip look={row.reason} />}
              <span className="flex min-w-0 items-center gap-1.5 text-[11.5px] text-white/75">
                <span aria-hidden className={`h-2.5 w-2.5 shrink-0 rounded-[3px] ${PROJECT_CLASSES[tone].dot}`} />
                <span className="truncate">{projectOf(item)}</span>
              </span>
            </div>
            <div className="mt-1.5 flex items-start gap-2">
              {row.kind && (
                <span
                  className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded ring-1 ${toneChipClass(row.kind.tone)}`}
                >
                  <LookIcon look={{ ...row.kind, tone: undefined }} size={14} />
                </span>
              )}
              <div className="min-w-0">
                {item.url ? (
                  <a
                    href={item.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={titleNote(item)}
                    className="font-bold hover:underline"
                  >
                    {item.title}
                  </a>
                ) : (
                  <span className="font-bold" title={titleNote(item)}>
                    {item.title}
                  </span>
                )}
                {item.summary && <p className="mt-0.5 text-[12.5px] text-white/80">{item.summary}</p>}
              </div>
            </div>
            {keys.length > 0 && (
              <ItemActions
                item={{ ...item, actions: keys }}
                manifest={manifest}
                now={now}
                act={act}
                perform={perform}
                look={buttons}
              />
            )}
          </article>
        );
      })}
    </section>
  );
}

/** The projects view: its sections in two thirds of the page, the Needs-you window in the last, sticky beside them. */
export function ProjectsView({
  items,
  manifest,
  look,
  now,
  node,
  scout,
  isMarked,
  act,
  perform,
  start,
  empty,
  past,
}: ProjectsViewProps) {
  const [folded, toggle] = useFolded(node, scout);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const sections = projectSections(items, look);
  const needs = needsYou(items, look);
  const row = (item: BoardItem) => (
    <ProjectRow
      key={item.id}
      item={item}
      look={look}
      manifest={manifest}
      now={now}
      marked={isMarked(item)}
      act={act}
      perform={perform}
    />
  );
  return (
    <div className="grid gap-4 px-3 lg:grid-cols-3">
      <div className="min-w-0 space-y-4 lg:col-span-2">
        <section aria-label="Projects" className="space-y-3.5">
          {sections.length === 0
            ? empty
            : sections.map((section) => (
                <ProjectCard
                  key={section.name}
                  section={section}
                  look={look}
                  folded={folded.has(section.name)}
                  onFold={() => toggle(section.name)}
                  expanded={expanded.has(section.name)}
                  onExpand={(more) =>
                    setExpanded((all) => {
                      const next = new Set(all);
                      if (more) next.add(section.name);
                      else next.delete(section.name);
                      return next;
                    })
                  }
                  row={row}
                />
              ))}
        </section>
        {past}
      </div>
      <aside>
        <div className="lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto">
          <NeedsYou
            items={needs}
            open={items}
            look={look}
            manifest={manifest}
            now={now}
            act={act}
            perform={perform}
            {...(start ? { start } : {})}
          />
        </div>
      </aside>
    </div>
  );
}
