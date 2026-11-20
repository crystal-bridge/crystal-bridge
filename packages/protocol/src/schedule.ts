import { z } from 'zod';

/** A wall-clock date and time in the schedule's zone, to the minute, as `2026-12-01T09:00`. */
export const LocalDateTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, { message: 'a local date and time, like 2026-12-01T09:00' });

/** A day to skip, or one run to skip, in the schedule's zone. */
const Except = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/, { message: 'a local date, or a date and time, like 2026-12-24' });

/**
 * When something runs, always with the time zone it means, so it means the same thing on every machine. Exactly one
 * form: `cron` (five fields), `rule` (an RFC 5545 recurrence rule from `start`, skipping `except`), or `once`. Only the
 * shape is checked here; `recurrenceOf` in `./recurrence.ts` reads a rule in full and says what's wrong with one.
 */
export const Schedule = z
  .object({
    cron: z
      .string()
      .max(200)
      .regex(/^\s*\S+(\s+\S+){4}\s*$/)
      .optional(),
    rule: z.string().max(500).regex(/FREQ=/i, { message: 'a recurrence rule names its FREQ' }).optional(),
    start: LocalDateTime.optional(),
    except: z.array(Except).max(366).optional(),
    once: LocalDateTime.optional(),
    timezone: z.string().min(1).max(64),
  })
  .superRefine((schedule, context) => {
    const forms = (['cron', 'rule', 'once'] as const).filter((form) => schedule[form] !== undefined);
    if (forms.length !== 1)
      context.addIssue({ code: 'custom', message: 'give exactly one of cron, rule and once', path: [] });
    if (schedule.rule !== undefined && schedule.start === undefined)
      context.addIssue({ code: 'custom', message: 'a rule needs a start', path: ['start'] });
    if (schedule.rule === undefined)
      for (const key of ['start', 'except'] as const)
        if (schedule[key] !== undefined)
          context.addIssue({ code: 'custom', message: `${key} goes with a rule`, path: [key] });
  });
export type Schedule = z.infer<typeof Schedule>;
