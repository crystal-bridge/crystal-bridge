/**
 * Every themed word the UI shows, in one place, so a fork can swap the theme without touching components. Each
 * concept has the theme's word and the plain term it stands for; the UI shows the plain term as a hint wherever
 * the two differ (docs/THEME.md). Pick a theme at build time with `VITE_CB_THEME` (`crystal`, the default, or
 * `classic`); add one by adding a `Words` object below.
 */
import type { DeedsClosingOutcome } from '@crystal-bridge/protocol';

export interface Word {
  themed: string;
  plain: string;
}

export type Concept =
  | 'home'
  | 'tavern'
  | 'kingdom'
  | 'kingdoms'
  | 'castle'
  | 'quest'
  | 'quests'
  | 'newQuest'
  | 'activeQuests'
  | 'needsYou'
  | 'chronicle'
  | 'recruits'
  | 'config'
  | 'inventory'
  | 'spells'
  | 'items'
  | 'runes'
  | 'gear'
  | 'guild'
  | 'abilities'
  | 'belt'
  | 'party'
  | 'loadingHistory'
  | 'jumpToLatest'
  | 'remoteImage'
  | 'expired'
  | 'sending'
  | 'queuedSend'
  | 'notDelivered'
  | 'starting'
  | 'stats'
  | 'hp'
  | 'stamina'
  | 'roster'
  | 'shipsLog'
  | 'garrison'
  | 'expedition'
  | 'mp'
  | 'gold'
  | 'tokens'
  | 'turns'
  | 'workingTime'
  | 'relayed'
  | 'splitView'
  | 'exitSplit'
  | 'victory'
  | 'retreat'
  | 'defeat'
  | 'questComplete'
  | 'questGoesOn'
  | 'shellMode'
  | 'loot'
  | 'prs'
  | 'heroes'
  | 'sideQuests'
  | 'today'
  | 'thisWeek'
  | 'kos'
  | 'haunts'
  | 'setOutHere'
  | 'adventureLog'
  | 'scroll'
  | 'summons'
  | 'casts'
  | 'summoningCircle'
  | 'scout'
  | 'scouts'
  | 'board'
  | 'boards'
  | 'synthesis'
  | 'counsel'
  | 'patrol'
  | 'patrols'
  | 'watchtower'
  | 'patrolLog'
  | 'nextRun'
  | 'errand'
  | 'errands'
  | 'deed'
  | 'deeds'
  | 'deedsFeed';

export type Words = Record<Concept, Word>;

