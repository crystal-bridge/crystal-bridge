import { useEffect, useMemo, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import type { FileReply } from '@crystal-bridge/protocol';
import { fileSize, isMarkdown, languageOf } from '../files.js';
import { hint, w } from '../theme/words.js';
import { CodeBlock } from './CodeBlock.js';
import { FileOpenContext, MARKDOWN_COMPONENTS, REMARK_PLUGINS } from './markdown.js';

/** A file the viewer shows: which Quest, the path asked for, and the Kingdom's answer once it arrives. */
export interface FileViewState {
  session: string;
  requested: string;
  reply?: FileReply;
}

export interface FileViewerProps {
  file: FileViewState;
  onClose: () => void;
  /** Opens another file of the same Quest, e.g. a link in a markdown file. */
  onOpen?: (path: string) => void;
}

/** A link in a markdown file is relative to that file, not to the Quest's folder. */
function besides(current: string, target: string): string {
  if (target.startsWith('/')) return target;
  const parts = current.split('/').slice(0, -1);
  for (const part of target.split('/')) {
    if (part === '..') parts.pop();
    else if (part !== '.' && part !== '') parts.push(part);
  }
  return parts.join('/');
}

function CopyButton({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      data-copied={copied}
      onClick={() =>
        void navigator.clipboard.writeText(text).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          },
          () => {},
        )
      }
      className="cb-copy rounded px-1.5 py-0.5 text-xs hover:bg-neutral-200 dark:hover:bg-neutral-800"
    >
      {copied ? 'Copied' : label}
    </button>
  );
}

/**
 * A Quest's file, read-only, in the side panel (full screen on a phone): markdown rendered, anything else as code.
 * Esc closes it; focus moves in when it opens and back where it was when it closes.
 */
export function FileViewer({ file, onClose, onOpen }: FileViewerProps) {
  const root = useRef<HTMLDivElement>(null);
  const reply = file.reply;
  const path = reply?.path ?? file.requested;

  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    root.current?.focus();
    return () => {
      if (before?.isConnected) before.focus();
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const openBeside = useMemo(() => (onOpen ? (target: string) => onOpen(besides(path, target)) : null), [onOpen, path]);

  return (
    <div
      ref={root}
      tabIndex={-1}
      role="region"
      aria-label={`${w('scroll')}: ${path}`}
      title={hint('scroll')}
      className="flex h-full min-h-0 flex-col outline-none"
    >
      <div className="flex items-center gap-2 border-b border-neutral-300 px-3 py-2 dark:border-neutral-700">
        <button
          type="button"
          onClick={onClose}
          aria-label="Close file"
          className="rounded px-1.5 py-0.5 text-sm text-neutral-600 hover:bg-neutral-200 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          <span className="lg:hidden">‹ Back</span>
          <span aria-hidden className="hidden lg:inline">
            ×
          </span>
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-sm" title={path}>
            {path}
          </div>
          {reply?.ok && reply.size !== undefined && (
            <div className="text-xs text-neutral-500">
              {fileSize(reply.size)}
              {reply.truncated && ' · showing the start only'}
            </div>
          )}
        </div>
        <CopyButton label="Copy path" text={path} />
        {reply?.ok && reply.content !== undefined && <CopyButton label="Copy contents" text={reply.content} />}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3 text-sm [&_pre]:overflow-x-auto [&_pre]:bg-neutral-100 [&_pre]:p-2 [&_pre]:text-xs dark:[&_pre]:bg-neutral-900">
        {!reply ? (
          <p className="text-neutral-500">Opening…</p>
        ) : !reply.ok ? (
          <p className="text-neutral-600 dark:text-neutral-300">
            Can't open this file: {reply.reason ?? 'the Kingdom refused'}.
          </p>
        ) : isMarkdown(path) ? (
          <FileOpenContext.Provider value={openBeside}>
            <div className="cb-prose min-w-0 [overflow-wrap:anywhere] [&_code]:font-mono [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto">
              <Markdown components={MARKDOWN_COMPONENTS} remarkPlugins={REMARK_PLUGINS}>
                {reply.content ?? ''}
              </Markdown>
            </div>
          </FileOpenContext.Provider>
        ) : (
          <CodeBlock>
            <code className={languageOf(path) ? `language-${languageOf(path)}` : undefined}>{reply.content ?? ''}</code>
          </CodeBlock>
        )}
      </div>
    </div>
  );
}
