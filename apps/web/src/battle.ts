import type { Envelope } from '@crystal-bridge/protocol';
import { sessionInfo } from './info.js';

/** How a turn ended: finished, stopped by the user, or failed. */
export type BattleOutcome = 'victory' | 'retreat' | 'ko';

/** One turn's results, or (for the Quest) the totals across all of them (docs/THEME.md, battle results). */
export interface BattleResult {
  outcome: BattleOutcome;
  turns: number;
  durationMs: number;
  costUsd: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** Files written or edited, relative to the Quest's folder when inside it; sorted. */
  loot: string[];
  /** Subagent types the turn sent out, as the engine names them; the UI picks each one's Class. */
  heroes: string[];
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

function empty(): BattleResult {
  return {
    outcome: 'victory',
    turns: 0,
    durationMs: 0,
    costUsd: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    loot: [],
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
 * everything since the previous `result`. Cost is the change in the CLI's running per-process total, which starts
 * over when a resume starts a new process.
 */
export function battleResults(envelopes: readonly Envelope[]): {
  turns: Map<string, BattleResult>;
  quest: BattleResult;
} {
  const turns = new Map<string, BattleResult>();
  const quest = empty();
  const questLoot = new Set<string>();
  const questHeroes = new Set<string>();
  let cwd: string | undefined;
  let processCost = 0;
  let loot = new Set<string>();
  let heroes: string[] = [];
  let sideQuests = 0;

  const display = (path: string) => (cwd && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path);

  for (const envelope of envelopes) {
    const payload = isObj(envelope.payload) ? envelope.payload : {};
    if (envelope.type === 'session.started') {
      if (typeof payload.cwd === 'string') cwd = payload.cwd;
      continue;
    }
    if (envelope.type === 'session.resumed') {
      processCost = 0;
      continue;
    }
    if (envelope.type !== 'claude.event' || !isObj(payload.raw)) continue;
    const raw = payload.raw;

    if (raw.type === 'assistant' && isObj(raw.message) && Array.isArray(raw.message.content)) {
      for (const block of raw.message.content) {
        if (!isObj(block) || block.type !== 'tool_use' || typeof block.name !== 'string') continue;
        const input = isObj(block.input) ? block.input : {};
        const pathKey = WRITE_TOOLS[block.name];
        const path = pathKey ? input[pathKey] : undefined;
        if (typeof path === 'string') loot.add(display(path));
        if (AGENT_TOOLS.has(block.name))
          heroes.push(typeof input.subagent_type === 'string' ? input.subagent_type : '');
        if (block.name === 'Monitor' || input.run_in_background === true) sideQuests += 1;
      }
    }

    if (raw.type === 'result') {
      const total = num(raw.total_cost_usd);
      const cost = total >= processCost ? total - processCost : total;
      processCost = total;
      const usage = isObj(raw.usage) ? raw.usage : {};
      const turn: BattleResult = {
        outcome: outcomeOf(raw),
        turns: 1,
        durationMs: num(raw.duration_ms),
        costUsd: cost,
        tokens: {
          input: num(usage.input_tokens),
          output: num(usage.output_tokens),
          cacheRead: num(usage.cache_read_input_tokens),
          cacheWrite: num(usage.cache_creation_input_tokens),
        },
        loot: [...loot].sort(),
        heroes: heroes.filter(Boolean),
        sideQuests,
      };
      turns.set(`e${envelope.seq}`, turn);

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
      for (const hero of turn.heroes) questHeroes.add(hero);
      loot = new Set();
      heroes = [];
      sideQuests = 0;
    }
  }

  quest.loot = [...questLoot].sort();
  quest.heroes = [...questHeroes];
  const { context } = sessionInfo(envelopes);
  if (context?.window) quest.mpUsedPct = Math.round((context.used / context.window) * 100);
  return { turns, quest };
}