/** Crystal Bridge's own theme: old-school JRPG words over plain concepts. */
export const CRYSTAL: Words = {
  home: { themed: 'The Airship', plain: 'Home: every Kingdom at a glance, and the hub itself' },
  tavern: { themed: 'Tavern', plain: 'What needs you, and what finished since you looked' },
  kingdom: { themed: 'Kingdom', plain: 'node' },
  kingdoms: { themed: 'Kingdoms', plain: 'nodes' },
  castle: { themed: 'Castle', plain: "this node's home" },
  quest: { themed: 'Quest', plain: 'session' },
  quests: { themed: 'Quests', plain: 'sessions' },
  newQuest: { themed: 'New Quest', plain: 'start a session' },
  activeQuests: { themed: 'Active Quests', plain: 'sessions running or active in the last day' },
  needsYou: { themed: 'Needs you', plain: 'waiting on an approval or a question' },
  chronicle: { themed: 'Chronicle', plain: 'history: older and closed sessions, and search' },
  recruits: { themed: 'Recruits', plain: 'sessions found outside the bridge, to adopt' },
  config: { themed: 'Config', plain: 'settings' },
  inventory: { themed: 'Inventory', plain: 'skills, commands and tools' },
  spells: { themed: 'Spells', plain: 'skills' },
  items: { themed: 'Items', plain: 'slash commands' },
  runes: { themed: 'Runes', plain: 'MCP servers' },
  gear: { themed: 'Equipment', plain: 'plugins' },
  guild: { themed: 'Guild', plain: 'agents' },
  abilities: { themed: 'Abilities', plain: 'hooks' },
  belt: { themed: 'Belt', plain: 'pinned actions' },
  party: { themed: 'Party', plain: 'the agents working in this session' },
  loadingHistory: { themed: 'Unrolling the Chronicle…', plain: 'Loading history…' },
  jumpToLatest: { themed: 'Jump to latest', plain: 'Jump to latest' },
  remoteImage: { themed: 'Remote image', plain: 'Remote image' },
  expired: { themed: 'Expired: the Quest ended before an answer', plain: 'Expired: the session ended first' },
  sending: { themed: 'Sending…', plain: 'Sending…' },
  queuedSend: { themed: 'Queued: goes out when the hub is back', plain: 'Queued until the hub is back' },
  notDelivered: { themed: 'Not delivered: back in the box to send again', plain: 'Not delivered' },
  starting: { themed: 'Setting out…', plain: 'Starting the session…' },
  stats: { themed: 'Stats', plain: "this session's numbers" },
  hp: { themed: 'HP', plain: "plan usage left in this Kingdom's shortest limit, shared by its Quests" },
  stamina: { themed: 'Stamina', plain: "plan usage left in this Kingdom's longer limit, shared by its Quests" },
  expedition: { themed: 'Expedition', plain: 'where and how the session runs' },
  shipsLog: { themed: "Ship's Log", plain: "the hub's release, health and updates" },
  roster: { themed: 'Roster', plain: 'each Hero Class and its level, from the Quests it led' },
  garrison: { themed: 'Garrison', plain: 'the Hero Classes that have led Quests here, with their levels here' },
  mp: { themed: 'MP', plain: 'context left before it compacts' },
  gold: { themed: 'Gold', plain: 'cost' },
  tokens: { themed: 'Tokens', plain: 'tokens used' },
  turns: { themed: 'Turns', plain: 'turns' },
  workingTime: { themed: 'Time', plain: 'how long the turns took, tools included' },
  relayed: { themed: 'Relayed', plain: 'data sent to your devices, all together' },
  splitView: { themed: 'Split the Party', plain: 'Split View: a second Quest side by side' },
  exitSplit: { themed: 'Exit Split Party', plain: 'Exit split view: back to one Quest' },
  victory: { themed: 'Battle won', plain: 'turn finished' },
  retreat: { themed: 'Retreat', plain: 'turn stopped' },
  defeat: { themed: 'KO', plain: 'turn failed' },
  questComplete: { themed: 'Quest complete', plain: 'the Quest is over: its summary' },
  questGoesOn: { themed: 'The Quest goes on · awaiting your orders', plain: 'send a message to continue' },
  shellMode: { themed: 'Command Sigil', plain: 'shell mode: this runs as a command in the Quest’s folder' },
  loot: { themed: 'Loot', plain: 'files changed, by any tool or command' },
  prs: { themed: 'Trophies', plain: 'pull requests opened' },
  heroes: { themed: 'Heroes', plain: 'agents sent out' },
  sideQuests: { themed: 'Side Quests', plain: 'background tasks started' },
  today: { themed: 'Today', plain: 'turns finished since midnight' },
  thisWeek: { themed: 'This week', plain: 'turns finished since Monday' },
  kos: { themed: 'KOs', plain: 'turns that failed' },
  haunts: { themed: 'Haunts', plain: 'the folders you use most' },
  setOutHere: { themed: 'Set out here', plain: 'start a session in this folder' },
  adventureLog: { themed: 'Adventure log', plain: 'recent activity' },
  scroll: { themed: 'Scroll', plain: 'file, read-only' },
  summons: { themed: 'Summons', plain: 'machines reached by SSH' },
  casts: { themed: 'Casts', plain: 'jobs on those machines' },
  summoningCircle: { themed: 'Summoning Circle', plain: 'the machines this Kingdom can use, and their jobs' },
  scout: { themed: 'Scout', plain: 'a scheduled job that collects items' },
  scouts: { themed: 'Scouts', plain: 'scheduled jobs that collect items' },
  board: { themed: 'Board', plain: 'the items a Scout found, to act on' },
  boards: { themed: 'Boards', plain: 'what each Scout found, to act on' },
  synthesis: { themed: 'Augury', plain: 'the synthesis step' },
  counsel: { themed: 'Counsel', plain: 'what to do about the items, as suggested' },
  patrol: { themed: 'Patrol', plain: 'a scheduled Quest or script' },
  patrols: { themed: 'Patrols', plain: 'scheduled Quests and scripts' },
  watchtower: { themed: 'Watchtower', plain: 'this Kingdom’s scheduled Quests and scripts, and their runs' },
  patrolLog: { themed: 'Patrol log', plain: 'what the Patrols posting here reported' },
  nextRun: { themed: 'Next watch', plain: 'next run' },
  errand: { themed: 'Errand', plain: 'a step a Quest left for you to take' },
  errands: { themed: 'Errands', plain: 'steps your Quests left for you to take' },
  deed: { themed: 'Deed', plain: 'a line a Quest wrote about what it achieved' },
  deeds: { themed: 'Deeds', plain: 'lines your Quests wrote about what they achieved' },
  deedsFeed: { themed: 'Deeds', plain: 'what your Quests achieved, day by day' },
};

