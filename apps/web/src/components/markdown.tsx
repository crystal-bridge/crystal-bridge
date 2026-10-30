import { type ComponentPropsWithoutRef, createContext, type ReactNode, useContext } from 'react';
import remarkGfm from 'remark-gfm';
import { fileHref, pathIn } from '../files.js';
import { CodeBlock } from './CodeBlock.js';

/**
 * Opens a file of the current Quest in the read-only viewer. Provided around a Quest's view; absent elsewhere, so the
 * same markdown renders file names as plain code where there's nothing to open them with.
 */
export const FileOpenContext = createContext<((path: string) => void) | null>(null);

/** Plain text of simple markdown children, e.g. inline code; undefined when they hold elements. */
function textOf(children: ReactNode): string | undefined {
  if (typeof children === 'string') return children;
  if (Array.isArray(children) && children.every((child) => typeof child === 'string')) return children.join('');
  return undefined;
}

/** Inline code that names a file opens it; everything else (including code inside a block) stays code. */
function InlineCode({
  node: _node,
  className,
  children,
  ...rest
}: ComponentPropsWithoutRef<'code'> & { node?: unknown }) {
  const open = useContext(FileOpenContext);
  const text = textOf(children);
  // Block code reaches here too, inside <pre>: it has a language class or ends in a newline; inline code never does.
  const block = className?.includes('language-') || text === undefined || text.includes('\n');
  const path = !block && text ? pathIn(text) : undefined;
  if (!open || !path) {
    return (
      <code className={className} {...rest}>
        {children}
      </code>
    );
  }
  return (
    <button type="button" onClick={() => open(path)} title={`Open ${path}`} className="cb-file-link">
      <code>{children}</code>
    </button>
  );
}

/** Links to files in the Quest open in the viewer; web links open beside the app, never replacing it. */
function Link({ node: _node, href, children, ...props }: ComponentPropsWithoutRef<'a'> & { node?: unknown }) {
  const open = useContext(FileOpenContext);
  const path = fileHref(href);
  if (open && path) {
    return (
      <button type="button" onClick={() => open(path)} title={`Open ${path}`} className="cb-file-link underline">
        {children}
      </button>
    );
  }
  return (
    <a href={href} {...props} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

/** Markdown overrides for replies and the viewer. Stable, so memoised messages don't re-render. */
export const MARKDOWN_COMPONENTS = { pre: CodeBlock, a: Link, code: InlineCode };
/** GitHub-flavoured markdown (tables, task lists, strikethrough, bare links), as Claude writes it. */
export const REMARK_PLUGINS = [remarkGfm];
