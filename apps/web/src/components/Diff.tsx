import type { DiffLine } from '../diff.js';

const DIFF_STYLE: Record<DiffLine['kind'], string> = {
  same: 'text-neutral-500',
  removed: 'bg-red-100 text-red-900 dark:bg-red-950/60 dark:text-red-200',
  added: 'bg-green-100 text-green-900 dark:bg-green-950/60 dark:text-green-200',
};
const DIFF_MARK: Record<DiffLine['kind'], string> = { same: ' ', removed: '-', added: '+' };

/** Long files are cut so one diff can't make the page heavy. */
const MAX_DIFF_LINES = 400;

/** A line diff, removed lines in red and added in green: a tool card's edit, or a Tome on disk against the editor's text. */
export function Diff({ lines }: { lines: DiffLine[] }) {
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
