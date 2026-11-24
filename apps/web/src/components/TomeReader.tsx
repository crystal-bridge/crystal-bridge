/**
 * The Library's reader (docs/LIBRARY.md, "Read the Tomes" and "Open the sealed pages"): a Markdown Tome through the
 * chat's renderer and its safety choices (no raw HTML, safe addresses, remote images as links), plus wiki links,
 * Library images, frontmatter properties, maths, highlighted code and Mermaid diagrams; an HTML Tome in a sandboxed
 * frame; an image as itself. Each add-on is a dynamic `import()` taken only when the Tome holds that kind of content,
 * so none of them weighs on the app's main bundle.
 */
import { type LibraryTome, MAX_TOME_BYTES, parseWikiLink, resolveWikiLink } from '@crystal-bridge/protocol';
import {
  type ComponentPropsWithoutRef,
  type ComponentType,
  createContext,
  isValidElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import Markdown, { type Components, type Options } from 'react-markdown';
import { tomeFileUrl, tomePageUrl } from '../library.js';
import { Icon } from '../theme/icons.js';
import { w } from '../theme/words.js';
import { CodeBlock } from './CodeBlock.js';
import { Image, InLink, InlineCode, Link, REMARK_PLUGINS, safeUrl } from './markdown.js';

type Plugins = NonNullable<Options['remarkPlugins']>;
type MermaidComponent = ComponentType<{ source: string }>;
type YamlParse = (source: string, options: object) => unknown;

/** KaTeX as docs/LIBRARY.md sets it: no links or styles from a formula, and a cap on macro expansion. */
const KATEX_OPTIONS = { trust: false, maxExpand: 1000, strict: 'ignore', throwOnError: false } as const;
/** Frontmatter is plain YAML data: no custom types, and a cap on aliases so an alias bomb fails instead of hanging. */
const YAML_OPTIONS = { schema: 'core', customTags: [], maxAliasCount: 50 } as const;

/**
 * The reader's add-ons, each loaded on first need. An object so a test can spy on what a Tome loads; the reader always
 * calls through it (the module system caches the import itself).
 */
export const addOns = {
  async math() {
    const [{ default: remarkMath }, { default: rehypeKatex }] = await Promise.all([
      import('remark-math'),
      import('rehype-katex'),
      import('katex/dist/katex.min.css'),
    ]);
    return { remarkMath, rehypeKatex };
  },
  /** rehype-highlight with its default language set, lowlight's `common`. */
  async highlight() {
    const [{ default: rehypeHighlight }] = await Promise.all([
      import('rehype-highlight'),
      import('./tomeHighlight.css'),
    ]);
    return rehypeHighlight;
  },
  async mermaid(): Promise<MermaidComponent> {
    return (await import('./MermaidFrame.js')).MermaidFrame;
  },
  async yaml(): Promise<YamlParse> {
    return (await import('yaml')).parse as YamlParse;
  },
};

type Loaded = {
  math?: Awaited<ReturnType<typeof addOns.math>>;
  highlight?: Awaited<ReturnType<typeof addOns.highlight>>;
  mermaid?: MermaidComponent;
  yaml?: YamlParse;
};
/** What this page has loaded so far, so the next Tome starts with it instead of flashing without it. */
const loadedSoFar: Loaded = {};

const FENCE = String.raw`^[ \t>]*(?:\`{3,}|~{3,})[ \t]*`;
const NEEDS = {
  math: new RegExp(String.raw`\$\$|\$[^\s$][^$\n]*\$|${FENCE}math\b`, 'm'),
  highlight: new RegExp(String.raw`${FENCE}(?!mermaid\b|math\b)[\w+#.-]+`, 'm'),
  mermaid: new RegExp(String.raw`${FENCE}mermaid\b`, 'm'),
};

/** Whether a Markdown Tome can be edited in the app: a whole file, read in full, that isn't a link. */
export function canEdit(tome: LibraryTome): boolean {
  return tome.kind === 'md' && !tome.truncated && !tome.link;
}

// ---------- frontmatter ----------

const FRONTMATTER = /^﻿?---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

/** A leading `---` YAML block, apart from the rest of the Tome. */
export function splitFrontmatter(markdown: string): { yaml?: string; body: string } {
  const match = FRONTMATTER.exec(markdown);
  return match ? { yaml: match[1] ?? '', body: markdown.slice(match[0].length) } : { body: markdown };
}

type Front = { properties: [string, unknown][] } | { error: string; raw: string };

function readFront(parse: YamlParse, raw: string): Front | undefined {
  try {
    const data = parse(raw, YAML_OPTIONS);
    if (data === null || data === undefined) return undefined;
    if (typeof data !== 'object' || Array.isArray(data)) return { error: "it isn't a list of properties", raw };
    return { properties: Object.entries(data as Record<string, unknown>) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: message.split('\n', 1)[0]!.slice(0, 200), raw };
  }
}

const MAX_PROPERTIES = 40;
const clip = (text: string) => (text.length > 200 ? `${text.slice(0, 199)}…` : text);
const shown = (value: unknown): string =>
  typeof value === 'string' ? value : value === null || value === undefined ? '' : clip(JSON.stringify(value));

const CHIP =
  'rounded bg-purple-100 px-1.5 py-0.5 text-[11px] font-bold text-purple-900 dark:bg-purple-950 dark:text-purple-200';

function PropertyValue({ name, value }: { name: string; value: unknown }) {
  const tags = /^tags?$/i.test(name);
  const chip = (text: string, key?: number) => (
    <span key={key} className={CHIP}>
      {tags && !text.startsWith('#') ? `#${text}` : text}
    </span>
  );
  if (Array.isArray(value)) return <>{value.slice(0, MAX_PROPERTIES).map((one, i) => chip(shown(one), i))}</>;
  if (tags && typeof value === 'string') return chip(value);
  if (typeof value === 'string') return <span className="text-neutral-800 dark:text-neutral-200">{clip(value)}</span>;
  if (value === null || value === undefined) return <span className="text-neutral-400">–</span>;
  return <span className="font-mono">{shown(value)}</span>;
}

/** Frontmatter as a strip of properties above the Tome; YAML that can't be read shows why, and the block as it is. */
function FrontStrip({ front }: { front: Front }) {
  if ('error' in front) {
    return (
      <div
        role="alert"
        className="mb-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-900 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-100"
      >
        <span className="inline-flex items-center gap-1.5 font-bold">
          <Icon name="markWarning" size={14} />
          The frontmatter couldn't be read: {front.error}
        </span>
        <pre className="mt-1.5 max-h-48 overflow-auto rounded bg-white/60 px-2 py-1 font-mono text-[12px] dark:bg-neutral-950/60">
          {front.raw}
        </pre>
      </div>
    );
  }
  return (
    <div
      role="group"
      aria-label="Properties"
      className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-[12px] dark:border-neutral-800 dark:bg-neutral-900"
    >
      <span className="inline-flex items-center gap-1 font-bold tracking-wide text-neutral-500 uppercase">
        <Icon name="markTag" size={14} />
        Properties
      </span>
      {front.properties.slice(0, MAX_PROPERTIES).map(([name, value]) => (
        <span key={name} className="inline-flex flex-wrap items-center gap-1.5">
          <span className="text-neutral-500">{clip(name)}</span>
          <PropertyValue name={name} value={value} />
        </span>
      ))}
    </div>
  );
}

// ---------- headings and the outline ----------

const slug = (text: string) =>
  text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');

/** The id of the first heading with this text (or GitHub-style anchor), as the reader and the outline give it. */
export const headingId = (text: string) => `tome-${slug(text) || 'section'}`;

function nextId(text: string, seen: Map<string, number>): string {
  const base = headingId(text);
  const count = seen.get(base) ?? 0;
  seen.set(base, count + 1);
  return count ? `${base}-${count}` : base;
}

export interface OutlineEntry {
  depth: number;
  text: string;
  /** The heading's element id in the reader. */
  id: string;
}

/** A heading's text as it reads, without its Markdown: links and wiki links by their label, no emphasis or code marks. */
function plainHeading(raw: string): string {
  return raw
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/!?\[\[([^[\]\n]+?)\]\]/g, (_, inner: string) => wikiLabel(parseWikiLink(inner), inner))
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\\([\\`*_{}[\]()#+\-.!$~])/g, '$1')
    .replace(/[`$]|\*+|~~/g, '')
    .replace(/(^|[^\p{L}\p{N}])_+|_+(?=[^\p{L}\p{N}]|$)/gu, '$1')
    .trim();
}

