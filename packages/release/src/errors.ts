/**
 * What went wrong, in a form worth printing. `fetch` says only "fetch failed" and keeps the reason in `cause`, and a
 * dial that failed on every address keeps it deeper still.
 */
export function whyFailed(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const { cause } = error;
  if (cause === undefined) return error.message;
  if (!(cause instanceof Error)) return `${error.message}: ${String(cause)}`;
  const { code, errors } = cause as NodeJS.ErrnoException & { errors?: Error[] };
  const reason = cause.message || errors?.[0]?.message || code || cause.name;
  return `${error.message}: ${reason}${code && !reason.includes(code) ? ` (${code})` : ''}`;
}