/** A plain theme: the same concepts with everyday words. */
export const CLASSIC: Words = {
  home: { themed: 'Home', plain: 'Home: every node at a glance, and the hub itself' },
  tavern: { themed: 'For you', plain: 'What needs you, and what finished since you looked' },
  kingdom: { themed: 'Node', plain: 'Node' },
  kingdoms: { themed: 'Nodes', plain: 'Nodes' },
  castle: { themed: 'Overview', plain: 'Overview' },
  quest: { themed: 'Session', plain: 'Session' },
  quests: { themed: 'Sessions', plain: 'Sessions' },
  newQuest: { themed: 'New session', plain: 'New session' },
  activeQuests: { themed: 'Active sessions', plain: 'Active sessions' },
  needsYou: { themed: 'Needs you', plain: 'Needs you' },
  chronicle: { themed: 'History', plain: 'History' },
  recruits: { themed: 'Found sessions', plain: 'Found sessions' },
  config: { themed: 'Settings', plain: 'Settings' },
  inventory: { themed: 'Tools', plain: 'Tools' },
  spells: { themed: 'Skills', plain: 'Skills' },
  items: { themed: 'Commands', plain: 'Commands' },
  runes: { themed: 'MCP servers', plain: 'MCP servers' },
  gear: { themed: 'Plugins', plain: 'Plugins' },
  guild: { themed: 'Agents', plain: 'Agents' },
  abilities: { themed: 'Hooks', plain: 'Hooks' },
  belt: { themed: 'Pinned', plain: 'Pinned' },
  party: { themed: 'Agents', plain: 'Agents' },
  loadingHistory: { themed: 'Loading history…', plain: 'Loading history…' },
  jumpToLatest: { themed: 'Jump to latest', plain: 'Jump to latest' },
  remoteImage: { themed: 'Remote image', plain: 'Remote image' },
  expired: { themed: 'Expired: the session ended first', plain: 'Expired: the session ended first' },
  sending: { themed: 'Sending…', plain: 'Sending…' },
  queuedSend: { themed: 'Queued until the hub is back', plain: 'Queued until the hub is back' },
  notDelivered: { themed: 'Not delivered: back in the box to send again', plain: 'Not delivered' },
  starting: { themed: 'Starting…', plain: 'Starting the session…' },
  stats: { themed: 'Usage', plain: 'Usage' },
  hp: { themed: 'Plan left', plain: "Plan usage left in this node's shortest limit" },
  stamina: { themed: 'Longer limit left', plain: "Plan usage left in this node's longer limit" },
  expedition: { themed: 'Environment', plain: 'Environment' },
  shipsLog: { themed: 'Hub', plain: "The hub's release, health and updates" },
  roster: { themed: 'Agent levels', plain: 'Agent levels' },
  garrison: { themed: 'Agent levels here', plain: 'Agent levels from this node' },
  mp: { themed: 'Context', plain: 'Context left' },
  gold: { themed: 'Cost', plain: 'Cost' },
  tokens: { themed: 'Tokens', plain: 'Tokens' },
  turns: { themed: 'Turns', plain: 'Turns' },
  workingTime: { themed: 'Time', plain: 'Working time' },
  relayed: { themed: 'Data sent', plain: 'Data sent to your devices, all together' },
  splitView: { themed: 'Split view', plain: 'Split view: a second session side by side' },
  exitSplit: { themed: 'Exit split view', plain: 'Exit split view: back to one session' },
  victory: { themed: 'Turn finished', plain: 'Turn finished' },
  retreat: { themed: 'Turn stopped', plain: 'Turn stopped' },
  defeat: { themed: 'Turn failed', plain: 'Turn failed' },
  questComplete: { themed: 'Session summary', plain: 'Session summary: the session is over' },
  questGoesOn: { themed: 'Waiting for your next message', plain: 'Waiting for your next message' },
  shellMode: { themed: 'Shell mode', plain: 'this runs as a command in the session’s folder' },
  loot: { themed: 'Files changed', plain: 'Files changed' },
  prs: { themed: 'Pull requests', plain: 'Pull requests' },
  heroes: { themed: 'Agents', plain: 'Agents' },
  sideQuests: { themed: 'Background tasks', plain: 'Background tasks' },
  today: { themed: 'Today', plain: 'Today' },
  thisWeek: { themed: 'This week', plain: 'This week' },
  kos: { themed: 'Failed', plain: 'Failed turns' },
  haunts: { themed: 'Recent folders', plain: 'Recent folders' },
  setOutHere: { themed: 'New session here', plain: 'New session here' },
  adventureLog: { themed: 'Recent activity', plain: 'Recent activity' },
  scroll: { themed: 'File', plain: 'File, read-only' },
  summons: { themed: 'Machines', plain: 'Machines reached by SSH' },
  casts: { themed: 'Jobs', plain: 'Jobs' },
  summoningCircle: { themed: 'Machines', plain: 'The machines this node can use, and their jobs' },
  // Not "Job": Classic already calls a Cast that.
  scout: { themed: 'Scheduled job', plain: 'Scheduled job' },
  scouts: { themed: 'Scheduled jobs', plain: 'Scheduled jobs' },
  board: { themed: 'Board', plain: 'Board' },
  boards: { themed: 'Boards', plain: 'Boards' },
  synthesis: { themed: 'the synthesis step', plain: 'the synthesis step' },
  counsel: { themed: 'Recommended', plain: 'Recommended' },
  // Not "Scheduled job": Classic already calls a Scout that.
  patrol: { themed: 'Scheduled task', plain: 'Scheduled task' },
  patrols: { themed: 'Scheduled tasks', plain: 'Scheduled tasks' },
  watchtower: { themed: 'Scheduled tasks', plain: 'Scheduled tasks' },
  patrolLog: { themed: 'Scheduled task runs', plain: 'Scheduled task runs' },
  nextRun: { themed: 'Next run', plain: 'Next run' },
  errand: { themed: 'Follow-up', plain: 'a step a Quest left for you to take' },
  errands: { themed: 'Follow-ups', plain: 'steps your Quests left for you to take' },
  deed: { themed: 'Outcome', plain: 'a line a Quest wrote about what it achieved' },
  deeds: { themed: 'Outcomes', plain: 'lines your Quests wrote about what they achieved' },
  deedsFeed: { themed: 'Work log', plain: 'what your Quests achieved, day by day' },
};

