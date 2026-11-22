import { type ComponentPropsWithoutRef, isValidElement, type ReactNode, useRef, useState } from 'react';
import { Icon } from '../theme/icons.js';

/** The fenced block's language (`language-sh` → `sh`), from the `<code>` react-markdown puts inside `<pre>`. */
function languageOf(children: ReactNode): string | undefined {
  const code = Array.isArray(children) ? children[0] : children;
  if (!isValidElement<{ className?: string }>(code)) return undefined;
  return /language-([\w+-]+)/.exec(code.props.className ?? '')?.[1];
}

/**
 * A markdown code block: a header row naming its language with a copy button, then the code, which scrolls
 * sideways in its own box, never the pane. The header keeps the button off the code, even on a one-liner.
 * `compact` (an Errand's body) drops the header: the code sits one line tall beside a small Copy chip, which is its
 * sibling in a row rather than laid over it, so however narrow the column, no character scrolls under the chip.
 */
export function CodeBlock(props: ComponentPropsWithoutRef<'pre'> & { node?: unknown; compact?: boolean }) {
  const { node: _node, children, className, compact = false, ...rest } = props;
  const pre = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const language = languageOf(children);

  async function copy() {
    const text = (pre.current?.textContent ?? '').replace(/\n$/, '');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard refused (e.g. an insecure origin): select the code so a manual copy works.
      const range = document.createRange();
      if (pre.current) range.selectNodeContents(pre.current);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
  }

  if (compact) {
    return (
      <div className="cb-code my-1.5 flex items-start gap-1 rounded-md bg-neutral-100 p-1 pl-2 ring-1 ring-neutral-200 dark:bg-neutral-900 dark:ring-neutral-800">
        <pre
          ref={pre}
          className={`my-0! min-w-0 flex-1 overflow-x-auto py-1 pr-2 font-mono text-[12px] leading-5 text-neutral-800 dark:text-neutral-200 ${className ?? ''}`}
          {...rest}
        >
          {children}
        </pre>
        <button
          type="button"
          onClick={() => void copy()}
          aria-label={copied ? 'Copied' : 'Copy code'}
          data-copied={copied}
          className="cb-copy inline-flex shrink-0 items-center gap-1 rounded border border-neutral-300 bg-white px-1.5 py-0.5 font-sans text-[11px] font-bold text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-200 dark:hover:bg-neutral-800"
        >
          <Icon name="errandCopy" size={14} />
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    );
  }

  return (
    <div className="cb-code my-2 overflow-hidden rounded border border-neutral-200 dark:border-neutral-800">
      <div
        data-code-header
        className="flex items-center justify-between bg-neutral-100 px-2 py-1 text-xs text-neutral-500 dark:bg-neutral-900"
      >
        <span className="font-mono">{language ?? ''}</span>
        <button
          type="button"
          onClick={() => void copy()}
          aria-label={copied ? 'Copied' : 'Copy code'}
          data-copied={copied}
          className="cb-copy rounded px-1.5 py-0.5 hover:bg-neutral-200 dark:hover:bg-neutral-800"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre ref={pre} className={`my-0! rounded-none! ${className ?? ''}`} {...rest}>
        {children}
      </pre>
    </div>
  );
}
