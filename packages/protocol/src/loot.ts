/**
 * The Loot and Trophy rules: which files a raw stream-json line's file tools wrote, and which pull request links its
 * tool results printed. The browser's Battle Results and Crystal's `turn.tally` count with these, so both agree
 * (docs/DEEDS.md).
 */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

export const WRITE_TOOLS: Record<string, string> = {
  Write: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
};

/**
 * A pull or merge request's link alone on a line, the way the tools that open one print it. Output that merely
 * mentions a link (a listing, a log, `gh pr view`) doesn't match, which keeps out work this Quest didn't do.
 */
export const PR_LINE = /^https?:\/\/\S+\/(?:pull|pulls|merge_requests|pull-requests)\/\d+\/?$/;

function toolOutput(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => (isObj(part) && typeof part.text === 'string' ? part.text : '')).join('\n');
}

/** The paths the file tools in an `assistant` line wrote, in order, as the tools were given them. */
export function lootPaths(raw: unknown): string[] {
  if (!isObj(raw) || raw.type !== 'assistant' || !isObj(raw.message) || !Array.isArray(raw.message.content)) return [];
  const paths: string[] = [];
  for (const block of raw.message.content) {
    if (!isObj(block) || block.type !== 'tool_use' || typeof block.name !== 'string') continue;
    const input = isObj(block.input) ? block.input : {};
    const key = WRITE_TOOLS[block.name];
    const path = key ? input[key] : undefined;
    if (typeof path === 'string') paths.push(path);
  }
  return paths;
}

/** A path relative to the Quest's folder when it's inside it; otherwise as it is. */
export function lootPath(path: string, cwd: string | undefined): string {
  return cwd && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path;
}

/** The pull request links a `user` line's tool results printed alone on a line, once each, without a trailing slash. */
export function trophyLinks(raw: unknown): string[] {
  if (!isObj(raw) || raw.type !== 'user' || !isObj(raw.message) || !Array.isArray(raw.message.content)) return [];
  const links = new Set<string>();
  for (const block of raw.message.content) {
    if (!isObj(block) || block.type !== 'tool_result') continue;
    for (const line of toolOutput(block.content).split('\n')) {
      if (PR_LINE.test(line.trim())) links.add(line.trim().replace(/\/$/, ''));
    }
  }
  return [...links];
}
