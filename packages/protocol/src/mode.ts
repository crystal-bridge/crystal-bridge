import { z } from 'zod';

/**
 * The CLI's permission modes a client may pick. `manual` asks for every action, `auto` lets the CLI's own
 * classifier decide and ask only when unsure. Modes that turn approvals off (bypassPermissions, dontAsk) are left
 * out on purpose: a click in the hub must never remove them.
 */
export const PermissionMode = z.enum(['manual', 'acceptEdits', 'auto', 'plan']);
export type PermissionMode = z.infer<typeof PermissionMode>;
