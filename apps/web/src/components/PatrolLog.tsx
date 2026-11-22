import type { ListedPatrol } from '@crystal-bridge/protocol';
import { useState } from 'react';
import { untilText, type BoardReport } from '../patrols.js';
import { Icon } from '../theme/icons.js';
import { errandsLeftPhrase, hint, patrolOutcomeWord, patrolStandingWord, w } from '../theme/words.js';
import { agoText } from './HomeParts.js';
import { outcomeLook } from './Watchtower.js';

/** What a Board does with the Patrols that post to it (docs/PATROLS.md, Post to a Board). */
export interface BoardPatrolsProps {
  /** The Patrols naming this Board, in their Kingdom's order. */
  patrols: ListedPatrol[];
  /** Their reports, newest first (`boardPatrols` in patrols.ts). */
  reports: BoardReport[];
  /** Sends a Patrol out again now; rejects with the hub's reason. */
  onRun: (patrol: string) => Promise<void> | void;
  /** Marks a report done, or not done again; rejects with the hub's reason. */
  onMark: (patrol: string, run: string, done: boolean) => Promise<void> | void;
  /** How many Errands each Quest left (`errandsBySession` in errands.ts), to say so on its run's report. */
  errandsBySession?: Record<string, number> | undefined;
}

const button =
  'inline-flex items-center gap-1 rounded border border-neutral-300 bg-white/70 px-2 py-1 text-xs hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900/70 dark:hover:bg-neutral-800';

/** The banner's line beside the Scout's schedule: when each Patrol sets out next. */
export function PatrolsNext({ patrols, now }: { patrols: readonly ListedPatrol[]; now: number }) {
  if (patrols.length === 0) return null;
  return (
    <span className="block" title={hint('patrols')}>
      {`${w('patrols')}: `}
      {patrols.map((patrol, index) => (
        <span key={patrol.id}>
          {index > 0 && ' · '}
          <span className="text-neutral-700 dark:text-neutral-300">{patrol.manifest?.name ?? patrol.id}</span>{' '}
          {patrol.paused ? (
            <span className="text-amber-800 dark:text-amber-300" title={patrol.paused}>
              {patrolStandingWord('stood-down').themed}
            </span>
          ) : patrol.error || !patrol.manifest ? (
            // A schedule its Kingdom can't follow has no next run either; that's not the same as one that has ended.
            <span className="text-red-700 dark:text-red-400" title={patrol.error}>
              {patrolStandingWord('broken').themed}
            </span>
          ) : patrol.nextRunAt !== undefined ? (
            `next ${untilText(patrol.nextRunAt, now)}`
          ) : (
            'no more runs'
          )}
        </span>
      ))}
    </span>
  );
}

