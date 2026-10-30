import type { Engine } from '@crystal-bridge/protocol';

/** The engines a client may choose between, in menu order, for New Quest and Recruit. */
export const ENGINES: { value: Engine; label: string }[] = [
  { value: 'stream', label: 'Standard' },
  { value: 'interactive', label: 'Interactive (artifacts and the full interactive toolset; preview)' },
];

/** The choices a Kingdom offers: only the engines its hello lists, and none when that's just the default. */
export function engineChoices(engines: readonly Engine[] | undefined): { value: Engine; label: string }[] {
  const choices = ENGINES.filter((option) => engines?.includes(option.value));
  return choices.length > 1 ? choices : [];
}
