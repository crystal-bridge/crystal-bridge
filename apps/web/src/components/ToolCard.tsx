import { type ReactNode, useContext } from 'react';
import { type DiffLine, diffLines } from '../diff.js';
import { type Helper, helperClass, type HeroManifest, type HeroState } from '../heroes.js';
import { AGENT_TOOLS, type ViewItem } from '../model.js';
import { helperLine, summonLine, toolChip, useLine, type Word } from '../theme/words.js';
import { HeroSprite } from './HeroSprite.js';
import { FileOpenContext } from './markdown.js';

type ToolItem = Extract<ViewItem, { kind: 'tool' }>;
type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

/** Lines added to or removed from files by an Edit, MultiEdit or Write, for the card's summary and body. */
function fileChange(tool: ToolItem): { path: string; diffs: DiffLine[][] } | undefined {
  const input = isObj(tool.input) ? tool.input : {};
  const path = str(input.file_path);
  if (!path) return undefined;
  if (tool.name === 'Edit')
    return { path, diffs: [diffLines(str(input.old_string) ?? '', str(input.new_string) ?? '')] };
  if (tool.name === 'MultiEdit' && Array.isArray(input.edits)) {
    return {
      path,
      diffs: input.edits.filter(isObj).map((edit) => diffLines(str(edit.old_string) ?? '', str(edit.new_string) ?? '')),
    };
  }
  if (tool.name === 'Write') return { path, diffs: [diffLines('', str(input.content) ?? '')] };
  return undefined;
}

function summary(tool: ToolItem, change: ReturnType<typeof fileChange>): string {
  if (change) return change.path;
  const input = isObj(tool.input) ? tool.input : {};
  for (const key of ['command', 'file_path', 'path', 'pattern', 'url', 'description']) {
    const value = str(input[key]);
    if (value) return value;
  }
  return '';
}

/** "+2 −1", or "+2" for a new file. */
function counts(diffs: DiffLine[][]): string {
  const lines = diffs.flat();
  const added = lines.filter((l) => l.kind === 'added').length;
  const removed = lines.filter((l) => l.kind === 'removed').length;
  return removed ? `+${added} −${removed}` : `+${added}`;
}

const DIFF_STYLE: Record<DiffLine['kind'], string> = {
  same: 'text-neutral-500',
  removed: 'bg-red-100 text-red-900 dark:bg-red-950/60 dark:text-red-200',
  added: 'bg-green-100 text-green-900 dark:bg-green-950/60 dark:text-green-200',
};
const DIFF_MARK: Record<DiffLine['kind'], string> = { same: ' ', removed: '-', added: '+' };

/** Long files are cut so one Write can't make the page heavy; the full text is in the session's history. */
const MAX_DIFF_LINES = 400;

function Diff({ lines }: { lines: DiffLine[] }) {
  const shown = lines.slice(0, MAX_DIFF_LINES);
  return (
    <pre className="max-h-96 overflow-auto rounded bg-white py-1 text-xs dark:bg-neutral-950">
      {shown.map((line, i) => (
        <div key={i} className={`flex px-2 ${DIFF_STYLE[line.kind]}`}>
          <span className="w-4 shrink-0 select-none opacity-60">{DIFF_MARK[line.kind]}</span>
          <span data-diff={line.kind} className="whitespace-pre-wrap break-all">
            {line.text}
          </span>
        </div>
      ))}
      {lines.length > shown.length && (
        <div className="px-2 text-neutral-500">… {lines.length - shown.length} more lines</div>
      )}
    </pre>
  );
}

function Output({ text }: { text: string }) {
  return (
    <div>
      <div className="mb-1 text-xs uppercase text-neutral-500">Output</div>
      <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded bg-white p-2 text-xs dark:bg-neutral-950">
        {text}
      </pre>
    </div>
  );
}

