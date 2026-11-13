export const DAY_MS = 86_400_000;
export const WEEK_MS = 7 * DAY_MS;

/** Start of the week (Sunday 00:00 UTC) containing `ms`, which is how GitHub buckets statistics. */
export function weekStart(ms: number): number {
  const day = new Date(ms);
  day.setUTCHours(0, 0, 0, 0);
  return day.getTime() - day.getUTCDay() * DAY_MS;
}

/** The last `weeks` week starts up to and including the current one, oldest first. */
export function windowWeeks(now: number, weeks: number): number[] {
  const current = weekStart(now);
  return Array.from({ length: weeks }, (_, i) => current - (weeks - 1 - i) * WEEK_MS);
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[mid] ?? null)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

export const round1 = (n: number): number => Math.round(n * 10) / 10;
