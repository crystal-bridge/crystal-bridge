import type { UsageWindow } from '@crystal-bridge/protocol';
import { type ReactNode, useContext, useEffect, useState } from 'react';
import type { Activity } from '../activity.js';
import { type HeroManifest, type HeroState, matchClass, QUIET_MS } from '../heroes.js';
import { FileOpenContext } from './markdown.js';
import type { SessionInfo } from '../info.js';
import { MODES } from '../modes.js';
import { type Concept, hint, stepWord, w } from '../theme/words.js';
import { HeroSprite } from './HeroSprite.js';
import { bytes, duration, tokens } from '../format.js';
import { formatUntil } from './NodeUsage.js';

/** A Stats row: the theme's label, with the plain term on hover. */
function Stat({ concept, children }: { concept: Concept; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2 py-0.5 text-xs">
      <span title={hint(concept)} className="shrink-0 text-neutral-500">
        {w(concept)}
      </span>
      <span className="min-w-0 text-right">{children}</span>
    </div>
  );
}

/** A draining bar (HP, MP), coloured in five steps from full (green) to empty (red): `--meter-<level>` in theme.css. */
function Meter({ label, left }: { label: string; left: number }) {
  const level = left > 80 ? 5 : left > 60 ? 4 : left > 40 ? 3 : left > 20 ? 2 : 1;
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={left}
      data-level={level}
      className="mb-1 mt-0.5 h-1.5 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800"
    >
      <div className="h-full" style={{ width: `${left}%`, background: `var(--meter-${level})` }} />
    </div>
  );
}

/** HP: what's left of the Kingdom's five-hour plan window (full again once it resets), and when it resets. */
function planLeft(plan: UsageWindow[] | undefined, now: number): { left: number; resetsAt: number | null } | undefined {
  const window = plan?.find((w) => w.id === 'five_hour') ?? plan?.[0];
  if (!window) return undefined;
  if (window.resetsAt !== null && window.resetsAt <= now) return { left: 100, resetsAt: null };
  return { left: Math.max(0, Math.min(100, Math.round(100 - window.usedPct))), resetsAt: window.resetsAt };
}

function Section({ title, tooltip, children }: { title: string; tooltip?: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="rounded-lg border border-neutral-300 p-3 dark:border-neutral-700">
      <h3 title={tooltip} className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
        {title}
      </h3>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-2 py-0.5 text-xs">
      <span className="w-16 shrink-0 text-neutral-500">{label}</span>
      <span className="min-w-0 break-all">{children}</span>
    </div>
  );
}

const STATE_TEXT: Record<HeroState, string | null> = {
  resting: 'Resting',
  working: null,
  alert: 'Needs you',
  victory: w('victory'),
  ko: 'KO',
};

/** The clock for "for 3m": the given time (tests), or the real one, re-read every second. */
function useNow(given: number | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (given !== undefined) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [given]);
  return given ?? now;
}

/**
 * The step in progress, in plain words, and how long it has run. A long silence is said out loud, so a Quest that
 * looks busy but has gone quiet isn't mistaken for one at work.
 */
function Step({ activity, now: givenNow }: { activity: Activity; now?: number }) {
  // Its own clock, so the second-by-second tick re-renders this line alone.
  const now = useNow(givenNow);
  const elapsed = Math.max(0, now - activity.since);
  const quiet = !activity.waiting && elapsed >= QUIET_MS;
  return (
    <span className="block">
      <span
        className={`block [overflow-wrap:anywhere] ${activity.waiting ? 'text-amber-700 dark:text-amber-400' : ''}`}
        data-testid="activity"
      >
        {activity.text} · {duration(elapsed)}
      </span>
      {quiet && (
        <span className="block text-amber-700 dark:text-amber-400">
          No new output for {duration(elapsed)}. A long command may still be running; if it stays quiet, Stop and send
          again.
        </span>
      )}
    </span>
  );
}