export const THEMES: Record<string, Words> = { crystal: CRYSTAL, classic: CLASSIC };

/** The theme this build uses. */
export const words: Words = THEMES[import.meta.env.VITE_CB_THEME ?? 'crystal'] ?? CRYSTAL;

/** Whether this build draws Heroes (sprites) for agents; the Classic theme shows plain status dots instead. */
export const showHeroes: boolean = (import.meta.env.VITE_CB_THEME ?? 'crystal') !== 'classic';

/** Whether this build dresses things in the game's look (menu-window plates and the like); Classic stays plain. */
export const gameLook: boolean = showHeroes;

/** The kinds of step a Quest's leader takes, for words that change with the work (`activity.ts` sets them). */
export type StepKind =
  | 'listen'
  | 'think'
  | 'reply'
  | 'read'
  | 'write'
  | 'run'
  | 'search'
  | 'web'
  | 'delegate'
  | 'ask'
  | 'plan'
  | 'wait'
  | 'tool';

/** Each step kind's themed words (one is picked per step) and its plain meaning. */
type StepWords = Record<StepKind, { themed: string[]; plain: string }>;

const CRYSTAL_STEPS: StepWords = {
  listen: { themed: ['Heeding'], plain: 'reading your message' },
  think: { themed: ['Pondering', 'Plotting'], plain: 'thinking' },
  reply: { themed: ['Scribing'], plain: 'writing a reply' },
  read: { themed: ['Studying', 'Perusing'], plain: 'reading files' },
  write: { themed: ['Forging', 'Inscribing'], plain: 'editing files' },
  run: { themed: ['Casting', 'Invoking'], plain: 'running a command' },
  search: { themed: ['Tracking', 'Hunting'], plain: 'searching' },
  web: { themed: ['Scrying'], plain: 'reading the web' },
  delegate: { themed: ['Rallying'], plain: 'sending out a subagent' },
  ask: { themed: ['Parleying'], plain: 'asking you a question' },
  plan: { themed: ['Charting'], plain: 'updating its plan' },
  wait: { themed: ['Awaiting orders'], plain: 'waiting for you' },
  tool: { themed: ['Wielding'], plain: 'using a tool' },
};

const CLASSIC_STEPS: StepWords = {
  listen: { themed: ['Reading your message'], plain: 'reading your message' },
  think: { themed: ['Thinking'], plain: 'thinking' },
  reply: { themed: ['Replying'], plain: 'writing a reply' },
  read: { themed: ['Reading'], plain: 'reading files' },
  write: { themed: ['Editing'], plain: 'editing files' },
  run: { themed: ['Running'], plain: 'running a command' },
  search: { themed: ['Searching'], plain: 'searching' },
  web: { themed: ['Browsing'], plain: 'reading the web' },
  delegate: { themed: ['Delegating'], plain: 'sending out a subagent' },
  ask: { themed: ['Asking'], plain: 'asking you a question' },
  plan: { themed: ['Planning'], plain: 'updating its plan' },
  wait: { themed: ['Waiting for you'], plain: 'waiting for you' },
  tool: { themed: ['Using a tool'], plain: 'using a tool' },
};

const STEPS = new Map<Words, StepWords>([
  [CRYSTAL, CRYSTAL_STEPS],
  [CLASSIC, CLASSIC_STEPS],
]);

/** A step's word: one of its kind's words, chosen by `seed` (the step's start time), so a step keeps its word. */
export function stepWord(kind: StepKind, seed: number, theme: Words = words): Word {
  const set = (STEPS.get(theme) ?? CRYSTAL_STEPS)[kind];
  const themed = set.themed.at(Math.abs(Math.floor(seed)) % set.themed.length) ?? set.plain;
  return { themed, plain: set.plain };
}

/** The word a concept shows as. */
export function w(concept: Concept, theme: Words = words): string {
  return theme[concept].themed;
}

