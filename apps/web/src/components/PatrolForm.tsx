import {
  type Engine,
  type ListedPatrol,
  type PatrolManifest,
  PatrolManifest as ManifestSchema,
  type PermissionMode,
  type Project,
  type Schedule,
} from '@crystal-bridge/protocol';
import { type ReactNode, type SyntheticEvent, useEffect, useId, useMemo, useRef, useState } from 'react';
import { EFFORTS } from '../effort.js';
import { engineChoices } from '../engines.js';
import { loadDefaultMode, MODES } from '../modes.js';
import {
  draftOf,
  type Every,
  manifestOf,
  newPatrolDraft,
  type PatrolDraft,
  patrolIdFrom,
  PRESETS,
  type RepeatDraft,
  type ScheduleDraft,
  type ScheduleForm,
  scheduleOf,
  scheduleWords,
  WEEKDAYS,
} from '../patrolForm.js';
import { browserZone, runTime } from '../patrols.js';
import { Icon } from '../theme/icons.js';
import { w } from '../theme/words.js';
import { ProjectPicker } from './ProjectPicker.js';
import { ThemedSelect } from './ThemedSelect.js';

export interface PatrolFormProps {
  /** The Patrol to edit; a new one without it. */
  patrol?: ListedPatrol | undefined;
  /** The Kingdom's Patrol ids, so a new one's folder doesn't land on one. */
  taken: readonly string[];
  projects: Project[];
  /** Engines the Kingdom runs; the choice shows only when there's more than the default. */
  engines?: Engine[] | undefined;
  now: number;
  /** The browser's time zone, for tests: a new schedule starts in it, and preview times show in it. */
  zone?: string;
  /** The wait before asking the Kingdom for a preview (tests). */
  previewDelayMs?: number;
  onPreview: (schedule: Schedule, signal: AbortSignal) => Promise<number[]>;
  onSave: (patrol: string, manifest: PatrolManifest) => Promise<void>;
  onClose: () => void;
}

/** Long enough that typing a cron asks about the cron, not each key of it. */
const PREVIEW_DELAY_MS = 400;

const UNITS: { value: Every; one: string; many: string }[] = [
  { value: 'minute', one: 'minute', many: 'minutes' },
  { value: 'hour', one: 'hour', many: 'hours' },
  { value: 'day', one: 'day', many: 'days' },
  { value: 'week', one: 'week', many: 'weeks' },
  { value: 'month', one: 'month', many: 'months' },
];
const FORMS: { value: ScheduleForm; label: string; hint: string }[] = [
  { value: 'repeat', label: 'Repeat', hint: 'Every so many minutes, hours, days, weeks or months' },
  { value: 'rule', label: 'Rule', hint: 'An RFC 5545 recurrence rule, as calendar apps use' },
  { value: 'cron', label: 'Cron', hint: `Five fields, as ${w('scouts')} use` },
  { value: 'once', label: 'Once', hint: `A single time; the ${w('patrol')} stands down after it` },
];
/** `catchUp` and `waitForYou` choices; a value from a file the list lacks is added as it is. */
const CATCH_UP = [
  { value: '', label: 'Within 6 hours (default)' },
  { value: '1h', label: 'Within an hour' },
  { value: '1d', label: 'Within a day' },
  { value: 'never', label: 'Never: record it as missed' },
];
const WAIT = [
  { value: '', label: '30 minutes (default)' },
  { value: '10m', label: '10 minutes' },
  { value: '2h', label: '2 hours' },
  { value: '12h', label: '12 hours' },
];
const MONTH_DAYS = [
  ...Array.from({ length: 31 }, (_, index) => ({ value: String(index + 1), label: `day ${index + 1}` })),
  { value: '-1', label: 'the last day' },
];
const ENDS = [
  { value: 'never', label: 'never' },
  { value: 'on', label: 'on a date' },
  { value: 'after', label: 'after a number of runs' },
];
const withValue = (options: { value: string; label: string }[], value: string) =>
  options.some((option) => option.value === value) ? options : [...options, { value, label: value }];

const field = 'cb-field w-full text-sm';
const small = 'cb-field py-0.5 text-sm';
const chip =
  'rounded-full border border-neutral-300 px-2.5 py-0.5 text-xs hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800';

function zones(): string[] {
  const supported = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
  try {
    return supported?.('timeZone') ?? [];
  } catch {
    return [];
  }
}

/** A visible ring on a styled label whose input is hidden, as ProjectsView's pickers do. */
const focusRing = 'has-focus-visible:ring-2 has-focus-visible:ring-sky-500';

