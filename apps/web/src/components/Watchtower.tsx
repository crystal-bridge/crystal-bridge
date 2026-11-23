import type { Engine, ListedPatrol, PatrolManifest, PatrolRun, Project, Schedule } from '@crystal-bridge/protocol';
import { useEffect, useRef, useState } from 'react';
import { scheduleText } from '../format.js';
import { scheduleWords, type PatrolSeed } from '../patrolForm.js';
import {
  browserZone,
  patrolStanding,
  runTime as when,
  untilText,
  type PatrolStanding,
  type PatrolsState,
} from '../patrols.js';
import { Icon, type IconName } from '../theme/icons.js';
import { hint, patrolOutcomeWord, patrolStandingWord, w } from '../theme/words.js';
import { PatrolForm } from './PatrolForm.js';

type Change = 'pause' | 'resume' | 'delete';

export interface WatchtowerProps {
  state: PatrolsState;
  now: number;
  /** Without these the Watchtower is read-only, as on the phone (its actions need their own design there). */
  onRun?: ((patrol: string) => Promise<void> | void) | undefined;
  onChange?: ((patrol: string, op: Change) => Promise<void> | void) | undefined;
  onOpenQuest?: ((session: string) => void) | undefined;
  /** The browser's time zone, for tests; a schedule in another zone says which. */
  zone?: string;
  /**
   * With both, a Kingdom that takes Patrols from the app (`editable`) offers New Patrol and Edit on its Quest Patrols.
   * A script Patrol is only ever written on its Kingdom.
   */
  onSave?: ((patrol: string, manifest: PatrolManifest) => Promise<void>) | undefined;
  onPreview?: ((schedule: Schedule, signal: AbortSignal) => Promise<number[]>) | undefined;
  /** A Board item's draft ("Patrol this"): New Patrol opens from it, and `onSeedUsed` lets it go when the form closes. */
  seed?: PatrolSeed | undefined;
  onSeedUsed?: (() => void) | undefined;
  /** The Kingdom's projects and engines, for the form. */
  projects?: Project[];
  engines?: Engine[] | undefined;
  /** A script run asked for from the Deeds feed: that Patrol's runs open, scrolled to the run. */
  focus?: { patrol: string; run: string } | undefined;
}

/** The card's left stripe and its standing word's colour. Blue stays for "someone is waiting on you". */
const LOOK: Record<PatrolStanding, { stripe: string; text: string }> = {
  broken: { stripe: 'border-l-red-500', text: 'text-red-700 dark:text-red-400' },
  'stood-down': { stripe: 'border-l-amber-500', text: 'text-amber-800 dark:text-amber-300' },
  out: { stripe: 'border-l-amber-400', text: 'text-amber-700 dark:text-amber-300' },
  waiting: { stripe: 'border-l-blue-600', text: 'text-blue-700 dark:text-blue-300' },
  failing: { stripe: 'border-l-red-500', text: 'text-red-700 dark:text-red-400' },
  'on-watch': { stripe: 'border-l-emerald-500', text: 'text-emerald-700 dark:text-emerald-400' },
};

/** Each outcome's dot, icon and text colour; an outcome a newer Kingdom sends gets the neutral one. */
const OUTCOME: Record<string, { dot: string; icon: IconName; text: string }> = {
  running: {
    dot: 'bg-amber-400 ring-2 ring-amber-200 motion-safe:animate-pulse dark:ring-amber-700',
    icon: 'markRunning',
    text: 'text-amber-700 dark:text-amber-300',
  },
  finished: { dot: 'bg-emerald-500', icon: 'markSealCheck', text: 'text-emerald-700 dark:text-emerald-400' },
  failed: { dot: 'bg-red-500', icon: 'markXCircle', text: 'text-red-700 dark:text-red-400' },
  'needs-you': { dot: 'bg-blue-600', icon: 'markHand', text: 'text-blue-700 dark:text-blue-300' },
  'timed-out': { dot: 'bg-orange-500', icon: 'markHourglass', text: 'text-orange-700 dark:text-orange-400' },
  skipped: {
    dot: 'bg-neutral-300 dark:bg-neutral-600',
    icon: 'markClock',
    text: 'text-neutral-600 dark:text-neutral-400',
  },
  missed: {
    dot: 'ring-2 ring-inset ring-neutral-400',
    icon: 'markWarning',
    text: 'text-neutral-600 dark:text-neutral-400',
  },
};
export const outcomeLook = (outcome: string) => OUTCOME[outcome] ?? OUTCOME.skipped!;

const DOTS = 16;
const button =
  'inline-flex items-center gap-1 rounded border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800';

