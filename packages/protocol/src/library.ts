import { z } from 'zod';

/** The largest text file (a Tome) the Library reads or writes, in UTF-8 bytes. */
export const MAX_TOME_BYTES = 512 * 1024;
/** The largest image the Library sends. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** The most entries one listing carries; a longer one says `truncated`. */
export const MAX_LISTING = 10_000;
/** The most paths one `library-changed` names; past that a node sends `all`. */
export const MAX_CHANGED_PATHS = 200;

/** A path inside the Library, with `/` separators. */
export const LibraryPath = z.string().min(1).max(1024);
export type LibraryPath = z.infer<typeof LibraryPath>;

export const LibraryEntryKind = z.enum(['folder', 'md', 'html', 'image']);
export type LibraryEntryKind = z.infer<typeof LibraryEntryKind>;

export const LibraryEntry = z.object({
  path: LibraryPath,
  kind: LibraryEntryKind,
  size: z.number().int().nonnegative().optional(),
  mtimeMs: z.number().nonnegative().optional(),
});
export type LibraryEntry = z.infer<typeof LibraryEntry>;

/** What a Tome was when read: a write names it as its `base`, so a change made meanwhile is not overwritten. */
export const TomeVersion = z.object({
  size: z.number().int().nonnegative(),
  mtimeMs: z.number().nonnegative(),
  /** SHA-256 of the file's bytes, lowercase hex. */
  hash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type TomeVersion = z.infer<typeof TomeVersion>;

const requestId = z.uuid();

/** Hub -> node: list the Library. */
export const HubLibraryList = z.object({ kind: z.literal('library-list'), requestId });
export type HubLibraryList = z.infer<typeof HubLibraryList>;

/** Hub -> node: read a Tome, or an image (`as: 'image'`). */
export const HubLibraryRead = z.object({
  kind: z.literal('library-read'),
  requestId,
  path: LibraryPath,
  as: z.literal('image').optional(),
});
export type HubLibraryRead = z.infer<typeof HubLibraryRead>;

/** Hub -> node: write a Tome. `base` is the version the writer read, or null for a new file. */
export const HubLibraryWrite = z.object({
  kind: z.literal('library-write'),
  requestId,
  path: LibraryPath,
  content: z.string().refine((s) => new TextEncoder().encode(s).length <= MAX_TOME_BYTES, {
    error: 'a Tome is at most 512 KB',
  }),
  base: TomeVersion.nullable(),
});
export type HubLibraryWrite = z.infer<typeof HubLibraryWrite>;

/** Hub -> node: which Tomes link to this one. */
export const HubLibraryBacklinks = z.object({ kind: z.literal('library-backlinks'), requestId, path: LibraryPath });
export type HubLibraryBacklinks = z.infer<typeof HubLibraryBacklinks>;

export const LibraryTome = z.object({
  path: LibraryPath,
  kind: z.enum(['md', 'html', 'image']),
  content: z.string(),
  encoding: z.enum(['utf8', 'base64']),
  truncated: z.boolean(),
  version: TomeVersion,
});
export type LibraryTome = z.infer<typeof LibraryTome>;

export const LibraryBacklink = z.object({ path: LibraryPath, line: z.string() });
export type LibraryBacklink = z.infer<typeof LibraryBacklink>;

/** Node -> hub: the answer to any of the four requests; which fields are set depends on the request. */
export const NodeLibraryAnswer = z.object({
  kind: z.literal('library-answer'),
  requestId,
  ok: z.boolean(),
  /** Why a request failed; a refused write says `changed` and carries the file's current `version`. */
  reason: z.string().max(300).optional(),
  entries: z.array(LibraryEntry).max(MAX_LISTING).optional(),
  truncated: z.boolean().optional(),
  tome: LibraryTome.optional(),
  version: TomeVersion.optional(),
  backlinks: z.array(LibraryBacklink).optional(),
});
export type NodeLibraryAnswer = z.infer<typeof NodeLibraryAnswer>;

/** Node -> hub: files in the Library changed; `all` when too many to name. */
export const NodeLibraryChanged = z.object({
  kind: z.literal('library-changed'),
  paths: z.array(LibraryPath).max(MAX_CHANGED_PATHS).optional(),
  all: z.boolean().optional(),
});
export type NodeLibraryChanged = z.infer<typeof NodeLibraryChanged>;

/** Hub -> clients: the same, for one Kingdom. */
export const LibraryChangedFrame = z.object({
  kind: z.literal('library-changed'),
  node: z.string(),
  paths: z.array(LibraryPath).max(MAX_CHANGED_PATHS).optional(),
  all: z.boolean().optional(),
});
export type LibraryChangedFrame = z.infer<typeof LibraryChangedFrame>;

/** Where a Kingdom's Library lives, as its hello says. */
export const LibraryInfo = z.object({ dir: z.string().min(1).max(4096) });
export type LibraryInfo = z.infer<typeof LibraryInfo>;

/** Splits the inside of `[[...]]` into its page, heading and label. */
export function parseWikiLink(inner: string): { target: string; heading?: string; label?: string } {
  let rest = inner;
  let label: string | undefined;
  const bar = rest.indexOf('|');
  if (bar >= 0) {
    label = rest.slice(bar + 1);
    rest = rest.slice(0, bar);
  }
  let heading: string | undefined;
  const hash = rest.indexOf('#');
  if (hash >= 0) {
    heading = rest.slice(hash + 1);
    rest = rest.slice(0, hash);
  }
  const out: { target: string; heading?: string; label?: string } = { target: rest.trim() };
  if (heading !== undefined) out.heading = heading.trim();
  if (label !== undefined) out.label = label.trim();
  return out;
}

/**
 * Finds the file a wiki link names, the way Obsidian does: by file name without `.md` (other kinds keep their
 * extension), case-folded. A target with `/` matches a path equal to it or ending in `/<target>`. Ties go to the
 * fewest path segments, then alphabetical.
 */
export function resolveWikiLink(target: string, paths: readonly string[]): string | undefined {
  const want = target.trim().toLowerCase();
  if (!want) return undefined;
  const matches = paths.filter((p) => {
    const full = p.toLowerCase();
    const bare = full.endsWith('.md') ? full.slice(0, -3) : full;
    for (const name of [bare, full]) {
      if (name === want || name.endsWith(`/${want}`)) return true;
    }
    return false;
  });
  matches.sort((a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : a > b ? 1 : 0));
  return matches[0];
}
