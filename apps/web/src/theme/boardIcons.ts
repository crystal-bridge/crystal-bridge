import type { IconName } from './iconSources.js';

/**
 * The icons a Board's pinned tab can name in `scout.json`'s `icon` (docs/SCOUTS.md). Data, so a fork adds its own here
 * (and in iconSources.ts). A name not listed draws the Board's first letter instead.
 */
export const BOARD_ICONS: Readonly<Record<string, IconName>> = {
  mail: 'boardMail',
  'pull-request': 'boardPullRequest',
  issue: 'boardIssue',
  forum: 'boardForum',
  calendar: 'boardCalendar',
  bell: 'boardBell',
  news: 'boardNews',
  checklist: 'boardChecklist',
  ticket: 'boardTicket',
  chart: 'boardChart',
  release: 'boardRelease',
  package: 'boardPackage',
};

/** The icon a Board's tab draws, or undefined for its first letter. */
export function boardIcon(name: string | undefined): IconName | undefined {
  return name !== undefined && Object.hasOwn(BOARD_ICONS, name) ? BOARD_ICONS[name] : undefined;
}

/**
 * The marks an item can wear on a projects Board, by the short name a `ScoutLook.icon` gives (docs/SCOUTS.md). They
 * are plain Phosphor drawings that take the text colour, so a tone (boardTones.ts) paints them. `draft` shares the
 * pull request's drawing and `check-circle` the closed issue's. A fork adds its own here (and in iconSources.ts).
 */
export const BOARD_MARKS: Readonly<Record<string, IconName>> = {
  'pull-request': 'markPullRequest',
  merge: 'markMerge',
  issue: 'markIssue',
  'issue-closed': 'markIssueClosed',
  bug: 'markBug',
  discussion: 'markDiscussion',
  'x-circle': 'markXCircle',
  running: 'markRunning',
  warning: 'markWarning',
  'seal-check': 'markSealCheck',
  changes: 'markChanges',
  hourglass: 'markHourglass',
  eye: 'markEye',
  chat: 'markChat',
  reply: 'markReply',
  user: 'markUser',
  crown: 'markCrown',
  handshake: 'markHandshake',
  robot: 'markRobot',
  hand: 'markHand',
  lock: 'markLock',
  star: 'markStar',
  tag: 'markTag',
  rocket: 'markRocket',
  clock: 'markClock',
  flag: 'markFlag',
  lightning: 'markLightning',
  shield: 'markShield',
  github: 'markGithub',
  gitlab: 'markGitlab',
  draft: 'markPullRequest',
  'check-circle': 'markIssueClosed',
};

/** The icon an item's mark draws, or undefined for none. */
export function markIcon(name: string | undefined): IconName | undefined {
  return name !== undefined && Object.hasOwn(BOARD_MARKS, name) ? BOARD_MARKS[name] : undefined;
}
