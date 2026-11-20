import { z } from 'zod';

/**
 * The CLI's permission modes a client may pick. `manual` asks for every action, `auto` lets the CLI's own
 * classifier decide and ask only when unsure. Modes that turn approvals off (bypassPermissions, dontAsk) are left
 * out on purpose: a click in the hub must never remove them.
 */
export const PermissionMode = z.enum(['manual', 'acceptEdits', 'auto', 'plan']);
export type PermissionMode = z.infer<typeof PermissionMode>;

/**
 * How a node runs a session's engine. `stream` drives `claude -p` over stream-json (the default); `interactive` runs
 * the real interactive `claude` in a pseudo-terminal, for the tools only an interactive session gets (e.g. artifacts).
 */
export const Engine = z.enum(['stream', 'interactive']);
export type Engine = z.infer<typeof Engine>;

/** How hard the agent thinks: the CLI's `--effort` levels. Unset leaves the CLI's own default. */
export const Effort = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
export type Effort = z.infer<typeof Effort>;