function Entry({
  report,
  now,
  act,
  onRun,
  onMark,
  onOpenQuest,
  patrolOut,
  errandCount,
}: {
  report: BoardReport;
  now: number;
  act: (work: () => Promise<void> | void) => Promise<void>;
  onOpenQuest: (session: string) => void;
  /** The Patrol has a run out now: running it again would only be skipped. */
  patrolOut: boolean;
  /** How many Errands the run's Quest left. */
  errandCount: number;
} & Pick<BoardPatrolsProps, 'onRun' | 'onMark'>) {
  const { patrol, run } = report;
  const name = patrol.manifest?.name ?? patrol.id;
  const [output, setOutput] = useState(false);
  const [asking, setAsking] = useState(false);
  const again = () => {
    setAsking(true);
    void act(() => onRun(patrol.id)).finally(() => setAsking(false));
  };
  const look = outcomeLook(run.outcome);
  const word = patrolOutcomeWord(run.outcome);
  const done = run.doneAt !== undefined;
  const out = run.outcome === 'running';
  const hasOutput = Boolean(run.stdout || run.stderr);
  return (
    <li className={`relative ${done ? 'opacity-75' : ''}`}>
      <span
        aria-hidden="true"
        className={`absolute -left-[1.6rem] mt-0.5 flex size-4.5 items-center justify-center rounded-full bg-white dark:bg-neutral-900 ${look.text}`}
      >
        <Icon name={look.icon} size={16} />
      </span>
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 truncate font-semibold">{name}</span>
        <span className="shrink-0 text-xs text-neutral-500" title={new Date(run.startedAt).toLocaleString()}>
          {agoText(run.startedAt, now)}
        </span>
      </div>
      <p className={`text-xs font-semibold ${look.text}`} title={word.plain}>
        {word.themed}
        {run.trigger === 'now' ? ' · run now' : run.trigger === 'catch-up' ? ' · caught up' : ''}
      </p>
      {errandCount > 0 && (
        <p className="flex items-center gap-1 text-xs font-semibold text-teal-700 dark:text-teal-300">
          <Icon name="errands" size={13} />
          {errandsLeftPhrase(errandCount)}
        </p>
      )}
      {run.summary && <p className="text-sm break-words">{run.summary}</p>}
      {run.reason && (!run.summary || run.outcome !== 'finished') && (
        <p className="text-xs text-neutral-600 dark:text-neutral-400">{run.reason}</p>
      )}
      <div className="mt-1 flex flex-wrap gap-1">
        {run.session && (
          <button
            type="button"
            className={button}
            aria-label={`Open ${w('quest')}: ${name}`}
            onClick={() => onOpenQuest(run.session!)}
          >
            <Icon name="portal" size={13} /> {`Open ${w('quest')}`}
          </button>
        )}
        {hasOutput && (
          <button
            type="button"
            className={button}
            aria-label={`Output: ${name}`}
            aria-expanded={output}
            onClick={() => setOutput((shown) => !shown)}
          >
            <Icon name="scrollUnfurled" size={13} /> Output
          </button>
        )}
        {!done && !patrolOut && (
          <button type="button" className={button} aria-label={`Run again: ${name}`} disabled={asking} onClick={again}>
            <Icon name="cycle" size={13} /> Run again
          </button>
        )}
        {!done && !out && (
          <button
            type="button"
            className={button}
            aria-label={`Done: ${name}`}
            onClick={() => void act(() => onMark(patrol.id, run.id, true))}
          >
            <Icon name="markSealCheck" size={13} /> Done
          </button>
        )}
        {done && (
          <button
            type="button"
            className={button}
            aria-label={`Not done: ${name}`}
            onClick={() => void act(() => onMark(patrol.id, run.id, false))}
          >
            <Icon name="cycle" size={13} /> Not done
          </button>
        )}
      </div>
      {output && (
        <div className="mt-1 space-y-1">
          {run.stdout && (
            <pre className="max-h-48 overflow-auto rounded bg-neutral-100 p-2 text-xs whitespace-pre-wrap dark:bg-neutral-900">
              {run.stdout}
            </pre>
          )}
          {run.stderr && (
            <pre className="max-h-48 overflow-auto rounded bg-red-50 p-2 text-xs whitespace-pre-wrap dark:bg-red-950">
              {run.stderr}
            </pre>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * The reports a Board's Patrols posted, as a timeline beside the list (the owner's pick from the audition, layout B).
 * Each says how the run ended and, in its summary, what the work came to.
 */
export function PatrolLog({
  patrols,
  reports,
  onRun,
  onMark,
  onOpenQuest,
  errandsBySession,
  now,
}: BoardPatrolsProps & { onOpenQuest: (session: string) => void; now: number }) {
  const [error, setError] = useState<string | null>(null);
  const act = (work: () => Promise<void> | void): Promise<void> => {
    setError(null);
    const failed = (failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure));
    try {
      return Promise.resolve(work()).catch(failed);
    } catch (failure) {
      failed(failure);
      return Promise.resolve();
    }
  };
  if (patrols.length === 0) return null;
  // Patrols with a run out now, from their latest reports.
  const out = new Set(
    patrols
      .filter(
        (patrol) =>
          (reports.find((report) => report.patrol.id === patrol.id)?.run ?? patrol.lastRun)?.outcome === 'running',
      )
      .map((patrol) => patrol.id),
  );
  return (
    <section
      aria-label={w('patrolLog')}
      className="rounded-lg border border-neutral-200 bg-linear-to-b from-amber-50/70 to-white p-3 dark:border-neutral-800 dark:from-amber-950/30 dark:to-neutral-900"
    >
      <h2 className="cb-display mb-2 flex items-center gap-2 text-2xl leading-none" title={hint('patrolLog')}>
        <Icon name="scrollUnfurled" size={20} /> {w('patrolLog')}
      </h2>
      {error && (
        <p role="alert" className="mb-2 text-sm whitespace-pre-wrap text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      {reports.length === 0 ? (
        <p className="text-sm text-neutral-500">{`No reports yet. Each ${w('patrol')} posts one here when it’s back.`}</p>
      ) : (
        <ol className="ml-2 space-y-3 border-l-2 border-neutral-200 pl-4 dark:border-neutral-700">
          {reports.map((report) => (
            <Entry
              key={report.run.id}
              report={report}
              now={now}
              act={act}
              onRun={onRun}
              onMark={onMark}
              onOpenQuest={onOpenQuest}
              patrolOut={out.has(report.patrol.id)}
              errandCount={(report.run.session && errandsBySession?.[report.run.session]) || 0}
            />
          ))}
        </ol>
      )}
    </section>
  );
}