/** The agents at work: the party leader (the session's main agent), then each running subagent as a Hero. */
function Party({
  info,
  manifest,
  leaderState,
  activity,
  now,
}: {
  info: SessionInfo;
  manifest: HeroManifest;
  leaderState: HeroState;
  activity?: Activity;
  now?: number;
}) {
  const leader = manifest.classes[manifest.leader];
  const helpers = info.tasks.filter((task) => task.kind === 'agent' && task.running);
  // At work, the leader's word follows what it's doing; otherwise its state (resting, needs you, …).
  const doing = leaderState === 'working' && activity?.kind ? stepWord(activity.kind, activity.since) : undefined;
  const state = doing?.themed ?? STATE_TEXT[leaderState] ?? leader?.verb;
  return (
    <Section title={w('party')} tooltip={hint('party')}>
      <ul className="space-y-1.5">
        {leader && (
          <li className="flex items-center gap-2 text-xs">
            <HeroSprite manifest={manifest} classId={manifest.leader} state={leaderState} size={40} />
            <span className="min-w-0">
              <span className="block font-medium">{leader.name}</span>
              <span className="block text-neutral-500" title={doing ? `${doing.themed} (${doing.plain})` : undefined}>
                Party leader · {state}
              </span>
              {activity && <Step activity={activity} now={now} />}
            </span>
          </li>
        )}
        {helpers.length > 0 && (
          <li title={hint('sideQuests')} className="cb-display text-xs text-neutral-500">
            ◆ {w('heroes')} on {w('sideQuests')}: {helpers.length}
          </li>
        )}
        {helpers.map((task) => {
          const classId = matchClass(manifest, task.agentType);
          const cls = manifest.classes[classId];
          return (
            <li key={task.id} className="flex items-center gap-2 text-xs">
              <HeroSprite manifest={manifest} classId={classId} state="working" size={40} />
              <span className="min-w-0">
                <span className="block truncate font-medium" title={task.description}>
                  {task.description}
                </span>
                <span className="block text-neutral-500">
                  {cls?.name ?? classId}
                  {task.agentType ? ` (${task.agentType})` : ''} · {cls?.verb}
                </span>
              </span>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

export interface SessionPanelProps {
  info: SessionInfo;
  kingdom: string;
  /** Bytes the hub has sent clients about this session, all devices together, when known. */
  relayedBytes?: number;
  /** With the art pack loaded: the Party section, and the party leader's state. */
  party?: { manifest: HeroManifest; leaderState: HeroState };
  /** The turn's current step, when one is in progress. */
  activity?: Activity;
  /** The Kingdom's latest plan usage report, for HP. */
  plan?: UsageWindow[];
  /** The current time (tests); otherwise each timer keeps its own clock. */
  now?: number;
}

/** The session's side panel: where it runs, how full its context is, what it cost, what it changed and started. */
export function SessionPanel({ info, kingdom, party, relayedBytes, activity, plan, now }: SessionPanelProps) {
  const open = useContext(FileOpenContext);
  const pct = info.context?.window ? Math.round((info.context.used / info.context.window) * 100) : undefined;
  // MP drains: what's left of the context window.
  const left = pct === undefined ? undefined : Math.max(0, 100 - pct);
  const mode = MODES.find((m) => m.value === info.mode)?.label ?? info.mode;
  const hp = planLeft(plan, now ?? Date.now());
  const { stats } = info;

  return (
    <div className="space-y-3 text-sm">
      {party ? (
        <Party info={info} manifest={party.manifest} leaderState={party.leaderState} activity={activity} now={now} />
      ) : (
        activity && (
          <Section title="Now">
            <div className="text-xs">
              <Step activity={activity} now={now} />
            </div>
          </Section>
        )
      )}

      <Section title={w('stats')} tooltip={hint('stats')}>
        {hp && (
          <>
            <Stat concept="hp">
              {hp.left}%{hp.resetsAt !== null && ` · rests in ${formatUntil(hp.resetsAt, now ?? Date.now())}`}
            </Stat>
            <Meter label="Plan left" left={hp.left} />
          </>
        )}
        <Stat concept="mp">
          {info.context ? (
            <>
              {left !== undefined && <span className="font-medium">{left}% left · </span>}
              {info.context.window
                ? `${tokens(info.context.used)} of ${tokens(info.context.window)}`
                : `${tokens(info.context.used)} used`}
            </>
          ) : (
            <span className="text-neutral-500">not measured yet</span>
          )}
        </Stat>
        {left !== undefined && <Meter label="Context left" left={left} />}
        <Stat concept="gold">${info.costUsd.toFixed(2)}</Stat>
        <Stat concept="tokens">
          {tokens(stats.tokens.input)} in · {tokens(stats.tokens.output)} out
          <span className="block text-neutral-500">
            {tokens(stats.tokens.cacheRead)} cache read · {tokens(stats.tokens.cacheWrite)} written
          </span>
        </Stat>
        <Stat concept="turns">{stats.turns}</Stat>
        <Stat concept="workingTime">{duration(stats.workingMs)}</Stat>
        {relayedBytes !== undefined && <Stat concept="relayed">{bytes(relayedBytes)}</Stat>}
      </Section>

      <Section title={w('expedition')} tooltip={hint('expedition')}>
        <Row label="Kingdom">{kingdom}</Row>
        {info.cwd && (
          <Row label="Project">
            <span className="font-mono">{info.cwd}</span>
          </Row>
        )}
        {info.branch && (
          <Row label="Branch">
            <span className="font-mono">{info.branch}</span>
          </Row>
        )}
        {info.model && <Row label="Model">{info.model}</Row>}
        {mode && <Row label="Mode">{mode}</Row>}
      </Section>

      <Section title="Outputs">
        {info.outputs.length === 0 ? (
          <p className="text-xs text-neutral-500">No files changed yet</p>
        ) : (
          <ul className="space-y-1">
            {info.outputs.map((file) => (
              <li key={file.path} className="flex items-baseline justify-between gap-2 text-xs" title={file.path}>
                {open ? (
                  <button
                    type="button"
                    onClick={() => open(file.path)}
                    title={`Open ${file.path}`}
                    className="cb-file-link min-w-0 truncate font-mono"
                  >
                    {file.display}
                  </button>
                ) : (
                  <span className="min-w-0 truncate font-mono">{file.display}</span>
                )}
                <span className={`shrink-0 ${file.kind === 'created' ? 'text-green-600' : 'text-neutral-500'}`}>
                  {file.kind === 'created' ? 'created' : `edited${file.changes > 1 ? ` ×${file.changes}` : ''}`}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Background tasks">
        {info.tasks.length === 0 ? (
          <p className="text-xs text-neutral-500">None</p>
        ) : (
          <ul className="space-y-1">
            {info.tasks.map((task) => (
              <li key={task.id} data-running={task.running} className="flex items-center gap-2 text-xs">
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${task.running ? 'animate-pulse bg-blue-500' : 'bg-neutral-400'}`}
                  title={task.running ? 'running' : 'finished'}
                />
                <span className="min-w-0 truncate">{task.description}</span>
                <span className="ml-auto shrink-0 text-neutral-500">{task.kind === 'agent' ? 'agent' : 'shell'}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
