import { type ComponentPropsWithoutRef, createContext, type ReactNode, useContext } from 'react';
import Markdown, { defaultUrlTransform, type UrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { fileHref, pathIn } from '../files.js';
import { w } from '../theme/words.js';
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

/** Inside a link, where a remote image can't be a link of its own. */
const InLink = createContext(false);

/** Links to files in the Quest open in the viewer; web links open beside the app, never replacing it. */
function Link({ node: _node, href, children, ...props }: ComponentPropsWithoutRef<'a'> & { node?: unknown }) {
  const open = useContext(FileOpenContext);
  const path = fileHref(href);
  if (open && path) {
    return (
      <button type="button" onClick={() => open(path)} title={`Open ${path}`} className="cb-file-link underline">
        <InLink.Provider value={true}>{children}</InLink.Provider>
      </button>
    );
  }
  return (
    <a href={href} {...props} target="_blank" rel="noopener noreferrer">
      <InLink.Provider value={true}>{children}</InLink.Provider>
    </a>
  );
}

/** Whether an image comes from this page's own origin or from the text itself, so showing it tells nobody anything. */
function isLocalImage(src: string): boolean {
  try {
    const url = new URL(src, window.location.href);
    return url.protocol === 'data:' ? /^data:image\//i.test(src) : url.origin === window.location.origin;
  } catch {
    return false;
  }
}

function hostOf(src: string): string {
  try {
    return new URL(src, window.location.href).host;
  } catch {
    return src;
  }
}

/**
 * Text from an agent or a repository can name any address, and an image loads with no click, so one could carry data
 * out in its URL with no tool call and no approval. Those stay links; the hub's Content-Security-Policy backs this up.
 */
function Image({ node: _node, src, alt, ...props }: ComponentPropsWithoutRef<'img'> & { node?: unknown }) {
  const inLink = useContext(InLink);
  const address = typeof src === 'string' ? src : '';
  if (!address) return <>{alt}</>;
  if (isLocalImage(address)) return <img src={address} alt={alt} {...props} />;
  const label = `${w('remoteImage')}: ${alt ? `${alt} ` : ''}(${hostOf(address)})`;
  if (inLink) return <>{label}</>;
  return (
    <a href={address} title={address} target="_blank" rel="noopener noreferrer">
      {label}
    </a>
  );
}

/** Stable, so memoised messages don't re-render. */
const COMPONENTS = { pre: CodeBlock, a: Link, code: InlineCode, img: Image };
/** GitHub-flavoured markdown (tables, task lists, strikethrough, bare links), as Claude writes it. */
const REMARK_PLUGINS = [remarkGfm];

/** The usual safe addresses, plus inline images, which react-markdown would otherwise blank. */
const safeUrl: UrlTransform = (url, key, element) =>
  element.tagName === 'img' && key === 'src' && /^data:image\//i.test(url) ? url : defaultUrlTransform(url);

/** Markdown as the app shows it, in replies and in the viewer. */
export function QuestMarkdown({ children }: { children: string }) {
  return (
    <Markdown components={COMPONENTS} remarkPlugins={REMARK_PLUGINS} urlTransform={safeUrl}>
      {children}
    </Markdown>
  );
}
