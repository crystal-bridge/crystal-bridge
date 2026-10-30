/**
 * Every themed word the UI shows, in one place, so a fork can swap the theme without touching components. Each
 * concept has the theme's word and the plain term it stands for; the UI shows the plain term as a hint wherever
 * the two differ (docs/THEME.md). Pick a theme at build time with `VITE_CB_THEME` (`crystal`, the default, or
 * `classic`); add one by adding a `Words` object below.
 */
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
  | 'equipment'
  | 'relics'
  | 'guild'
  | 'abilities'
  | 'belt'
  | 'party'
  | 'loadingHistory'
  | 'jumpToLatest'
  | 'stats'
  | 'hp'
  | 'roster'
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
  | 'heroes'
  | 'sideQuests'
  | 'today'
  | 'thisWeek'
  | 'kos'
  | 'haunts'
  | 'setOutHere'
  | 'adventureLog'
  | 'scroll';

export type Words = Record<Concept, Word>;

/** Crystal Bridge's own theme: old-school JRPG words over plain concepts. */
export const CRYSTAL: Words = {
  home: { themed: 'The Airship', plain: 'Home' },
  tavern: { themed: 'Tavern', plain: "What's waiting on you" },
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
  equipment: { themed: 'Equipment', plain: 'MCP servers' },
  relics: { themed: 'Relics', plain: 'plugins' },
  guild: { themed: 'Guild', plain: 'agents' },
  abilities: { themed: 'Abilities', plain: 'hooks' },
  belt: { themed: 'Belt', plain: 'pinned actions' },
  party: { themed: 'Party', plain: 'the agents working in this session' },
  loadingHistory: { themed: 'Unrolling the Chronicle…', plain: 'Loading history…' },
  jumpToLatest: { themed: 'Jump to latest', plain: 'Jump to latest' },
  stats: { themed: 'Stats', plain: "this session's numbers" },
  hp: { themed: 'HP', plain: "plan usage left in this Kingdom's 5-hour window, shared by its Quests" },
  expedition: { themed: 'Expedition', plain: 'where and how the session runs' },
  roster: { themed: 'Roster', plain: 'each Hero Class and its level, from the Quests it led' },
  mp: { themed: 'MP', plain: 'context left' },
  gold: { themed: 'Gold', plain: 'cost' },
  tokens: { themed: 'Tokens', plain: 'tokens used' },
  turns: { themed: 'Turns', plain: 'turns' },
  workingTime: { themed: 'Time', plain: 'time spent working' },
  relayed: { themed: 'Relayed', plain: 'data sent to your devices, all together' },
  splitView: { themed: 'Split the Party', plain: 'Split View: a second Quest side by side' },
  exitSplit: { themed: 'Exit Split Party', plain: 'Exit split view: back to one Quest' },
  victory: { themed: 'Battle won', plain: 'turn finished' },
  retreat: { themed: 'Retreat', plain: 'turn stopped' },
  defeat: { themed: 'KO', plain: 'turn failed' },
  questComplete: { themed: 'Quest complete', plain: 'the Quest is over: its summary' },
  questGoesOn: { themed: 'The Quest goes on · awaiting your orders', plain: 'send a message to continue' },
  shellMode: { themed: 'Command Rune', plain: 'shell mode: this runs as a command in the Quest’s folder' },
  loot: { themed: 'Loot', plain: 'files changed' },
  heroes: { themed: 'Heroes', plain: 'agents sent out' },
  sideQuests: { themed: 'Side Quests', plain: 'background tasks started' },
  today: { themed: 'Today', plain: 'turns finished since midnight' },
  thisWeek: { themed: 'This week', plain: 'turns finished since Monday' },
  kos: { themed: 'KOs', plain: 'turns that failed' },
  haunts: { themed: 'Haunts', plain: 'the folders you use most' },
  setOutHere: { themed: 'Set out here', plain: 'start a session in this folder' },
  adventureLog: { themed: 'Adventure log', plain: 'recent activity' },
  scroll: { themed: 'Scroll', plain: 'file, read-only' },
};

/** A plain theme: the same concepts with everyday words. */
export const CLASSIC: Words = {
  home: { themed: 'Home', plain: 'Home' },
  tavern: { themed: 'Waiting on you', plain: 'Waiting on you' },
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
  equipment: { themed: 'MCP servers', plain: 'MCP servers' },
  relics: { themed: 'Plugins', plain: 'Plugins' },
  guild: { themed: 'Agents', plain: 'Agents' },
  abilities: { themed: 'Hooks', plain: 'Hooks' },
  belt: { themed: 'Pinned', plain: 'Pinned' },
  party: { themed: 'Agents', plain: 'Agents' },
  loadingHistory: { themed: 'Loading history…', plain: 'Loading history…' },
  jumpToLatest: { themed: 'Jump to latest', plain: 'Jump to latest' },
  stats: { themed: 'Usage', plain: 'Usage' },
  hp: { themed: 'Plan left', plain: "Plan usage left in this node's 5-hour window" },
  expedition: { themed: 'Environment', plain: 'Environment' },
  roster: { themed: 'Agent levels', plain: 'Agent levels' },
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
  heroes: { themed: 'Agents', plain: 'Agents' },
  sideQuests: { themed: 'Background tasks', plain: 'Background tasks' },
  today: { themed: 'Today', plain: 'Today' },
  thisWeek: { themed: 'This week', plain: 'This week' },
  kos: { themed: 'Failed', plain: 'Failed turns' },
  haunts: { themed: 'Recent folders', plain: 'Recent folders' },
  setOutHere: { themed: 'New session here', plain: 'New session here' },
  adventureLog: { themed: 'Recent activity', plain: 'Recent activity' },
  scroll: { themed: 'File', plain: 'File, read-only' },
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
  read: { themed: ['Studying', 'Scouting'], plain: 'reading files' },
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

/** The Inventory categories a Hero can use something from, as the chat announces it. */
export type UseKind = 'spells' | 'items' | 'equipment';

const USE_VERBS: Record<UseKind, string> = { spells: 'casts', items: 'uses', equipment: 'wields' };
const USE_PLAIN: Record<UseKind, string> = { spells: 'skill', items: 'command', equipment: 'tool' };

/** The chat's line when a Hero uses an Inventory entry, e.g. "Paladin casts deploy!"; the plain form is the hint. */
export function useLine(kind: UseKind, hero: string, name: string, theme: Words = words): Word {
  const plain = `Used ${USE_PLAIN[kind]}: ${name}`;
  return { themed: theme === CLASSIC ? plain : `${hero} ${USE_VERBS[kind]} ${name}!`, plain };
}
