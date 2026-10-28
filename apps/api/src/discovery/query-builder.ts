import type { SearchParams } from '@repointelligence/shared';

const SIZE_QUALIFIER = {
  small: 'size:<1000',
  medium: 'size:1000..50000',
  large: 'size:>50000',
} as const;

const SORT_FIELD = { stars: 'stars', forks: 'forks', updated: 'updated' } as const;

/**
 * Free text must not smuggle in qualifiers (`user:x`, `repo:y`), so qualifier-looking tokens
 * are dropped. Filters only come from the structured fields.
 */
export function sanitizeKeywords(text: string): string {
  return text
    .replace(/\p{Cc}/gu, ' ')
    .split(/\s+/)
    .filter((token) => token !== '' && !/^-?[\w.-]+:/.test(token))
    .join(' ');
}

function quoted(value: string): string {
  return /[\s+#]/.test(value) ? `"${value}"` : value;
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function buildSearchQuery(params: SearchParams, now: number = Date.now()): string {
  const parts: string[] = [];

  const keywords = sanitizeKeywords(params.q ?? '');
  if (keywords) parts.push(keywords);
  if (params.language) parts.push(`language:${quoted(params.language)}`);
  if (params.topic) parts.push(`topic:${params.topic}`);
  if (params.license) parts.push(`license:${params.license}`);

  const { minStars, maxStars } = params;
  if (minStars !== undefined && maxStars !== undefined)
    parts.push(`stars:${minStars}..${maxStars}`);
  else if (minStars !== undefined) parts.push(`stars:>=${minStars}`);
  else if (maxStars !== undefined) parts.push(`stars:<=${maxStars}`);

  if (params.activeWithinDays !== undefined) {
    parts.push(`pushed:>=${isoDate(now - params.activeWithinDays * 86_400_000)}`);
  }
  if (params.size) parts.push(SIZE_QUALIFIER[params.size]);
  if (!params.includeArchived) parts.push('archived:false');

  return parts.join(' ');
}

/** True when the query has something GitHub can actually search on. */
export function hasSearchCriteria(params: SearchParams): boolean {
  return (
    sanitizeKeywords(params.q ?? '') !== '' ||
    params.language !== undefined ||
    params.topic !== undefined ||
    params.license !== undefined ||
    params.minStars !== undefined ||
    params.maxStars !== undefined ||
    params.activeWithinDays !== undefined ||
    params.size !== undefined
  );
}

export function searchSort(params: SearchParams): { sort?: string; order?: 'asc' | 'desc' } {
  if (params.sort === 'best-match') return {};
  return { sort: SORT_FIELD[params.sort], order: params.order };
}