function Detail({ tool, change }: { tool: ToolItem; change: ReturnType<typeof fileChange> }) {
  const input = isObj(tool.input) ? tool.input : {};
  if (change) {
    return (
      <>
        <div className="font-mono text-xs text-neutral-600 dark:text-neutral-400">{change.path}</div>
        {change.diffs.map((lines, i) => (
          <Diff key={i} lines={lines} />
        ))}
        {tool.isError && tool.output !== undefined && <Output text={tool.output} />}
      </>
    );
  }
  if (tool.name === 'Bash' && str(input.command)) {
    return (
      <>
        {str(input.description) && <div className="text-xs text-neutral-500">{str(input.description)}</div>}
        <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-neutral-900 p-2 text-xs text-neutral-100">{`$ ${str(input.command)}`}</pre>
        {tool.output !== undefined && <Output text={tool.output} />}
      </>
    );
  }
  return (
    <>
      <div>
        <div className="mb-1 text-xs uppercase text-neutral-500">Input</div>
        <pre className="overflow-x-auto whitespace-pre-wrap text-xs">{JSON.stringify(tool.input, null, 2)}</pre>
      </div>
      {tool.output !== undefined && <Output text={tool.output} />}
    </>
  );
}

/** The file a tool read or wrote, for the viewer: Read, Edit, MultiEdit, Write and NotebookEdit carry `file_path`. */
function filePath(tool: ToolItem): string | undefined {
  if (!['Read', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(tool.name)) return undefined;
  return str(isObj(tool.input) ? tool.input.file_path : undefined);
}

/** The Class making a tool call: its helper's, else the party leader's. */
function callerClass(tool: ToolItem, manifest: HeroManifest | undefined): string | undefined {
  if (!manifest) return undefined;
  return tool.helper ? helperClass(manifest, tool.helper) : manifest.leader;
}

/** What to call a helper in a line or a tooltip. */
const helperTask = (helper: Helper) => helper.description ?? helper.agentType ?? 'a task';

/** The small sprite beside a helper's row, saying whose it is. Still, since a long Quest has hundreds of rows. */
function HelperMark({ helper, manifest }: { helper: Helper | undefined; manifest: HeroManifest | undefined }) {
  if (!helper || !manifest) return null;
  const classId = helperClass(manifest, helper);
  const name = manifest.classes[classId]?.name ?? classId;
  return (
    <HeroSprite
      manifest={manifest}
      classId={classId}
      state="working"
      size={20}
      still
      label={`${name} · ${helperTask(helper)}`}
    />
  );
}

export function ToolCard({ tool, manifest }: { tool: ToolItem; manifest?: HeroManifest | undefined }) {
  const open = useContext(FileOpenContext);
  const path = filePath(tool);
  const state = tool.denied ? 'denied' : tool.isError ? 'error' : tool.done ? 'done' : 'running';
  const badge = {
    denied: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
    error: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
    done: 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300',
    running: 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300',
  }[state];
  const change = fileChange(tool);
  const caller = callerClass(tool, manifest);
  const chip = toolChip(state, caller ? manifest?.classes[caller]?.work : undefined);

  return (
    <details className="rounded border border-neutral-300 bg-neutral-50 text-sm dark:border-neutral-700 dark:bg-neutral-900">
      <summary className="flex cursor-pointer items-center gap-2 px-3 py-2">
        <HelperMark helper={tool.helper} manifest={manifest} />
        <span className="font-mono font-semibold">{tool.name}</span>
        <span className="truncate font-mono text-neutral-600 dark:text-neutral-400">{summary(tool, change)}</span>
        {change && <span className="shrink-0 font-mono text-xs text-neutral-500">{counts(change.diffs)}</span>}
        {open && path && (
          <button
            type="button"
            title={`Open ${path}`}
            onClick={(e) => {
              // Inside <summary>: open the file without also folding the card open or shut.
              e.preventDefault();
              e.stopPropagation();
              open(path);
            }}
            className="cb-file-link shrink-0 rounded px-1.5 text-xs"
          >
            Open
          </button>
        )}
        <span title={chip.plain} className={`ml-auto rounded px-2 py-0.5 text-xs ${badge}`}>
          {chip.themed}
        </span>
      </summary>
      <div className="space-y-2 border-t border-neutral-300 px-3 py-2 dark:border-neutral-700">
        <Detail tool={tool} change={change} />
      </div>
    </details>
  );
}

/** One themed entry in the chat, with its detail folded inside. */
function GameLine({
  line,
  mark,
  chip,
  ko = false,
  body,
}: {
  line: Word;
  mark?: ReactNode;
  chip?: Word | undefined;
  ko?: boolean;
  body: string;
}) {
  return (
    <details className="text-sm">
      <summary
        title={line.plain}
        className={`flex cursor-pointer items-center gap-2 py-0.5 ${ko ? 'text-red-700 dark:text-red-400' : 'text-amber-700 dark:text-gold-bright'}`}
      >
        {mark}
        <span className="cb-display text-base leading-none">{line.themed}</span>
        {chip && (
          <span title={chip.plain} className="text-xs text-red-600 dark:text-red-400">
            {chip.themed}
          </span>
        )}
      </summary>
      <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded border border-neutral-300 bg-neutral-50 p-2 font-mono text-xs text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300">
        {body}
      </pre>
    </details>
  );
}

/** The chip a one-line entry shows if its call didn't go through. */
const failureChip = (tool: ToolItem) =>
  tool.denied ? toolChip('denied') : tool.isError ? toolChip('error') : undefined;

/** Whether a tool call is a Quest starting a Cast, as opposed to asking about one. */
export function isSummonStart(tool: ToolItem): boolean {
  return tool.name === 'mcp__crystal__summon' && isObj(tool.input) && tool.input.action === 'start';
}

/** A Cast started, as one line ("You summoned Shiva!"), with the command folded inside. */
export function SummonLine({ tool, manifest }: { tool: ToolItem; manifest?: HeroManifest | undefined }) {
  const input = isObj(tool.input) ? tool.input : {};
  const chip = failureChip(tool);
  return (
    <GameLine
      line={summonLine(str(input.summon) ?? 'a machine')}
      mark={<HelperMark helper={tool.helper} manifest={manifest} />}
      chip={chip}
      body={chip ? (tool.output ?? '') : (str(input.command) ?? '')}
    />
  );
}

/**
 * A skill a Hero used, as one line ("Paladin casts deploy!"); the skill's text, which the CLI feeds the model, stays
 * folded inside.
 */
export function SkillLine({ tool, manifest }: { tool: ToolItem; manifest?: HeroManifest | undefined }) {
  const input = isObj(tool.input) ? tool.input : {};
  const name = str(input.skill) ?? 'a skill';
  const caller = callerClass(tool, manifest);
  const hero = (caller && manifest?.classes[caller]?.name) ?? 'Hero';
  return (
    <GameLine
      line={useLine('spells', hero, name)}
      mark={
        manifest && caller && <HeroSprite manifest={manifest} classId={caller} state="working" size={20} decorative />
      }
      chip={failureChip(tool)}
      body={tool.body ?? tool.output ?? ''}
    />
  );
}

/** Whether a tool call sends out a helper. */
export function isAgentCall(tool: ToolItem): boolean {
  return AGENT_TOOLS.has(tool.name);
}

/** A helper's Class as a sprite and a name, for its lines. */
function helperHero(helper: Helper, manifest: HeroManifest | undefined, state: HeroState) {
  if (!manifest) return { name: 'Hero', mark: null };
  const classId = helperClass(manifest, helper);
  return {
    name: manifest.classes[classId]?.name ?? 'Hero',
    mark: <HeroSprite manifest={manifest} classId={classId} state={state} size={20} still decorative />,
  };
}

/** A helper leaving ("Wizard sets out: Security review!"), with the prompt it was given folded inside. */
export function SetOutLine({ tool, manifest }: { tool: ToolItem; manifest?: HeroManifest | undefined }) {
  const helper = tool.sent ?? { id: tool.id };
  const { name, mark } = helperHero(helper, manifest, 'working');
  const input = isObj(tool.input) ? tool.input : {};
  return (
    <GameLine
      line={helperLine('set-out', name, helperTask(helper))}
      mark={mark}
      // A failure after setting out gets its own KO line, so this one only says it never left.
      chip={tool.denied ? failureChip(tool) : undefined}
      body={tool.denied ? (tool.output ?? '') : (str(input.prompt) ?? '')}
    />
  );
}

/** A helper coming back or KO'd, with its report folded inside. */
export function HelperBackLine({
  item,
  manifest,
}: {
  item: Extract<ViewItem, { kind: 'helper-back' }>;
  manifest?: HeroManifest | undefined;
}) {
  const returned = item.outcome === 'returned';
  const { name, mark } = helperHero(item.helper, manifest, returned ? 'victory' : 'ko');
  return (
    <GameLine
      line={helperLine(item.outcome, name, helperTask(item.helper))}
      mark={mark}
      ko={!returned}
      body={item.report ?? ''}
    />
  );
}