/**
 * The Tome's headings, in order, with the ids the reader gives them, for the outline beside it. Read line by line:
 * ATX (`#`) and setext (underlined) headings outside fenced code and frontmatter.
 */
export function outlineOf(markdown: string): OutlineEntry[] {
  const lines = splitFrontmatter(markdown).body.split(/\r?\n/);
  const seen = new Map<string, number>();
  const outline: OutlineEntry[] = [];
  const add = (depth: number, raw: string) => {
    const text = plainHeading(raw);
    outline.push({ depth, text, id: nextId(text, seen) });
  };
  let fence: string | undefined;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const opens = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (opens && opens[1]![0] === fence[0] && opens[1]!.length >= fence.length && /^ {0,3}[`~]+[ \t]*$/.test(line))
        fence = undefined;
      continue;
    }
    if (opens) {
      fence = opens[1];
      continue;
    }
    const atx = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (atx) {
      add(atx[1]!.length, atx[2] ?? '');
      continue;
    }
    const next = lines[i + 1];
    if (
      next !== undefined &&
      line.trim() &&
      !/^ {4}|^\s*(?:[-*+>|]|\d+[.)])(?:\s|$)/.test(line) &&
      /^ {0,3}(?:=+|-+)[ \t]*$/.test(next)
    ) {
      add(next.trim().startsWith('=') ? 1 : 2, line);
      i += 1;
    }
  }
  return outline;
}

// ---------- the Markdown tree: wiki links and heading ids ----------

interface MdNode {
  type: string;
  value?: string;
  url?: string;
  alt?: string;
  depth?: number;
  children?: MdNode[];
  data?: { hProperties?: Record<string, unknown> };
}

const IMAGE = /\.(?:png|jpe?g|gif|webp|avif|svg|bmp)$/i;
const WIKI = /(!?)\[\[([^[\]\n]+?)\]\]/g;
/** Nodes whose text is not prose: a wiki link inside them stays as written. */
const NOT_PROSE = new Set(['link', 'linkReference', 'code', 'inlineCode', 'inlineMath', 'math', 'definition', 'html']);

function wikiLabel(link: { target: string; heading?: string; label?: string }, inner: string): string {
  if (link.label) return link.label;
  if (!link.target) return link.heading || inner;
  return link.heading ? `${link.target} > ${link.heading}` : link.target;
}

function wikiNode(embed: boolean, inner: string, paths: readonly string[]): MdNode {
  const link = parseWikiLink(inner);
  const text = [{ type: 'text', value: wikiLabel(link, inner) }];
  const props = (hProperties: Record<string, string>): MdNode => ({
    type: 'link',
    url: '',
    data: { hProperties },
    children: text,
  });
  if (!link.target) return props({ dataHeading: link.heading ?? '' });
  const path = resolveWikiLink(link.target, paths);
  if (!path) return props({ dataMissing: link.target });
  if (embed && IMAGE.test(path))
    return { type: 'image', url: '', alt: link.label ?? link.target, data: { hProperties: { dataTome: path } } };
  return props(link.heading ? { dataTome: path, dataHeading: link.heading } : { dataTome: path });
}

function splitWiki(value: string, paths: readonly string[]): MdNode[] {
  const out: MdNode[] = [];
  let last = 0;
  for (const match of value.matchAll(WIKI)) {
    if (match.index > last) out.push({ type: 'text', value: value.slice(last, match.index) });
    out.push(wikiNode(match[1] === '!', match[2]!, paths));
    last = match.index + match[0].length;
  }
  if (last < value.length) out.push({ type: 'text', value: value.slice(last) });
  return out;
}

function walkWiki(parent: MdNode, paths: readonly string[]): void {
  if (!parent.children) return;
  const out: MdNode[] = [];
  for (const child of parent.children) {
    if (child.type === 'text' && child.value?.includes('[[')) out.push(...splitWiki(child.value, paths));
    else {
      if (!NOT_PROSE.has(child.type)) walkWiki(child, paths);
      out.push(child);
    }
  }
  parent.children = out;
}

/** `[[Page]]`, `[[Page|label]]`, `[[Page#Heading]]` and `![[image.png]]`, resolved as Obsidian does (and the Kingdom). */
function remarkWiki(options: { paths: readonly string[] }) {
  return (tree: MdNode) => walkWiki(tree, options.paths);
}

const mdText = (node: MdNode): string =>
  node.type === 'image' ? '' : (node.value ?? '') + (node.children ?? []).map(mdText).join('');

/** Gives each heading the id `outlineOf` names it by, so `#Heading` links and the outline land on it. */
function remarkHeadingIds() {
  return (tree: MdNode) => {
    const seen = new Map<string, number>();
    const visit = (node: MdNode) => {
      if (node.type === 'heading') {
        node.data = { ...node.data, hProperties: { ...node.data?.hProperties, id: nextId(mdText(node), seen) } };
        return;
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}

// ---------- links and images ----------

interface TomeLinks {
  node: string;
  /** The open Tome's folder, '' at the Library's top. */
  dir: string;
  paths: ReadonlySet<string>;
  onOpen: (path: string, heading?: string) => void;
  onMissing?: ((target: string) => void) | undefined;
  scrollTo: (heading: string) => void;
  Mermaid?: MermaidComponent | undefined;
}

const TomeContext = createContext<TomeLinks | null>(null);
const useLinks = () => useContext(TomeContext)!;

/** A link written relative to the Tome: no scheme, not from the site's root, not just a fragment. */
const isRelative = (href: string) =>
  href !== '' && !/^[a-z][a-z\d+.-]*:/i.test(href) && !href.startsWith('/') && !href.startsWith('#');

/** A relative link's Library path (undefined if it climbs out of the Library) and its fragment. */
function resolveRelative(dir: string, href: string): { path?: string; fragment?: string } {
  const hash = href.indexOf('#');
  const fragment = hash >= 0 ? safeDecode(href.slice(hash + 1)) : undefined;
  const bare = safeDecode((hash >= 0 ? href.slice(0, hash) : href).split('?', 1)[0]!);
  const segments: string[] = dir ? dir.split('/') : [];
  for (const part of bare.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (!segments.length) return fragment === undefined ? {} : { fragment };
      segments.pop();
    } else segments.push(part);
  }
  const path = segments.join('/');
  return fragment === undefined ? { path } : { path, fragment };
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

type DataProps = { 'data-tome'?: string; 'data-heading'?: string; 'data-missing'?: string };

const WIKI_CLASS =
  'cb-wiki font-bold text-purple-700 decoration-purple-300 dark:text-purple-300 dark:decoration-purple-700';

function TomeButton({ path, heading, children }: { path: string; heading?: string | undefined; children: ReactNode }) {
  const { onOpen } = useLinks();
  return (
    <button
      type="button"
      onClick={() => onOpen(path, heading)}
      title={`Open the ${w('tome')}: ${path}`}
      className={WIKI_CLASS}
    >
      <InLink.Provider value={true}>{children}</InLink.Provider>
      {path.toLowerCase().endsWith('.html') && (
        <span className="ml-0.5 inline-block align-[-2px] text-pink-500">
          <Icon name="htmlTome" size={14} />
        </span>
      )}
    </button>
  );
}

/** A link to a Tome that isn't there: drawn apart, and offered for writing where something can write it. */
function MissingTome({ target, children }: { target: string; children: ReactNode }) {
  const { onMissing } = useLinks();
  const className = 'cb-wiki-missing text-neutral-500 decoration-neutral-400 dark:text-neutral-400';
  const content = (
    <>
      <InLink.Provider value={true}>{children}</InLink.Provider>
      <sup aria-hidden="true" className="text-[10px] font-bold text-rose-500">
        ?
      </sup>
    </>
  );
  if (!onMissing) {
    return (
      <span data-missing={target} className={className} title={`No ${w('tome')} named “${target}”`}>
        {content}
      </span>
    );
  }
  return (
    <button
      type="button"
      data-missing={target}
      onClick={() => onMissing(target)}
      className={className}
      title={`No ${w('tome')} named “${target}” yet: click to write it`}
    >
      {content}
    </button>
  );
}

/**
 * Links in a Tome: wiki links and relative links open Tomes in the reader, a fragment scrolls to its heading (the app's
 * own address holds its route, so a fragment never goes there), and everything else is the chat's link, beside the app.
 */
function TomeAnchor(props: ComponentPropsWithoutRef<'a'> & DataProps & { node?: unknown }) {
  const links = useLinks();
  const { href, children } = props;
  const missing = props['data-missing'];
  const tome = props['data-tome'];
  const heading = props['data-heading'];
  if (missing !== undefined) return <MissingTome target={missing}>{children}</MissingTome>;
  if (tome !== undefined)
    return (
      <TomeButton path={tome} heading={heading || undefined}>
        {children}
      </TomeButton>
    );
  const fragment = heading ?? (href?.startsWith('#') ? safeDecode(href.slice(1)) : undefined);
  if (fragment !== undefined) {
    return (
      <button type="button" onClick={() => links.scrollTo(fragment)} className={WIKI_CLASS}>
        <InLink.Provider value={true}>{children}</InLink.Provider>
      </button>
    );
  }
  if (href && isRelative(href)) {
    const { path, fragment: inPage } = resolveRelative(links.dir, href);
    if (path && links.paths.has(path))
      return (
        <TomeButton path={path} heading={inPage}>
          {children}
        </TomeButton>
      );
    return <MissingTome target={path ?? href}>{children}</MissingTome>;
  }
  return <Link {...props} />;
}

/** Images in the Library load through the hub; anything else is the chat's image (remote ones stay links). */
function TomeImage(props: ComponentPropsWithoutRef<'img'> & DataProps & { node?: unknown }) {
  const links = useLinks();
  const { src, alt } = props;
  const tome = props['data-tome'];
  const path = tome ?? (typeof src === 'string' && isRelative(src) ? resolveRelative(links.dir, src).path : undefined);
  if (path) {
    return (
      <img
        src={tomeFileUrl(links.node, path)}
        alt={alt ?? ''}
        title={alt || undefined}
        loading="lazy"
        className="max-w-full rounded-md ring-1 ring-neutral-200 dark:ring-neutral-800"
      />
    );
  }
  return <Image {...props} />;
}

function textOf(children: ReactNode): string {
  if (typeof children === 'string' || typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(textOf).join('');
  if (isValidElement<{ children?: ReactNode }>(children)) return textOf(children.props.children);
  return '';
}

/** Code blocks are the chat's, with its copy button; a `mermaid` block is a diagram once Mermaid's frame has loaded. */
function TomePre(props: ComponentPropsWithoutRef<'pre'> & { node?: unknown }) {
  const { Mermaid } = useLinks();
  const code = Array.isArray(props.children) ? props.children[0] : props.children;
  if (
    Mermaid &&
    isValidElement<{ className?: string; children?: ReactNode }>(code) &&
    /\blanguage-mermaid\b/.test(code.props.className ?? '')
  ) {
    return <Mermaid source={textOf(code.props.children).replace(/\n$/, '')} />;
  }
  return <CodeBlock {...props} />;
}

const COMPONENTS = { pre: TomePre, a: TomeAnchor, code: InlineCode, img: TomeImage } as Components;

// ---------- the reader ----------

export interface TomeReaderProps {
  /** The Kingdom whose Library this is. */
  node: string;
  tome: LibraryTome;
  /** Every file path in the listing, for wiki links and relative links. */
  paths: readonly string[];
  /** Opens a Tome in the reader, at a heading when the link named one. */
  onOpen: (path: string, heading?: string) => void;
  /**
   * A link to a Tome that doesn't exist was clicked: the wiki link's target as written, or a relative link's path.
   * Without it a missing Tome is drawn apart but can't be clicked (the phone, which can't write).
   */
  onMissing?: (target: string) => void;
  /** A heading to scroll to once the Tome is drawn: once per value passed, not again when the Tome is re-read. */
  heading?: string;
  /** The reader scrolled to `heading`; the room lets it go, so a later read of this Tome stays where the user is. */
  onHeading?: () => void;
}

const CUT_KB = Math.round(MAX_TOME_BYTES / 1024);

function CutNotice() {
  return (
    <p
      role="note"
      className="mb-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-[12px] text-amber-900 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-100"
    >
      {w('tome')} cut at {CUT_KB} KB: only its first {CUT_KB} KB is shown, so it can't be edited here.
    </p>
  );
}

/** A Tome that is a symlink is shown, but written only where it points. */
function LinkNotice() {
  return (
    <p
      role="note"
      className="mb-3 rounded-md border border-neutral-200 bg-neutral-50 px-3 py-1.5 text-[12px] text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400"
    >
      This {w('tome')} is a link; edit the file it points to.
    </p>
  );
}

/** A Tome, read: Markdown, an HTML page in its sandbox, or an image. */
export function TomeReader(props: TomeReaderProps) {
  const { tome, node } = props;
  if (tome.kind === 'html') return <HtmlTome node={node} tome={tome} />;
  if (tome.kind === 'image')
    return (
      <img
        src={tomeFileUrl(node, tome.path)}
        alt={tome.path}
        className="mx-auto max-w-full rounded-md ring-1 ring-neutral-200 dark:ring-neutral-800"
      />
    );
  return <MarkdownTome {...props} />;
}

function MarkdownTome({ node, tome, paths, onOpen, onMissing, heading, onHeading }: TomeReaderProps) {
  const article = useRef<HTMLElement>(null);
  const scrollTo = useCallback((text: string) => {
    const id = headingId(text);
    const target = [...(article.current?.querySelectorAll('[id]') ?? [])].find((one) => one.id === id);
    target?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  }, []);
  const { yaml, body } = useMemo(() => splitFrontmatter(tome.content), [tome.content]);
  const needs = useMemo(
    () => ({
      math: NEEDS.math.test(body),
      highlight: NEEDS.highlight.test(body),
      mermaid: NEEDS.mermaid.test(body),
      yaml: yaml !== undefined && yaml.trim() !== '',
    }),
    [body, yaml],
  );
  const [loaded, setLoaded] = useState<Loaded>(() => ({ ...loadedSoFar }));

  useEffect(() => {
    let live = true;
    const take = <K extends keyof Loaded>(name: K, value: Loaded[K]) => {
      loadedSoFar[name] = value;
      if (live) setLoaded((now) => (now[name] === value ? now : { ...now, [name]: value }));
    };
    // A failed load leaves the Tome drawn without that add-on, as it is until it loads.
    const ignore = () => {};
    if (needs.math) addOns.math().then((value) => take('math', value), ignore);
    if (needs.highlight) addOns.highlight().then((value) => take('highlight', value), ignore);
    if (needs.mermaid) addOns.mermaid().then((value) => take('mermaid', value), ignore);
    if (needs.yaml) addOns.yaml().then((value) => take('yaml', value), ignore);
    return () => {
      live = false;
    };
  }, [needs]);

  const front = useMemo(
    () => (yaml !== undefined && loaded.yaml ? readFront(loaded.yaml, yaml) : undefined),
    [yaml, loaded.yaml],
  );

  const math = needs.math ? loaded.math : undefined;
  const highlight = needs.highlight ? loaded.highlight : undefined;
  const remarkPlugins = useMemo<Plugins>(
    () => [...REMARK_PLUGINS, ...(math ? [math.remarkMath] : []), [remarkWiki, { paths }], remarkHeadingIds] as Plugins,
    [math, paths],
  );
  const rehypePlugins = useMemo<Plugins>(
    () =>
      [
        ...(math ? [[math.rehypeKatex, KATEX_OPTIONS]] : []),
        ...(highlight ? [[highlight, { plainText: ['mermaid'] }]] : []),
      ] as Plugins,
    [math, highlight],
  );

  const links = useMemo<TomeLinks>(() => {
    const slash = tome.path.lastIndexOf('/');
    return {
      node,
      dir: slash >= 0 ? tome.path.slice(0, slash) : '',
      paths: new Set(paths),
      onOpen,
      onMissing,
      Mermaid: needs.mermaid ? loaded.mermaid : undefined,
      scrollTo,
    };
  }, [node, tome.path, paths, onOpen, onMissing, needs.mermaid, loaded.mermaid, scrollTo]);

  // Scrolls once per heading asked for; a re-read (new text, new links) leaves the reader where it is.
  const headed = useRef(onHeading);
  headed.current = onHeading;
  useEffect(() => {
    if (!heading) return;
    scrollTo(heading);
    headed.current?.();
  }, [heading, scrollTo]);

  return (
    <article
      ref={article}
      className="cb-prose cb-tome min-w-0 text-[15px] leading-relaxed text-neutral-800 [overflow-wrap:anywhere] dark:text-neutral-200 [&_code]:font-mono [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto"
    >
      {tome.link && <LinkNotice />}
      {tome.truncated && <CutNotice />}
      {front && <FrontStrip front={front} />}
      <TomeContext.Provider value={links}>
        <Markdown
          components={COMPONENTS}
          remarkPlugins={remarkPlugins}
          rehypePlugins={rehypePlugins}
          urlTransform={safeUrl}
        >
          {body}
        </Markdown>
      </TomeContext.Provider>
    </article>
  );
}

// ---------- HTML Tomes ----------

export const HTML_BADGE = "Sandboxed page: can't read the app, but can contact other sites";

/**
 * An HTML Tome in a frame with `sandbox="allow-scripts"` and nothing more, so it runs with an opaque origin and can't
 * read the app's storage, cookies or login (docs/LIBRARY.md, "Open the sealed pages"). The badge says what it can still
 * do. The frame reloads when the file changes.
 */
function HtmlTome({ node, tome }: { node: string; tome: LibraryTome }) {
  const box = useRef<HTMLDivElement>(null);
  const [source, setSource] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const fullScreen = () => {
    const element = box.current;
    if (element && typeof element.requestFullscreen === 'function')
      element.requestFullscreen().catch(() => setExpanded(true));
    else setExpanded(true);
  };

  const button =
    'inline-flex items-center gap-1 rounded border border-neutral-300 px-2 py-1 text-xs font-bold hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800';
  return (
    <div className="flex min-h-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-bold text-amber-900 ring-1 ring-amber-300 dark:bg-amber-950 dark:text-amber-200 dark:ring-amber-800"
          title="It runs in a sandbox with an origin of its own: no access to the app's storage, cookies or login. It can still reach other sites, so open it as you would a web page."
        >
          <Icon name="markWarning" size={14} />
          {HTML_BADGE}
        </span>
        <span className="flex-1" />
        <button type="button" onClick={fullScreen} className={button}>
          Full screen
        </button>
        <button type="button" onClick={() => setSource((on) => !on)} aria-pressed={source} className={button}>
          View source
        </button>
      </div>
      <p className="text-[12px] text-neutral-500 dark:text-neutral-400">
        A page has to inline what it needs: one that loads a library from a CDN shows blank or broken.
      </p>
      {tome.truncated && <CutNotice />}
      {source && (
        <CodeBlock>
          <code className="language-html">{tome.content}</code>
        </CodeBlock>
      )}
      <div
        ref={box}
        className={
          expanded
            ? 'fixed inset-0 z-50 flex flex-col gap-2 bg-white p-2 dark:bg-neutral-950'
            : `${source ? 'hidden' : 'flex'} flex-col overflow-hidden rounded-md border border-pink-300 dark:border-pink-800`
        }
      >
        {expanded && (
          <button type="button" onClick={() => setExpanded(false)} className={`${button} self-end`}>
            Close full screen
          </button>
        )}
        <iframe
          key={tome.version.hash}
          src={tomePageUrl(node, tome.path)}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          title={`${w('tome')}: ${tome.path}`}
          className={`block w-full flex-1 border-0 bg-white ${expanded ? '' : 'min-h-[470px]'}`}
        />
      </div>
    </div>
  );
}