/** A count that can be cleared and retyped: the draft takes each whole number typed, and a blank goes back on blur. */
function NumberField({
  id,
  label,
  value,
  max,
  className,
  onChange,
}: {
  id?: string;
  label?: string;
  value: number;
  max: number;
  className: string;
  onChange: (value: number) => void;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => {
    setText((typed) => (Number(typed) === value ? typed : String(value)));
  }, [value]);
  return (
    <input
      id={id}
      aria-label={label}
      type="number"
      min={1}
      max={max}
      className={className}
      value={text}
      onChange={(event) => {
        setText(event.target.value);
        const typed = Number(event.target.value);
        if (Number.isInteger(typed) && typed >= 1 && typed <= max) onChange(typed);
      }}
      onBlur={() => setText(String(value))}
    />
  );
}

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <label htmlFor={htmlFor} className="cb-label block">
        {label}
      </label>
      {children}
    </div>
  );
}

/** The Repeat builder: every N units, the days, the start and the end. */
function RepeatFields({ repeat, onChange }: { repeat: RepeatDraft; onChange: (repeat: RepeatDraft) => void }) {
  const id = useId();
  const set = (patch: Partial<RepeatDraft>) => onChange({ ...repeat, ...patch });
  const unit = UNITS.find((one) => one.value === repeat.every)!;
  const anchored = repeat.every === 'minute' || repeat.every === 'hour';
  return (
    <div className="space-y-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={`${id}-n`}>Every</label>
        <NumberField
          id={`${id}-n`}
          max={999}
          className={`${small} w-16`}
          value={repeat.interval}
          onChange={(interval) => set({ interval })}
        />
        <ThemedSelect
          label="Unit"
          size="sm"
          value={repeat.every}
          options={UNITS.map((one) => ({ value: one.value, label: repeat.interval === 1 ? one.one : one.many }))}
          onChange={(every) => set({ every: every as Every })}
        />
        {repeat.every === 'month' && (
          <>
            <span>on</span>
            <ThemedSelect
              label="Day of the month"
              title="Day of the month: a month without that day is skipped; the last day never is"
              size="sm"
              value={String(repeat.monthDay)}
              options={MONTH_DAYS}
              onChange={(day) => set({ monthDay: Number(day) })}
            />
          </>
        )}
      </div>
      {repeat.every === 'week' && (
        <fieldset className="flex flex-wrap gap-1">
          <legend className="sr-only">Days</legend>
          {WEEKDAYS.map((day) => {
            const on = repeat.days.includes(day.value);
            return (
              <label
                key={day.value}
                className={`cursor-pointer rounded border px-2 py-0.5 text-xs ${focusRing} ${on ? 'border-violet-500 bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-200' : 'border-neutral-300 dark:border-neutral-700'}`}
              >
                <input
                  type="checkbox"
                  className="sr-only"
                  checked={on}
                  onChange={() =>
                    set({ days: on ? repeat.days.filter((one) => one !== day.value) : [...repeat.days, day.value] })
                  }
                />
                {day.label}
              </label>
            );
          })}
        </fieldset>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={`${id}-date`}>{anchored ? 'Counting from' : 'Starting'}</label>
        <input
          id={`${id}-date`}
          type="date"
          className={small}
          value={repeat.date}
          onChange={(event) => event.target.value && set({ date: event.target.value })}
        />
        <label htmlFor={`${id}-time`}>at</label>
        <input
          id={`${id}-time`}
          type="time"
          className={small}
          value={repeat.time}
          onChange={(event) => event.target.value && set({ time: event.target.value.slice(0, 5) })}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span>Ends</span>
        <ThemedSelect
          label="Ends"
          size="sm"
          value={repeat.end}
          options={ENDS}
          onChange={(end) => set({ end: end as RepeatDraft['end'] })}
        />
        {repeat.end === 'on' && (
          <input
            aria-label="Last day"
            type="date"
            className={small}
            value={repeat.until}
            onChange={(event) => event.target.value && set({ until: event.target.value })}
          />
        )}
        {repeat.end === 'after' && (
          <>
            <NumberField
              label="Runs"
              max={9999}
              className={`${small} w-20`}
              value={repeat.count}
              onChange={(count) => set({ count })}
            />
            <span>{repeat.count === 1 ? 'run' : 'runs'}</span>
          </>
        )}
      </div>
      {repeat.except && repeat.except.length > 0 && (
        <p className="text-xs text-neutral-500">{`Skips ${repeat.except.join(', ')} (from its file).`}</p>
      )}
      {unit.value === 'minute' && repeat.interval < 5 && (
        <p className="text-xs text-amber-700 dark:text-amber-300">
          {`A ${w('quest')} this often spends plan usage fast, and a run still out skips the next.`}
        </p>
      )}
    </div>
  );
}

/** The next run times the Kingdom gives for a schedule, asked a moment after the schedule stops changing. */
function usePreview(
  schedule: Schedule,
  onPreview: PatrolFormProps['onPreview'],
  delayMs: number,
): { times?: number[]; reason?: string; asking: boolean } {
  const key = JSON.stringify(schedule);
  const [state, setState] = useState<{ key: string; times?: number[]; reason?: string }>({ key: '' });
  const ask = useRef(onPreview);
  ask.current = onPreview;
  useEffect(() => {
    const stop = new AbortController();
    const timer = setTimeout(() => {
      ask
        .current(JSON.parse(key) as Schedule, stop.signal)
        .then((times) => {
          if (!stop.signal.aborted) setState({ key, times });
        })
        .catch((error: unknown) => {
          if (!stop.signal.aborted) setState({ key, reason: error instanceof Error ? error.message : String(error) });
        });
    }, delayMs);
    return () => {
      clearTimeout(timer);
      stop.abort();
    };
  }, [key, delayMs]);
  return state.key === key
    ? {
        ...(state.times ? { times: state.times } : {}),
        ...(state.reason ? { reason: state.reason } : {}),
        asking: false,
      }
    : { asking: true };
}

/**
 * The New Patrol and Edit form (docs/PATROLS.md, Edit from the app): a Quest Patrol only, in the modes New Quest offers,
 * with its next runs worked out on the Kingdom before it's saved. The Kingdom checks the save as it would a file.
 */
export function PatrolForm({
  patrol,
  taken,
  projects,
  engines,
  now,
  zone = browserZone(),
  previewDelayMs = PREVIEW_DELAY_MS,
  onPreview,
  onSave,
  onClose,
}: PatrolFormProps) {
  const id = useId();
  const [draft, setDraft] = useState<PatrolDraft>(() =>
    patrol ? draftOf(patrol, now, zone) : newPatrolDraft(now, zone, loadDefaultMode()),
  );
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    panel.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, []);
  const set = (patch: Partial<PatrolDraft>) => setDraft((known) => ({ ...known, ...patch }));
  const setSchedule = (patch: Partial<ScheduleDraft>) =>
    setDraft((known) => ({ ...known, schedule: { ...known.schedule, ...patch } }));

  const folder = patrol?.id ?? patrolIdFrom(draft.name, taken);
  const schedule = useMemo(() => scheduleOf(draft.schedule), [draft.schedule]);
  const preview = usePreview(schedule, onPreview, previewDelayMs);
  const choices = engineChoices(engines);
  const zoneList = useMemo(zones, []);
  const otherZone = draft.schedule.timezone.trim() !== zone ? draft.schedule.timezone.trim() : undefined;
  const words = useMemo(() => {
    try {
      return scheduleWords(schedule);
    } catch {
      return undefined;
    }
  }, [schedule]);

  async function save(event: SyntheticEvent) {
    event.preventDefault();
    setProblem(null);
    if (!draft.project.trim()) return setProblem(`Pick the project this ${w('quest')} works in.`);
    if (!draft.promptFile && !draft.promptText.trim()) return setProblem(`Write what each ${w('quest')} should do.`);
    const manifest = manifestOf(draft);
    const checked = ManifestSchema.safeParse(manifest);
    if (!checked.success) {
      const issue = checked.error.issues[0];
      return setProblem(`${issue?.path.join('.') || 'it'}: ${issue?.message ?? 'not valid'}`);
    }
    setSaving(true);
    try {
      await onSave(folder, manifest);
      onClose();
    } catch (failure) {
      setProblem(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section
      ref={panel}
      aria-label={patrol ? `Edit ${draft.name || patrol.id}` : `New ${w('patrol')}`}
      className="rounded border border-violet-300 p-3 dark:border-violet-800"
    >
      <form onSubmit={(event) => void save(event)} className="space-y-4">
        <h3 className="flex items-center gap-2 font-medium">
          <Icon name="treasureMap" size={18} />
          {patrol ? `Edit ${patrol.manifest?.name ?? patrol.id}` : `New ${w('patrol')}`}
        </h3>
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-3">
            <Field label="Name" htmlFor={`${id}-name`}>
              <input
                id={`${id}-name`}
                className={field}
                maxLength={80}
                value={draft.name}
                onChange={(event) => set({ name: event.target.value })}
              />
              <p className="text-xs text-neutral-500">
                {patrol ? `Folder patrols/${folder}/` : `Saved on the ${w('kingdom')} as patrols/${folder}/`}
              </p>
            </Field>
            <div className="space-y-1">
              <span className="cb-label block">Project</span>
              <ProjectPicker projects={projects} value={draft.project} onChange={(project) => set({ project })} />
            </div>
            {draft.promptFile ? (
              <div className="space-y-1 text-sm">
                <span className="cb-label block">Prompt</span>
                <p className="text-neutral-600 dark:text-neutral-400">
                  {`Its prompt is ${draft.promptFile} in the ${w('patrol')}'s folder on the ${w('kingdom')}; edit it there, or replace it here.`}
                </p>
                <button
                  type="button"
                  className="text-xs underline"
                  onClick={() => set({ promptFile: undefined, promptText: '' })}
                >
                  Write a new prompt here
                </button>
              </div>
            ) : (
              <Field label="Prompt" htmlFor={`${id}-prompt`}>
                <textarea
                  id={`${id}-prompt`}
                  className={`${field} min-h-32`}
                  rows={6}
                  placeholder={`What should each ${w('quest')} do, and what must it never do? Nobody is watching when it runs.`}
                  value={draft.promptText}
                  onChange={(event) => set({ promptText: event.target.value })}
                />
              </Field>
            )}
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <ThemedSelect
                label="Permission mode"
                icon="mode"
                title={`Permission mode: how much each ${w('quest')} may do without asking`}
                value={draft.mode}
                options={[
                  ...(draft.mode === '' ? [{ value: '', label: `The ${w('kingdom')}'s default` }] : []),
                  ...MODES,
                ]}
                onChange={(mode) => set({ mode: mode as PermissionMode | '' })}
              />
              <ThemedSelect
                label="Effort"
                icon="effort"
                title="Effort: how hard the agent thinks (the CLI's --effort); Default leaves the CLI's own"
                value={draft.effort}
                options={EFFORTS}
                onChange={(effort) => set({ effort: effort as PatrolDraft['effort'] })}
              />
              {(choices.length > 1 || draft.engine) && (
                <ThemedSelect
                  label="Engine"
                  title={`Engine: how the ${w('kingdom')} runs the agent`}
                  value={draft.engine}
                  options={withValue([{ value: '', label: 'Default' }, ...choices], draft.engine)}
                  onChange={(engine) => set({ engine: engine as Engine | '' })}
                />
              )}
              <label className="flex items-center gap-1">
                <input
                  type="checkbox"
                  className="cb-check"
                  checked={draft.worktree}
                  onChange={(event) => set({ worktree: event.target.checked })}
                />
                Separate worktree
              </label>
            </div>
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <span className="flex items-center gap-1">
                A prompt waits
                <ThemedSelect
                  label="How long a prompt waits"
                  title="How long a permission prompt waits for you before the run ends"
                  size="sm"
                  value={draft.waitForYou}
                  options={withValue(WAIT, draft.waitForYou)}
                  onChange={(waitForYou) => set({ waitForYou })}
                />
              </span>
              <span className="flex items-center gap-1">
                A missed run catches up
                <ThemedSelect
                  label="How late a missed run catches up"
                  title={`How late a run missed while the ${w('kingdom')} was off may still run`}
                  size="sm"
                  value={draft.catchUp}
                  options={withValue(CATCH_UP, draft.catchUp)}
                  onChange={(catchUp) => set({ catchUp })}
                />
              </span>
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex flex-wrap gap-1.5">
              {PRESETS.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  className={chip}
                  onClick={() =>
                    setSchedule({
                      form: 'repeat',
                      repeat: { ...draft.schedule.repeat, days: [], end: 'never', ...preset.repeat },
                    })
                  }
                >
                  {preset.label}
                </button>
              ))}
            </div>
            <div role="radiogroup" aria-label="Schedule form" className="flex gap-1 text-sm">
              {FORMS.map((form) => (
                <label
                  key={form.value}
                  title={form.hint}
                  className={`cursor-pointer rounded px-2 py-0.5 ${focusRing} ${draft.schedule.form === form.value ? 'bg-neutral-200 font-medium dark:bg-neutral-700' : 'hover:bg-neutral-100 dark:hover:bg-neutral-800'}`}
                >
                  <input
                    type="radio"
                    className="sr-only"
                    name={`${id}-form`}
                    checked={draft.schedule.form === form.value}
                    onChange={() => setSchedule({ form: form.value })}
                  />
                  {form.label}
                </label>
              ))}
            </div>
            {draft.schedule.form === 'repeat' && (
              <RepeatFields repeat={draft.schedule.repeat} onChange={(repeat) => setSchedule({ repeat })} />
            )}
            {draft.schedule.form === 'rule' && (
              <div className="space-y-2">
                <Field label="Rule text" htmlFor={`${id}-rule`}>
                  <input
                    id={`${id}-rule`}
                    className={`${field} font-mono`}
                    placeholder="FREQ=MONTHLY;BYDAY=MO;BYSETPOS=1"
                    value={draft.schedule.rule}
                    onChange={(event) => setSchedule({ rule: event.target.value })}
                  />
                </Field>
                <Field label="Starting" htmlFor={`${id}-rule-start`}>
                  <input
                    id={`${id}-rule-start`}
                    type="datetime-local"
                    className={small}
                    value={draft.schedule.ruleStart}
                    onChange={(event) => event.target.value && setSchedule({ ruleStart: event.target.value })}
                  />
                </Field>
              </div>
            )}
            {draft.schedule.form === 'cron' && (
              <Field label="Cron schedule" htmlFor={`${id}-cron`}>
                <input
                  id={`${id}-cron`}
                  className={`${field} font-mono`}
                  placeholder="*/15 8-20 * * 1-5"
                  value={draft.schedule.cron}
                  onChange={(event) => setSchedule({ cron: event.target.value })}
                />
              </Field>
            )}
            {draft.schedule.form === 'once' && (
              <Field label="At" htmlFor={`${id}-once`}>
                <input
                  id={`${id}-once`}
                  type="datetime-local"
                  className={small}
                  value={draft.schedule.once}
                  onChange={(event) => event.target.value && setSchedule({ once: event.target.value })}
                />
              </Field>
            )}
            <Field label="Time zone" htmlFor={`${id}-zone`}>
              <input
                id={`${id}-zone`}
                className={field}
                list={`${id}-zones`}
                value={draft.schedule.timezone}
                onChange={(event) => setSchedule({ timezone: event.target.value })}
              />
              <datalist id={`${id}-zones`}>
                {zoneList.map((one) => (
                  <option key={one} value={one} />
                ))}
              </datalist>
            </Field>

            <div className="rounded bg-neutral-50 p-2 text-sm dark:bg-neutral-900">
              {words && <div className="font-medium">{words}</div>}
              <div className="mt-1 text-xs text-neutral-500">
                {`Coming up, as the ${w('kingdom')} works it out${otherZone ? `: your time, then ${otherZone}` : ''}`}
              </div>
              {preview.reason ? (
                <p role="alert" className="mt-1 text-red-700 dark:text-red-400">
                  {preview.reason}
                </p>
              ) : preview.times ? (
                preview.times.length === 0 ? (
                  <p className="mt-1 text-neutral-500">It never runs again.</p>
                ) : (
                  <ol aria-label="Next runs" className="mt-1 space-y-0.5 tabular-nums">
                    {preview.times.map((time) => (
                      <li key={time}>
                        {runTime(time, zone)}
                        {otherZone && <span className="text-neutral-500">{` · ${safeTime(time, otherZone)}`}</span>}
                      </li>
                    ))}
                  </ol>
                )
              ) : (
                <p className="mt-1 text-neutral-500">Asking…</p>
              )}
            </div>
          </div>
        </div>

        {problem && (
          <p role="alert" className="text-sm text-red-700 dark:text-red-400">
            {problem}
          </p>
        )}
        <div className="flex flex-wrap items-center justify-end gap-2">
          <p className="mr-auto text-xs text-neutral-500">
            {`Saving doesn't run it: its first run is the first time above, or Run now.`}
          </p>
          <button
            type="button"
            className="rounded border border-neutral-300 px-3 py-1 text-sm dark:border-neutral-700"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving || !draft.name.trim()}
            className="inline-flex items-center gap-1 rounded bg-violet-700 px-3 py-1 text-sm text-white hover:bg-violet-800 disabled:opacity-50"
          >
            <Icon name="treasureMap" size={14} />
            {saving ? 'Saving…' : `Save ${w('patrol')}`}
          </button>
        </div>
      </form>
    </section>
  );
}

/** A time in the Patrol's zone, if the browser knows it; the Kingdom has already said the zone is good. */
function safeTime(at: number, zone: string): string {
  try {
    return runTime(at, zone);
  } catch {
    return '';
  }
}
