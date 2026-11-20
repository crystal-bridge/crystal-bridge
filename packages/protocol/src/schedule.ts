import { z } from 'zod';

const timezone = z.string().min(1).max(64);
/** A local date-time in the schedule's time zone, such as `2026-12-01T09:00`; the Kingdom's recurrence engine reads it. */
const localTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/);
const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * When a Scout or a Patrol runs: an RFC 5545 recurrence rule from a start, five-field cron, or a single time, each with
 * the IANA time zone it means, so a schedule means the same thing on every machine. Only the shape is checked here;
 * whether a rule makes sense is the Kingdom's recurrence engine's call. Each form is strict, so a schedule naming two
 * forms, or a form this hub doesn't know, fails its Scout or Patrol alone.
 */
export const Schedule = z.union([
  z.strictObject({
    rule: z
      .string()
      .max(500)
      .regex(/(^|[:;])FREQ=/),
    start: localTime,
    timezone,
    /** Days, or single times, the rule would give that are skipped. */
    except: z
      .array(z.union([localDate, localTime]))
      .max(366)
      .optional(),
  }),
  z.strictObject({
    cron: z
      .string()
      .max(200)
      .regex(/^\s*\S+(\s+\S+){4}\s*$/),
    timezone,
  }),
  z.strictObject({ once: localTime, timezone }),
]);
export type Schedule = z.infer<typeof Schedule>;
