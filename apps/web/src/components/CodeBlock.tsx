import { type ComponentPropsWithoutRef, isValidElement, type ReactNode, useRef, useState } from 'react';

/** The fenced block's language (`language-sh` → `sh`), from the `<code>` react-markdown puts inside `<pre>`. */
function languageOf(children: ReactNode): string | undefined {
  const code = Array.isArray(children) ? children[0] : children;
  if (!isValidElement<{ className?: string }>(code)) return undefined;
  return /language-([\w+-]+)/.exec(code.props.className ?? '')?.[1];
}

/**
 * A markdown code block: a header row naming its language with a copy button, then the code, which scrolls
 * sideways in its own box, never the pane. The header keeps the button off the code, even on a one-liner.
 */
export function CodeBlock(props: ComponentPropsWithoutRef<'pre'> & { node?: unknown }) {
  const { node: _node, children, className, ...rest } = props;
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