/** A tooltip naming the plain term too, e.g. "Quest (session)"; just the word when the two are the same. */
export function hint(concept: Concept, theme: Words = words): string {
  const { themed, plain } = theme[concept];
  return themed.toLowerCase() === plain.toLowerCase() ? themed : `${themed} (${plain})`;
}

/** Commands dropped when the hub came back, because they only made sense at the time. Plain words in every theme. */
export function notSentLine(commands: readonly string[]): string {
  return `Not sent while the hub was away: ${commands.join(', ')}. Do it again if you still mean it.`;
}

/** How many sends are waiting for the hub, in the connection banner. */
export function queuedLine(count: number): string {
  return `${count} ${count === 1 ? 'send' : 'sends'} queued.`;
}

/** The Inventory categories a Hero can use something from, as the chat announces it. */
export type UseKind = 'spells' | 'items' | 'runes';

const USE_VERBS: Record<UseKind, string> = { spells: 'casts', items: 'uses', runes: 'invokes' };
const USE_PLAIN: Record<UseKind, string> = { spells: 'skill', items: 'command', runes: 'tool' };

/** The chat's line when a Hero uses an Inventory entry, e.g. "Paladin casts deploy!"; the plain form is the hint. */
export function useLine(kind: UseKind, hero: string, name: string, theme: Words = words): Word {
  const plain = `Used ${USE_PLAIN[kind]}: ${name}`;
  return { themed: theme === CLASSIC ? plain : `${hero} ${USE_VERBS[kind]} ${name}!`, plain };
}

/** What a Scout's last run brought back, e.g. "Your Scout returned with 4 findings."; the plain form is the hint. */
export function scoutReturnLine(count: number, theme: Words = words): Word {
  const plain = `Found ${count} ${count === 1 ? 'item' : 'items'}`;
  if (theme === CLASSIC) return { themed: plain, plain };
  const themed =
    count === 0
      ? 'Your Scout returned empty-handed.'
      : `Your Scout returned with ${count} ${count === 1 ? 'finding' : 'findings'}.`;
  return { themed, plain };
}

/** Where an item's rank and summary came from: absent means its collector, `synthesis` the Kingdom's synthesis step. */
export interface Sourced {
  rank?: number;
  rankSource?: string;
  summary?: string;
  summarySource?: string;
  /** The synthesis step wrote the whole item: one of its extra rows. */
  whole?: boolean;
}

/**
 * Where a Board item's rank and summary came from, for its tooltip, e.g. "Rank 2 · summary from Augury (the synthesis
 * step)", or "Written by ..." for an extra row the step wrote. Plain words in every theme apart from the step's name;
 * undefined when the item has neither. An empty summary, which the Board doesn't show, counts as none.
 */
export function sourceLine(item: Sourced, theme: Words = words): string | undefined {
  const from = (source: string | undefined) =>
    source === undefined ? 'the collector' : source === 'synthesis' ? hint('synthesis', theme) : `"${source}"`;
  const rank = item.rank === undefined ? undefined : `Rank ${item.rank}`;
  if (item.whole) {
    const written = `ritten by ${from(item.summarySource)}`;
    return rank ? `${rank} · w${written}` : `W${written}`;
  }
  const summary = item.summary ? from(item.summarySource) : undefined;
  if (rank && summary) {
    const rankFrom = from(item.rankSource);
    return rankFrom === summary
      ? `${rank} · rank and summary from ${summary}`
      : `${rank}, from ${rankFrom} · summary from ${summary}`;
  }
  if (rank) return `${rank}, from ${from(item.rankSource)}`;
  return summary && `Summary from ${summary}`;
}

/** A Board's new items, e.g. "3 new postings on the Quest Board."; a name that doesn't end in Board gets the word. */
export function postingsLine(count: number, board: string, theme: Words = words): Word {
  const plain = `${count} new on ${board}`;
  if (theme === CLASSIC) return { themed: plain, plain };
  const named = /\bboard$/i.test(board) ? board : `${board} Board`;
  return { themed: `${count} new ${count === 1 ? 'posting' : 'postings'} on the ${named}.`, plain };
}

/** The chat's line when a Quest starts a Cast, e.g. "You summoned Shiva!". */
export function summonLine(summon: string, theme: Words = words): Word {
  const plain = `Started a job on ${summon}`;
  return { themed: theme === CLASSIC ? plain : `You summoned ${summon}!`, plain };
}

/**
 * A Quest's name as this theme shows it: the title it gave itself, in plain words in Classic. A first prompt or a name
 * set by hand has no plain form, so every theme shows it as it is.
 */
export function questLabel(quest: { label: string; plainLabel?: string | undefined }, theme: Words = words): string {
  return theme === CLASSIC && quest.plainLabel ? quest.plainLabel : quest.label;
}

