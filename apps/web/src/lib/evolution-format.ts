/** Formatting shared by the evolution views. Missing values read as "no data", never 0. */

export const NO_DATA = 'no data';

export function shortDate(iso: string): string {
  const date = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export function longDate(iso: string | null): string {
  if (!iso) return NO_DATA;
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
} // prettier-ignore

export function count(value: number | null | undefined): string {
  return value === null || value === undefined ? NO_DATA : value.toLocaleString();
}

export function signed(value: number | null): string {
  if (value === null) return NO_DATA;
  return value > 0 ? `+${value.toLocaleString()}` : value.toLocaleString();
}

export function duration(hours: number | null): string {
  if (hours === null) return NO_DATA;
  if (hours < 48) return `${Math.round(hours)} h`;
  return `${Math.round(hours / 24)} days`;
}

export function percent(share: number | null | undefined): string {
  return share === null || share === undefined ? NO_DATA : `${Math.round(share * 100)}%`;
}

const SOURCE_LABELS = {
  github: 'Retrieved from GitHub',
  analysis: 'From stored analysis runs',
  graph: 'From stored architecture graphs',
  computed: 'Computed from those records',
} as const;

export function sourceLabel(source: keyof typeof SOURCE_LABELS): string {
  return SOURCE_LABELS[source];
}

/** Fixed series colours, in order; a series keeps its slot whatever else is shown. */
export const SERIES = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => `var(--series-${n})`);
export const SERIES_OTHER = 'var(--series-other)';
