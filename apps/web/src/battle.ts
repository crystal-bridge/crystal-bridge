import type { Envelope } from '@crystal-bridge/protocol';
import type { Helper } from './heroes.js';
import { contextRoom, costStep, launchedInBackground, sessionInfo } from './info.js';

/** How a turn ended: finished, stopped by the user, or failed. */
export type BattleOutcome = 'victory' | 'retreat' | 'ko';

/** One turn's results, or (for the Quest) the totals across all of them (docs/THEME.md, battle results). */
export interface BattleResult {
  outcome: BattleOutcome;
  turns: number;
  durationMs: number;
  costUsd: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** Files changed, as the node reports them plus those the file tools wrote; relative to the Quest's folder; sorted. */
  loot: string[];
  /** Pull request links that commands printed. */
  prs: string[];
  /** Subagents the turn sent out; the UI picks each one's Class. */
  heroes: Helper[];
  /** Background commands, monitors and background agents started. */
  sideQuests: number;
  /** For the Quest: how much of the context window its latest request used, as a percentage. */
  mpUsedPct?: number;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown) => (typeof v === 'number' ? v : 0);
const WRITE_TOOLS: Record<string, string> = {
  Write: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
};
const AGENT_TOOLS = new Set(['Task', 'Agent']);
/**
 * A pull or merge request's link alone on a line, the way the tools that open one print it. Output that merely
 * mentions a link (a listing, a log, `gh pr view`) doesn't match, which keeps out work this Quest didn't do.
 */
const PR_LINE = /^https?:\/\/\S+\/(?:pull|pulls|merge_requests|pull-requests)\/\d+\/?$/;

function toolOutput(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => (isObj(part) && typeof part.text === 'string' ? part.text : '')).join('\n');
}

function empty(): BattleResult {
  return {
    outcome: 'victory',
    turns: 0,
    durationMs: 0,
    costUsd: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    loot: [],
    prs: [],
    heroes: [],
    sideQuests: 0,
  };
}

function outcomeOf(raw: Obj): BattleOutcome {
  // An interrupt (Stop) ends a turn as error_during_execution; anything else marked an error is a failure.
  if (raw.subtype === 'error_during_execution') return 'retreat';
  return raw.is_error === true || raw.subtype !== 'success' ? 'ko' : 'victory';
}

/**
 * Each turn's results, keyed by its `result` line's view-item id (`e<seq>`), and the Quest's totals. A turn is
 * everything since the previous `result`. Cost is the change in the CLI's running total (`costStep`).
 */
export function battleResults(envelopes: readonly Envelope[]): {
  turns: Map<string, BattleResult>;
  quest: BattleResult;
} {
  const turns = new Map<string, BattleResult>();
  const quest = empty();
  const questLoot = new Set<string>();
  const questHeroes = new Map<string, Helper>();
  const questPrs = new Set<string>();
  let cwd: string | undefined;
  let runningCost = 0;
  let last: BattleResult | undefined;
  let loot = new Set<string>();
  let prs = new Set<string>();
  let heroes: Helper[] = [];
  let sideQuests = 0;
  const askedForBackground = new Set<string>();

  const display = (path: string) => (cwd && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path);

  for (const envelope of envelopes) {
    const payload = isObj(envelope.payload) ? envelope.payload : {};
    if (envelope.type === 'session.started') {
      if (typeof payload.cwd === 'string') cwd = payload.cwd;
      continue;
    }
    if (envelope.type !== 'claude.event' || !isObj(payload.raw)) continue;
    const raw = payload.raw;

    // Follows its turn's `result`: what the node worked out once that turn had ended.
    if (raw.type === 'system' && raw.subtype === 'turn_changes' && last && Array.isArray(raw.files)) {
      const files = raw.files.filter((file): file is string => typeof file === 'string');
      last.loot = [...new Set([...last.loot, ...files])].sort();
      for (const file of files) questLoot.add(file);
    }

    if (raw.type === 'assistant' && isObj(raw.message) && Array.isArray(raw.message.content)) {
      for (const block of raw.message.content) {
        if (!isObj(block) || block.type !== 'tool_use' || typeof block.name !== 'string') continue;
        const input = isObj(block.input) ? block.input : {};
        const pathKey = WRITE_TOOLS[block.name];
        const path = pathKey ? input[pathKey] : undefined;
        if (typeof path === 'string') loot.add(display(path));
        if (AGENT_TOOLS.has(block.name) && typeof block.id === 'string') {
          heroes.push({
            id: block.id,
            ...(typeof input.subagent_type === 'string' ? { agentType: input.subagent_type } : {}),
            ...(typeof input.description === 'string' ? { description: input.description } : {}),
          });
        }
        if (block.name === 'Monitor' || input.run_in_background === true) {
          sideQuests += 1;
          if (typeof block.id === 'string') askedForBackground.add(block.id);
        }
      }
    }

    if (raw.type === 'user' && isObj(raw.message) && Array.isArray(raw.message.content)) {
      for (const block of raw.message.content) {
        if (!isObj(block) || block.type !== 'tool_result') continue;
        if (launchedInBackground(raw) && !askedForBackground.has(String(block.tool_use_id))) sideQuests += 1;
        for (const line of toolOutput(block.content).split('\n')) {
          if (PR_LINE.test(line.trim())) prs.add(line.trim().replace(/\/$/, ''));
        }
      }
    }

    if (raw.type === 'result') {
      const step = costStep(raw.total_cost_usd, runningCost);
      runningCost = step.running;
      const usage = isObj(raw.usage) ? raw.usage : {};
      const turn: BattleResult = {
        outcome: outcomeOf(raw),
        turns: 1,
        durationMs: num(raw.duration_ms),
        costUsd: step.cost,
        tokens: {
          input: num(usage.input_tokens),
          output: num(usage.output_tokens),
          cacheRead: num(usage.cache_read_input_tokens),
          cacheWrite: num(usage.cache_creation_input_tokens),
        },
        loot: [...loot].sort(),
        prs: [...prs],
        heroes,
        sideQuests,
      };
      turns.set(`e${envelope.seq}`, turn);
      last = turn;

      quest.outcome = turn.outcome;
      quest.turns += 1;
      quest.durationMs += turn.durationMs;
      quest.costUsd += turn.costUsd;
      quest.tokens.input += turn.tokens.input;
      quest.tokens.output += turn.tokens.output;
      quest.tokens.cacheRead += turn.tokens.cacheRead;
      quest.tokens.cacheWrite += turn.tokens.cacheWrite;
      quest.sideQuests += turn.sideQuests;
      for (const file of loot) questLoot.add(file);
      for (const hero of turn.heroes) questHeroes.set(hero.id, hero);
      for (const pr of prs) questPrs.add(pr);
      loot = new Set();
      prs = new Set();
      heroes = [];
      sideQuests = 0;
    }
  }

  quest.loot = [...questLoot].sort();
  quest.heroes = [...questHeroes.values()];
  quest.prs = [...questPrs];
  const { context } = sessionInfo(envelopes);
  const room = contextRoom(context);
  if (context && room) quest.mpUsedPct = Math.round((context.used / room) * 100);
  return { turns, quest };
}
