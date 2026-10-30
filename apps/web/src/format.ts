/** Short number formats shared by the Stats panel and battle results. */

/** 1234 -> 1.2k, 124000 -> 124k, 1000000 -> 1M */
export function tokens(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1_000)}k`;
  if (n >= 1_000) return `${+(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** 3725000 -> "1h 2m", 754000 -> "12m 34s", 9000 -> "9s" */
export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  if (s >= 60) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${s}s`;
}

/** 3400000 -> "3.4 MB", 52000 -> "52 KB" */
export function bytes(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)} MB`;
  if (n >= 1_000) return `${Math.round(n / 1_000)} KB`;
  return `${n} B`;
}

/** 0.0421 -> "$0.04"; amounts under a cent keep more digits so a cheap turn doesn't read as free. */
export function money(usd: number): string {
  return usd > 0 && usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}
