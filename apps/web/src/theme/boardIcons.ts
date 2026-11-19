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
