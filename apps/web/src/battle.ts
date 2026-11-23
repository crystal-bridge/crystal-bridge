import { lootPath, lootPaths, trophyLinks, type Envelope } from '@crystal-bridge/protocol';
import type { Helper } from './heroes.js';
import { contextRoom, costStep, sessionInfo } from './info.js';
import { AGENT_TOOLS, launchedInBackground } from './model.js';

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
  // Each turn by its `turn.finished`'s seq, which a `turn_changes` line names; a turn with no `result` has none.
  const bySeq = new Map<number, BattleResult>();
  let resulted = false;
  let loot = new Set<string>();
  let prs = new Set<string>();
  let heroes: Helper[] = [];
  let sideQuests = 0;
  const askedForBackground = new Set<string>();

  for (const envelope of envelopes) {
    const payload = isObj(envelope.payload) ? envelope.payload : {};
    if (envelope.type === 'session.started') {
      if (typeof payload.cwd === 'string') cwd = payload.cwd;
      continue;
    }
    if (envelope.type === 'turn.finished') {
      if (resulted && last) bySeq.set(envelope.seq, last);
      resulted = false;
      continue;
    }
    if (envelope.type !== 'claude.event' || !isObj(payload.raw)) continue;
    const raw = payload.raw;

    // What the node worked out once a turn had ended. It names its turn; older lines follow their turn's `result`.
    if (raw.type === 'system' && raw.subtype === 'turn_changes' && Array.isArray(raw.files)) {
      const turn = (typeof raw.turnSeq === 'number' ? bySeq.get(raw.turnSeq) : undefined) ?? last;
      if (turn) {
        const files = raw.files.filter((file): file is string => typeof file === 'string');
        turn.loot = [...new Set([...turn.loot, ...files])].sort();
        for (const file of files) questLoot.add(file);
      }
    }

    for (const path of lootPaths(raw)) loot.add(lootPath(path, cwd));
    if (raw.type === 'assistant' && isObj(raw.message) && Array.isArray(raw.message.content)) {
      for (const block of raw.message.content) {
        if (!isObj(block) || block.type !== 'tool_use' || typeof block.name !== 'string') continue;
        const input = isObj(block.input) ? block.input : {};
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

    for (const link of trophyLinks(raw)) prs.add(link);
    if (raw.type === 'user' && isObj(raw.message) && Array.isArray(raw.message.content)) {
      for (const block of raw.message.content) {
        if (!isObj(block) || block.type !== 'tool_result') continue;
        if (launchedInBackground(raw) && !askedForBackground.has(String(block.tool_use_id))) sideQuests += 1;
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
      resulted = true;

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
