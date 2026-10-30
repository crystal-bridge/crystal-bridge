/**
 * What the file viewer treats as a file: inline code in a reply, a link target, a tool's `file_path`. Only names with
 * a known extension (or a well-known extensionless name) count, so `session.start` or `/api/sessions` stay plain
 * code. Whether the file really is in the Quest's folder is the Kingdom's call when it's opened.
 */

const EXTENSIONS = new Set(
  (
    'md mdx markdown txt rst adoc ts tsx js jsx mjs cjs json jsonc json5 yaml yml toml ini cfg conf env example ' +
    'py rb go rs java kt kts swift c h cc cpp hpp cs php lua sh bash zsh fish ps1 sql graphql gql proto ' +
    'html htm css scss sass less vue svelte astro xml svg csv tsv log lock gradle tf hcl nix dockerfile plist ' +
    'service timer'
  ).split(' '),
);

const NAMES = new Set(['Dockerfile', 'Makefile', 'Justfile', 'Procfile', 'LICENSE', 'README', 'CHANGELOG', 'Gemfile']);

const MARKDOWN = new Set(['md', 'mdx', 'markdown']);

/** The last dot-part of a file name, lowercased; undefined without one. */
function extension(path: string): string | undefined {
  const name = path.split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : undefined;
}

/** The file path in a piece of inline code (a trailing `:line` or `:line:col` dropped), if it looks like one. */
export function pathIn(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed.length < 2 || trimmed.length > 300 || /\s/.test(trimmed)) return undefined;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith('//')) return undefined;
  const path = trimmed.replace(/:\d+(?::\d+)?$/, '');
  if (/[()[\]{}<>*?|"'`,;=]/.test(path) || path.endsWith('/')) return undefined;
  const name = path.split('/').pop() ?? '';
  const ext = extension(path);
  if (ext !== undefined && EXTENSIONS.has(ext)) return path;
  return NAMES.has(name) ? path : undefined;
}

/** A markdown link's target, if it points at a file rather than the web: no scheme, not just an anchor. */
export function fileHref(href: string | undefined): string | undefined {
  if (!href || href.startsWith('#') || href.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(href)) return undefined;
  let target = href.split('#')[0]!.split('?')[0]!;
  try {
    target = decodeURIComponent(target);
  } catch {
    return undefined;
  }
  return pathIn(target.replace(/^\.\//, ''));
}

/** A short language name for a code block's header, from the file's extension or well-known name. */
export function languageOf(path: string): string | undefined {
  const name = path.split('/').pop() ?? '';
  if (NAMES.has(name) && name !== 'README' && name !== 'LICENSE' && name !== 'CHANGELOG') return name.toLowerCase();
  return extension(path);
}

export function isMarkdown(path: string): boolean {
  const ext = extension(path);
  return ext !== undefined && MARKDOWN.has(ext);
}

/** "1.2 KB": a file's size for the viewer's header. */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
