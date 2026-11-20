import { z } from 'zod';

const timezone = z.string({ error: 'needs a `timezone`, an IANA time zone such as "America/Chicago"' }).min(1).max(64);
/** A local date-time in the schedule's time zone, such as `2026-12-01T09:00`; the Kingdom's recurrence engine reads it. */
const localTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/, { error: 'write a date and time like 2026-12-01T09:00' });
const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const RuleSchedule = z.object({
  rule: z
    .string()
    .max(500)
    .regex(/(^|[:;])FREQ=/i, { error: 'a rule needs FREQ=, such as FREQ=WEEKLY;BYDAY=TU' }),
  start: localTime,
  timezone,
  /** Days, or single times, the rule would give that are skipped. */
  except: z
    .array(
      z.union([localDate, localTime], {
        error: 'skip a day like 2026-12-25, or a single time like 2026-12-25T09:00',
      }),
    )
    .max(366)
    .optional(),
});
const CronSchedule = z.object({
  cron: z
    .string()
    .max(200)
    .regex(/^\s*\S+(\s+\S+){4}\s*$/, { error: 'cron has five fields, such as "*/15 8-20 * * 1-5"' }),
  timezone,
});
const OnceSchedule = z.object({ once: localTime, timezone });

const FORMS = { rule: RuleSchedule, cron: CronSchedule, once: OnceSchedule } as const;
type Form = keyof typeof FORMS;

/**
 * When a Scout or a Patrol runs: an RFC 5545 recurrence rule from a start, five-field cron, or a single time, each with
 * the IANA time zone it means, so a schedule means the same thing on every machine. Only the shape is checked here;
 * whether a rule makes sense is the Kingdom's recurrence engine's call.
 *
 * A schedule names exactly one form, so one naming two, or a form this hub doesn't know, fails its Scout or Patrol
 * alone. Other keys are dropped, as they always were for cron, and each problem is said in words a file's writer can
 * act on rather than as a pattern.
 */
export const Schedule = z.unknown().transform((value, ctx) => {
  const named =
    typeof value === 'object' && value !== null ? (Object.keys(FORMS) as Form[]).filter((form) => form in value) : [];
  const form = named.length === 1 ? named[0] : undefined;
  if (!form) {
    ctx.issues.push({
      code: 'custom',
      input: value,
      message: 'a schedule gives one of `cron`, `rule` or `once`, with its `timezone`',
    });
    return z.NEVER;
  }
  const parsed = FORMS[form].safeParse(value);
  if (!parsed.success) {
    for (const issue of parsed.error.issues)
      ctx.issues.push({ code: 'custom', input: value, path: issue.path, message: issue.message });
    return z.NEVER;
  }
  return parsed.data as z.infer<(typeof FORMS)[Form]>;
});
export type Schedule = z.infer<typeof Schedule>;