/**
 * The chat's line when a Quest names itself, e.g. "The Bard names your Quest: The Siege of the Flaky Smoke Test.". The
 * Bard is the party's narrator, who only ever speaks here. `named` false is a call that failed or gave no name.
 */
export function titledLine(title: string, plain: string, theme: Words = words, named = true): Word {
  if (!named) {
    const failed = 'Naming this session failed';
    return { themed: theme === CLASSIC ? failed : `The Bard could not name your ${w('quest', theme)}.`, plain: failed };
  }
  const line = `Named this session: ${plain}`;
  // A title that ends on its own stop ("Why Is CI Red?") keeps it, rather than gaining a second.
  const stop = /[.!?…]$/.test(title) ? '' : '.';
  return {
    themed: theme === CLASSIC ? line : `The Bard names your ${w('quest', theme)}: ${title}${stop}`,
    plain: line,
  };
}

/**
 * The chat's line when a turn left Errands, e.g. "Your Quest left you 2 Errands.". Zero is a call that failed.
 */
export function errandsLeftLine(count: number, theme: Words = words): Word {
  if (count <= 0) {
    const failed = 'Leaving a follow-up failed';
    return {
      themed: theme === CLASSIC ? failed : `Your ${w('quest', theme)} couldn’t leave you an ${w('errand', theme)}.`,
      plain: failed,
    };
  }
  const plain = count === 1 ? 'Left you a follow-up' : `Left you ${count} follow-ups`;
  if (theme === CLASSIC) {
    const noun = (count === 1 ? w('errand', theme) : w('errands', theme)).toLowerCase();
    return { themed: `This session left you ${count === 1 ? 'a' : count} ${noun}.`, plain };
  }
  const what = count === 1 ? `an ${w('errand', theme)}` : `${count} ${w('errands', theme)}`;
  return { themed: `Your ${w('quest', theme)} left you ${what}.`, plain };
}

/**
 * How many Errands something left, mid-sentence, e.g. "left 2 Errands" on a Patrol's report. Classic's noun is a
 * plain word, so it stays lowercase there ("left a follow-up"), as in `errandsLeftLine`.
 */
export function errandsLeftPhrase(count: number, theme: Words = words): string {
  const lower = (word: string) => (theme === CLASSIC ? word.toLowerCase() : word);
  if (count !== 1) return `left ${count} ${lower(w('errands', theme))}`;
  const one = lower(w('errand', theme));
  return `left ${/^[aeiou]/i.test(one) ? 'an' : 'a'} ${one}`;
}

/** Where the Errands a turn left wait, after `errandsLeftLine` in the chat: "It waits" for one, "They wait" for more. */
export function errandsWaitLine(count: number, theme: Words = words): string {
  const wait = count === 1 ? 'It waits' : 'They wait';
  return theme === CLASSIC
    ? `${wait} in the side panel and on the Overview page.`
    : `${wait} in the side panel and on the ${w('castle', theme)}.`;
}

/**
 * The Errands panels' lines that name a theme noun. Classic's nouns are plain words, so they stay lowercase
 * mid-sentence ("Add a follow-up"), as in `errandsLeftPhrase`.
 */
export function errandWords(theme: Words = words) {
  const lower = (word: string) => (theme === CLASSIC ? word.toLowerCase() : word);
  const one = lower(w('errand', theme));
  const many = lower(w('errands', theme));
  return {
    add: `Add ${/^[aeiou]/i.test(one) ? 'an' : 'a'} ${one}`,
    edit: `Edit this ${one}`,
    byYou: `A new ${one}, written by you`,
    noneOpen: `No open ${many}.`,
    questLeft: `Steps this ${lower(w('quest', theme))} left for you`,
    show: `Show the ${many}`,
    showHint: `Show this ${lower(w('quest', theme))}’s ${many} in the side panel`,
    loadFailed: `Couldn’t load ${many}.`,
  };
}

/** What can happen to a helper, as the chat tells it. */
export type HelperMoment = 'set-out' | 'returned' | 'failed' | 'stopped';

/** The chat's line for a helper leaving or coming back, e.g. "Wizard sets out: Security review!". */
export function helperLine(moment: HelperMoment, hero: string, task: string, theme: Words = words): Word {
  const line: Record<HelperMoment, Word> = {
    'set-out': { themed: `${hero} sets out: ${task}!`, plain: `Started a subagent: ${task}` },
    returned: { themed: `${hero} returns from ${task}!`, plain: `Subagent finished: ${task}` },
    failed: { themed: `${hero} was KO’d on ${task}!`, plain: `Subagent failed: ${task}` },
    stopped: { themed: `${hero} was KO’d on ${task}!`, plain: `Subagent stopped: ${task}` },
  };
  const { themed, plain } = line[moment];
  return { themed: theme === CLASSIC ? plain : themed, plain };
}

/** How a tool call stands. */
export type ToolState = 'running' | 'done' | 'error' | 'denied';

