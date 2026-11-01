import { useContext } from 'react';
import { type DiffLine, diffLines } from '../diff.js';
import type { HeroManifest } from '../heroes.js';
import type { ViewItem } from '../model.js';
import { summonLine, useLine } from '../theme/words.js';
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

export function ToolCard({ tool }: { tool: ToolItem }) {
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

  return (
    <details className="rounded border border-neutral-300 bg-neutral-50 text-sm dark:border-neutral-700 dark:bg-neutral-900">
      <summary className="flex cursor-pointer items-center gap-2 px-3 py-2">
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
        <span className={`ml-auto rounded px-2 py-0.5 text-xs ${badge}`}>{state}</span>
      </summary>
      <div className="space-y-2 border-t border-neutral-300 px-3 py-2 dark:border-neutral-700">
        <Detail tool={tool} change={change} />
      </div>
    </details>
  );
}

/** Whether a tool call is a Quest starting a Cast, as opposed to asking about one. */
export function isSummonStart(tool: ToolItem): boolean {
  return tool.name === 'mcp__crystal__summon' && isObj(tool.input) && tool.input.action === 'start';
}

/** A Cast started, as one line ("You summoned Shiva!"), with the command folded inside. */
export function SummonLine({ tool }: { tool: ToolItem }) {
  const input = isObj(tool.input) ? tool.input : {};
  const line = summonLine(str(input.summon) ?? 'a machine');
  const failed = tool.denied || tool.isError;
  return (
    <details className="text-sm">
      <summary
        title={line.plain}
        className="flex cursor-pointer items-center gap-2 py-0.5 text-amber-700 dark:text-gold-bright"
      >
        <span className="cb-display text-base leading-none">{line.themed}</span>
        {failed && <span className="text-xs text-red-600 dark:text-red-400">{tool.denied ? 'denied' : 'failed'}</span>}
      </summary>
      <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded border border-neutral-300 bg-neutral-50 p-2 font-mono text-xs text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300">
        {failed ? (tool.output ?? '') : (str(input.command) ?? '')}
      </pre>
    </details>
  );
}

/**
 * A skill the party leader used, as one line ("Paladin casts deploy!"); the skill's text, which the CLI feeds the
 * model, stays folded inside.
 */
export function SkillLine({ tool, manifest }: { tool: ToolItem; manifest?: HeroManifest }) {
  const input = isObj(tool.input) ? tool.input : {};
  const name = str(input.skill) ?? 'a skill';
  const hero = manifest?.classes[manifest.leader]?.name ?? 'Hero';
  const line = useLine('spells', hero, name);
  const failed = tool.denied || tool.isError;
  return (
    <details className="text-sm">
      <summary
        title={line.plain}
        className="flex cursor-pointer items-center gap-2 py-0.5 text-amber-700 dark:text-gold-bright"
      >
        {manifest && <HeroSprite manifest={manifest} classId={manifest.leader} state="working" size={20} decorative />}
        <span className="cb-display text-base leading-none">{line.themed}</span>
        {failed && <span className="text-xs text-red-600 dark:text-red-400">{tool.denied ? 'denied' : 'failed'}</span>}
      </summary>
      <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded border border-neutral-300 bg-neutral-50 p-2 font-mono text-xs text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300">
        {tool.body ?? tool.output ?? ''}
      </pre>
    </details>
  );
}