function took(run: PatrolRun): string | undefined {
  if (run.finishedAt === undefined) return undefined;
  const seconds = Math.round((run.finishedAt - run.startedAt) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function Outcome({ run }: { run: PatrolRun }) {
  const word = patrolOutcomeWord(run.outcome);
  const look = outcomeLook(run.outcome);
  return (
    <span className={`inline-flex items-center gap-1 ${look.text}`} title={word.plain}>
      <Icon name={look.icon} size={14} />
      {word.themed}
    </span>
  );
}

/** The latest runs as dots, oldest on the left, padded so every card's row lines up. */
function RunDots({ runs, zone }: { runs: readonly PatrolRun[]; zone: string }) {
  const shown = runs.slice(0, DOTS).reverse();
  return (
    <span className="inline-flex items-center gap-1" aria-hidden="true">
      {Array.from({ length: DOTS - shown.length }, (_, index) => (
        <span key={`empty-${index}`} className="size-2.5 rounded-full bg-neutral-100 dark:bg-neutral-800" />
      ))}
      {shown.map((run) => (
        <span
          key={run.id}
          title={`${patrolOutcomeWord(run.outcome).themed} · ${when(run.startedAt, zone)}${run.reason ? ` · ${run.reason}` : ''}`}
          className={`size-2.5 rounded-full ${outcomeLook(run.outcome).dot}`}
        />
      ))}
    </span>
  );
}

function Runs({
  name,
  runs,
  zone,
  onOpenQuest,
  focusRun,
}: {
  name: string;
  runs: readonly PatrolRun[];
  zone: string;
  focusRun?: string | undefined;
  onOpenQuest?: ((session: string) => void) | undefined;
}) {
  const panel = useRef<HTMLElement>(null);
  // It opens below every card, so on a phone's single column it may start off-screen: bring it into view.
  useEffect(() => {
    const row = focusRun ? panel.current?.querySelector(`[id="patrol-run-${focusRun}"]`) : null;
    (row ?? panel.current)?.scrollIntoView?.({ block: row ? 'center' : 'nearest', behavior: 'smooth' });
  }, [name, focusRun]);
  return (
    <section
      ref={panel}
      aria-label={`${name} runs`}
      className="rounded border border-neutral-300 p-3 dark:border-neutral-700"
    >
      <h3 className="mb-1 font-medium">{`${name}: runs`}</h3>
      {runs.length === 0 ? (
        <p className="text-sm text-neutral-500">No runs yet.</p>
      ) : (
        <ul className="divide-y divide-neutral-200 text-sm dark:divide-neutral-800">
          {runs.map((run) => (
            <li
              key={run.id}
              id={`patrol-run-${run.id}`}
              className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-1.5"
            >
              <span className="w-40 shrink-0 text-neutral-500 tabular-nums">{when(run.startedAt, zone)}</span>
              <span className="w-36 shrink-0">
                <Outcome run={run} />
              </span>
              <span className="w-24 shrink-0 text-neutral-500">
                {run.trigger === 'now' ? 'Run now' : run.trigger === 'catch-up' ? 'Caught up' : ''}
                {took(run) ? ` ${took(run)}` : ''}
              </span>
              <span className="min-w-0 flex-1 text-neutral-700 dark:text-neutral-300">
                {run.reason}
                {run.exitCode !== undefined && run.outcome !== 'finished' && !run.reason && `exit code ${run.exitCode}`}
              </span>
              {run.session && onOpenQuest && (
                <button type="button" className="text-xs underline" onClick={() => onOpenQuest(run.session!)}>
                  {`Open ${w('quest')}`}
                </button>
              )}
              {(run.stdout || run.stderr) && (
                <details className="basis-full">
                  <summary className="cursor-pointer text-xs underline">Output</summary>
                  {run.stdout && (
                    <pre className="mt-1 max-h-60 overflow-auto rounded bg-neutral-100 p-2 text-xs whitespace-pre-wrap dark:bg-neutral-900">
                      {run.stdout}
                    </pre>
                  )}
                  {run.stderr && (
                    <pre className="mt-1 max-h-60 overflow-auto rounded bg-red-50 p-2 text-xs whitespace-pre-wrap dark:bg-red-950">
                      {run.stderr}
                    </pre>
                  )}
                </details>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function SentryCard({
  patrol,
  runs,
  now,
  zone,
  open,
  onToggle,
  onRun,
  onChange,
  onEdit,
}: {
  patrol: ListedPatrol;
  runs: readonly PatrolRun[];
  now: number;
  zone: string;
  open: boolean;
  onToggle: () => void;
  onRun?: WatchtowerProps['onRun'];
  onChange?: WatchtowerProps['onChange'];
  onEdit?: (() => void) | undefined;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const { manifest } = patrol;
  const name = manifest?.name ?? patrol.id;
  const standing = patrolStanding(patrol, runs);
  const standingWord = patrolStandingWord(standing);
  const look = LOOK[standing];
  const last = runs[0] ?? patrol.lastRun;
  const script = manifest?.script !== undefined;
  const next = patrol.paused ? undefined : patrol.nextRunAt;

  async function act(action: () => Promise<void> | void) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <li
      aria-label={name}
      className={`flex flex-col gap-2 rounded border border-l-4 border-neutral-300 p-3 dark:border-neutral-700 ${look.stripe}`}
    >
      <div className="flex items-start gap-3">
        <span
          title={script ? `Script ${w('patrol')}: written on the ${w('kingdom')}` : `${w('quest')} ${w('patrol')}`}
          className={`inline-flex size-8 shrink-0 items-center justify-center rounded ${script ? 'bg-teal-100 text-teal-700 dark:bg-teal-950 dark:text-teal-300' : 'bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300'}`}
        >
          <Icon name={script ? 'scrollUnfurled' : 'treasureMap'} size={22} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{name}</div>
          {manifest && (
            <div className="truncate text-xs text-neutral-500" title={scheduleText(manifest.schedule)}>
              {manifest.schedule.timezone === zone
                ? scheduleWords(manifest.schedule)
                : `${scheduleWords(manifest.schedule)} (${manifest.schedule.timezone})`}
            </div>
          )}
        </div>
        <span className={`shrink-0 text-xs font-bold ${look.text}`} title={standingWord.plain}>
          {standingWord.themed}
        </span>
      </div>

      <div className="flex items-end justify-between gap-2">
        <div>
          <div className="text-xs text-neutral-500">{w('nextRun')}</div>
          <div className="cb-display text-3xl leading-none">
            {next === undefined ? '—' : untilText(next, now).replace(/^in /, '')}
          </div>
          {next !== undefined && <div className="text-xs text-neutral-500">{when(next, zone)}</div>}
        </div>
        <div className="text-right text-sm">
          {last ? <Outcome run={last} /> : <span className="text-neutral-500">No runs yet</span>}
          {last && <div className="text-xs text-neutral-500">{when(last.startedAt, zone)}</div>}
        </div>
      </div>

      <RunDots runs={runs} zone={zone} />

      {patrol.error && (
        <p className="flex gap-1 text-xs text-amber-800 dark:text-amber-300">
          <Icon name="markWarning" size={14} />
          <span>
            {manifest ? `patrol.json doesn’t load, so its last good one runs: ${patrol.error}` : patrol.error}
          </span>
        </p>
      )}
      {patrol.paused && (
        <p className="flex gap-1 text-xs text-amber-800 dark:text-amber-300">
          <Icon name="campfire" size={14} />
          <span>{patrol.paused}</span>
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}

      <div className="mt-auto flex flex-wrap items-center justify-between gap-2">
        <button type="button" className="text-xs underline" aria-expanded={open} onClick={onToggle}>
          {open ? 'Hide runs' : 'Runs'}
        </button>
        {(onRun || onChange || onEdit) && (
          <span className="flex flex-wrap items-center gap-1">
            {onEdit && (
              <button type="button" className={button} disabled={busy} onClick={onEdit}>
                <Icon name="quillInk" size={14} /> Edit
              </button>
            )}
            {onRun && manifest && (
              <button
                type="button"
                className={button}
                disabled={busy}
                title="Send it out now, outside its schedule"
                onClick={() => void act(() => onRun(patrol.id))}
              >
                <Icon name="rocket" size={14} /> Run now
              </button>
            )}
            {onChange && manifest && (
              <button
                type="button"
                className={button}
                disabled={busy}
                onClick={() => void act(() => onChange(patrol.id, patrol.paused ? 'resume' : 'pause'))}
              >
                <Icon name={patrol.paused ? 'bugleCall' : 'campfire'} size={14} /> {patrol.paused ? 'Resume' : 'Pause'}
              </button>
            )}
            {onChange &&
              (confirming ? (
                <>
                  <button
                    type="button"
                    className={`${button} border-red-400 text-red-700 dark:border-red-700 dark:text-red-300`}
                    disabled={busy}
                    aria-label={`Delete ${name} for good`}
                    title="Its Kingdom moves the folder into .deleted/, so nothing written there is lost"
                    onClick={() => void act(() => onChange(patrol.id, 'delete'))}
                  >
                    <Icon name="trashCan" size={14} /> Delete it
                  </button>
                  <button type="button" className={button} onClick={() => setConfirming(false)}>
                    Keep
                  </button>
                </>
              ) : (
                <button type="button" className={button} disabled={busy} onClick={() => setConfirming(true)}>
                  <Icon name="trashCan" size={14} /> Delete
                </button>
              ))}
          </span>
        )}
      </div>
    </li>
  );
}

/** The Castle's panel of a Kingdom's Patrols (docs/PATROLS.md): a card each, and one Patrol's runs or its form below. */
export function Watchtower({
  state,
  now,
  onRun,
  onChange,
  onOpenQuest,
  zone = browserZone(),
  onSave,
  onPreview,
  projects = [],
  engines,
  seed,
  onSeedUsed,
  focus,
}: WatchtowerProps) {
  const [open, setOpen] = useState<string | null>(null);
  /** The Patrol being edited, or `new` for New Patrol. Ids can't hold a space, so the two never meet. */
  const [editing, setEditing] = useState<string | null>(seed ? NEW : null);
  // A Board item's draft, taken from the app as it arrives so it opens the form once; counted, so a second draft with
  // the same name still gets a fresh form.
  const [seeded, setSeeded] = useState<{ seed: PatrolSeed; count: number } | null>(null);
  const canEdit = state.editable && onSave !== undefined && onPreview !== undefined;
  useEffect(() => {
    if (!seed) return;
    setSeeded((last) => ({ seed, count: (last?.count ?? 0) + 1 }));
    setOpen(null);
    setEditing(NEW);
    onSeedUsed?.();
  }, [seed, onSeedUsed]);
  useEffect(() => {
    if (!focus) return;
    setEditing(null);
    setOpen(focus.patrol);
  }, [focus]);
  const close = () => {
    setEditing(null);
    setSeeded(null);
  };
  // Hidden until there's a Patrol, as Boards are until there's a Scout, unless one can be made here.
  if (!state.loaded || (state.patrols.length === 0 && !canEdit)) return null;
  const shown = state.patrols.find((patrol) => patrol.id === open);
  const edited = editing === NEW ? undefined : state.patrols.find((patrol) => patrol.id === editing);
  const formOpen = canEdit && (editing === NEW || edited?.manifest?.quest !== undefined);
  const toggleRuns = (id: string) => {
    setEditing(null);
    setOpen(open === id ? null : id);
  };
  const edit = (id: string) => {
    setOpen(null);
    setEditing(id);
  };
  return (
    <section aria-label={w('watchtower')} className="space-y-2">
      <div className="flex items-center justify-between gap-2 px-3">
        <h2 className="cb-display text-2xl leading-none" title={hint('watchtower')}>
          {w('watchtower')}
        </h2>
        {canEdit && (
          <button type="button" className={button} disabled={editing === NEW} onClick={() => edit(NEW)}>
            <Icon name="treasureMap" size={14} /> {`New ${w('patrol')}`}
          </button>
        )}
      </div>
      <div className="space-y-3 px-3">
        {state.patrols.length === 0 && !formOpen && (
          <p className="text-sm text-neutral-500">{`No ${w('patrols')} yet: they run a ${w('quest')} on a schedule.`}</p>
        )}
        {state.patrols.length > 0 && (
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,22rem),1fr))] gap-3">
            {state.patrols.map((patrol) => (
              <SentryCard
                key={patrol.id}
                patrol={patrol}
                runs={state.runs[patrol.id] ?? []}
                now={now}
                zone={zone}
                open={open === patrol.id}
                onToggle={() => toggleRuns(patrol.id)}
                onRun={onRun}
                onChange={onChange}
                onEdit={canEdit && patrol.manifest?.quest ? () => edit(patrol.id) : undefined}
              />
            ))}
          </ul>
        )}
        {formOpen && (
          <PatrolForm
            key={editing === NEW && seeded ? `${NEW}:${seeded.count}` : (editing ?? NEW)}
            patrol={edited}
            seed={editing === NEW ? (seed ?? seeded?.seed) : undefined}
            taken={state.patrols.map((patrol) => patrol.id)}
            projects={projects}
            engines={engines}
            now={now}
            zone={zone}
            onPreview={onPreview!}
            onSave={onSave!}
            onClose={close}
          />
        )}
        {shown && (
          <Runs
            name={shown.manifest?.name ?? shown.id}
            runs={state.runs[shown.id] ?? []}
            zone={zone}
            onOpenQuest={onOpenQuest}
            focusRun={focus?.patrol === shown.id ? focus.run : undefined}
          />
        )}
      </div>
    </section>
  );
}

const NEW = 'new patrol';