/**
 * A tool call's chip. A running one follows the Class doing the work (`work`, its animation): a spellcaster is Casting
 * and anyone else Attacking. Anything that doesn't map this cleanly stays in plain words.
 */
export function toolChip(state: ToolState, work?: string, theme: Words = words): Word {
  const plain = { running: 'running', done: 'done', error: 'failed', denied: 'denied' }[state];
  const themed = {
    running: work === 'spellcast' ? 'Casting' : 'Attacking',
    done: 'Success',
    error: 'Miss',
    denied: 'Blocked',
  }[state];
  return { themed: theme === CLASSIC ? plain : themed, plain };
}

/** What `castLine` needs to know about a Cast. */
export interface CastLineInput {
  name: string;
  state: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'lost';
  queued?: boolean | undefined;
  exitCode?: number | undefined;
  progress?: { done: number; total: number } | undefined;
}

/** How a Cast stands as a game would print it, e.g. "Shiva is casting Video Upscaler! 12/50"; the plain form is the hint. */
export function castLine(cast: CastLineInput, summon: string, theme: Words = words): Word {
  const { name, state, queued, exitCode, progress } = cast;
  const count = progress ? ` ${progress.done}/${progress.total}` : '';
  const code = exitCode === undefined ? '' : ` (${exitCode})`;
  const line: Record<CastLineInput['state'], Word> = {
    running: queued
      ? { themed: `${name} awaits its turn on ${summon}`, plain: 'Waiting for its turn' }
      : { themed: `${summon} is casting ${name}!${count}`, plain: `Running${count}` },
    succeeded: { themed: `${name} landed!`, plain: 'Finished' },
    failed: {
      themed: `${name} fizzled!${code}`,
      plain: exitCode === undefined ? 'Failed' : `Failed with exit code ${exitCode}`,
    },
    cancelled: { themed: `${name} was dispelled!`, plain: 'Cancelled' },
    lost: { themed: `${summon} vanished!`, plain: 'Lost: the job is gone and has no result' },
  };
  const { themed, plain } = line[state];
  return { themed: theme === CLASSIC ? `${name} on ${summon}: ${plain}` : themed, plain };
}

/** How a Patrol run ended (`PatrolRunOutcome`), in the theme's run words; an outcome a newer Kingdom sends shows as it is. */
export function patrolOutcomeWord(outcome: string, theme: Words = words): Word {
  const plain: Record<string, string> = {
    running: 'Running',
    finished: 'Finished',
    failed: 'Failed',
    'needs-you': 'Needs you: a prompt waited longer than the Patrol allows',
    'timed-out': 'Timed out',
    skipped: 'Skipped: the last run was still out',
    missed: 'Missed: past its catch-up window',
  };
  const themed: Record<string, string> = {
    running: 'Set out',
    finished: 'Returned',
    failed: 'Turned back',
    'needs-you': 'Waiting on you',
    'timed-out': 'Out too long',
    skipped: 'Still out',
    missed: 'Missed its watch',
  };
  if (!Object.hasOwn(plain, outcome)) return { themed: outcome, plain: outcome };
  const word = plain[outcome]!;
  if (theme === CLASSIC) {
    const short = word.split(':')[0]!;
    return { themed: short, plain: short };
  }
  return { themed: themed[outcome]!, plain: word };
}

/** How a Patrol stands (`PatrolStanding` in patrols.ts), in the theme's words. */
export function patrolStandingWord(
  standing: 'broken' | 'stood-down' | 'out' | 'waiting' | 'failing' | 'on-watch',
  theme: Words = words,
): Word {
  const line: Record<typeof standing, Word> = {
    broken: { themed: 'Can’t set out', plain: 'Its patrol.json doesn’t load' },
    'stood-down': { themed: 'Stood down', plain: 'Paused' },
    out: { themed: 'Out on patrol', plain: 'Running' },
    waiting: { themed: 'Waiting on you', plain: 'Needs you' },
    failing: { themed: 'On watch', plain: 'Scheduled, after a failed run' },
    'on-watch': { themed: 'On watch', plain: 'Scheduled' },
  };
  const { themed, plain } = line[standing];
  return theme === CLASSIC ? { themed: plain, plain } : { themed, plain };
}

/** The chat's line when a Quest recorded a Deed in a turn. */
export function deedRecordedLine(theme: Words = words): Word {
  const plain = 'Recorded an outcome';
  return {
    themed:
      theme === CLASSIC
        ? `${w('deed', theme)} recorded.`
        : `A new ${w('deed', theme)} is recorded in the annals of the ${w('kingdom', theme)}.`,
    plain,
  };
}

/** The chat's line when a Quest's `deed` call failed. */
export function deedRefusedLine(theme: Words = words): Word {
  const plain = 'Recording an outcome failed';
  return {
    themed: theme === CLASSIC ? plain : `Your ${w('quest', theme)} couldn’t record a ${w('deed', theme)}.`,
    plain,
  };
}

const CLOSING_REASONS: Record<Exclude<DeedsClosingOutcome, 'writing' | 'recorded'>, string> = {
  empty: 'the call wrote none',
  timeout: 'the call took too long',
  budget: 'the call went over its budget',
  failed: 'the call failed',
  unreadable: 'the Quest’s transcript couldn’t be read',
};

/** The chat's line at Close for how the call that writes the Deeds went. */
export function closingLine(outcome: DeedsClosingOutcome, theme: Words = words): Word {
  const classic = theme === CLASSIC;
  if (outcome === 'writing') {
    return {
      themed: classic ? 'Writing a summary…' : `Your ${w('quest', theme)} is writing its ${w('deeds', theme)}…`,
      plain: 'Writing a summary…',
    };
  }
  if (outcome === 'recorded') {
    return {
      themed: classic
        ? 'Summary recorded.'
        : `Your ${w('quest', theme)}’s ${w('deeds', theme)} are recorded in the annals of the ${w('kingdom', theme)}.`,
      plain: 'Summary recorded.',
    };
  }
  const reason = CLOSING_REASONS[outcome];
  const plain = `No summary recorded: ${reason}.`;
  return { themed: classic ? plain : `No ${w('deeds', theme)} recorded: ${reason}.`, plain };
}

/** Why a `writing` line that never got its outcome reads as stopped: Crystal went away mid-call. */
export function closingStoppedReason(theme: Words = words): string {
  return `Crystal stopped before the ${theme === CLASSIC ? 'summary' : w('deeds', theme)} came back.`;
}

/** The Deeds' short lines: the Close dialog's greyed reasons, a Quest's empty side panel, where a Deed came from. */
export function deedsText(theme: Words = words): {
  tooOld: string;
  noTurn: string;
  none: string;
  fromClose: string;
  fromTurn: string;
} {
  const classic = theme === CLASSIC;
  const deeds = classic ? w('deeds', theme).toLowerCase() : w('deeds', theme);
  const close = classic ? 'close' : 'Close';
  return {
    tooOld: `This ${classic ? w('kingdom', theme).toLowerCase() : w('kingdom', theme)} is too old to record ${deeds} at ${close}.`,
    noTurn: 'No finished turn to record.',
    none: 'None yet.',
    fromClose: `From ${close}`,
    fromTurn: 'From a turn',
  };
}

/** The empty feed's card: the annals of a Kingdom (or of the chosen project) are blank, and a way back to all. */
export function deedsEmptyLines(
  place: string,
  filtered: boolean,
  theme: Words = words,
): { title: string; line: string; showAll: string } {
  const classic = theme === CLASSIC;
  const deeds = classic ? w('deeds', theme).toLowerCase() : w('deeds', theme);
  const quest = classic ? w('quest', theme).toLowerCase() : w('quest', theme);
  return {
    title: classic ? `Nothing recorded in ${place} yet` : `The annals of ${place} are still blank`,
    line: filtered
      ? `No ${deeds} in this project yet. When a ${quest} there finishes a turn, it shows here.`
      : `No ${deeds} yet. When a ${quest} finishes a turn, it shows here.`,
    showAll: 'Show all projects',
  };
}

export type QuestStanding =
  { kind: 'open' } | { kind: 'deeds' } | { kind: 'closed'; why: 'skipped' | Exclude<DeedsClosingOutcome, 'recorded'> };

const STANDING_WHY: Record<Exclude<QuestStanding, { kind: 'open' | 'deeds' }>['why'], string> = {
  skipped: 'skipped',
  writing: 'still writing',
  timeout: 'too long',
  budget: 'over budget',
  empty: 'nothing written',
  failed: 'the call failed',
  unreadable: 'transcript unreadable',
};

/** A Quest's standing in the feed: still open, closed with Deeds, or closed and why it has none. */
export function questStandingWord(standing: QuestStanding, theme: Words = words): Word {
  if (standing.kind === 'open') return { themed: 'Still open', plain: 'Still open' };
  if (standing.kind === 'deeds') {
    return {
      themed: `Closed with ${theme === CLASSIC ? w('deeds', theme).toLowerCase() : w('deeds', theme)}`,
      plain: 'Closed with outcomes',
    };
  }
  const text = `Closed · ${STANDING_WHY[standing.why]}`;
  return { themed: text, plain: text };
}

/** The Close dialog's choice to have the Quest's Deeds written. */
export function recordDeedsChoice(theme: Words = words): { label: string; hint: string } {
  const noun = theme === CLASSIC ? w('deeds', theme).toLowerCase() : w('deeds', theme);
  return {
    label: `Record its ${noun}`,
    hint: `Writes the ${theme === CLASSIC ? w('quest', theme).toLowerCase() : w('quest', theme)}’s ${noun} from a short digest of it, for a few cents.`,
  };
}
