import { describe, expect, it } from 'vitest';
import { searchParamsSchema } from '@repointelligence/shared';
import {
  buildSearchQuery,
  hasSearchCriteria,
  sanitizeKeywords,
  searchSort,
} from './query-builder.js';

const NOW = Date.parse('2026-03-31T12:00:00Z');
const parse = (input: Record<string, unknown>) => searchParamsSchema.parse(input);

describe('buildSearchQuery', () => {
  it('combines keywords and filters, excluding archived repos by default', () => {
    const q = buildSearchQuery(
      parse({
        q: 'vector db',
        language: 'rust',
        topic: 'database',
        license: 'mit',
        minStars: '100',
      }),
      NOW,
    );
    expect(q).toBe('vector db language:rust topic:database license:mit stars:>=100 archived:false');
  });

  it('builds star ranges, activity and size qualifiers', () => {
    const q = buildSearchQuery(
      parse({ q: 'x', minStars: 10, maxStars: 50, activeWithinDays: 30, size: 'small' }),
      NOW,
    );
    expect(q).toContain('stars:10..50');
    expect(q).toContain('pushed:>=2026-03-01');
    expect(q).toContain('size:<1000');
  });

  it('quotes languages that contain spaces or symbols', () => {
    expect(buildSearchQuery(parse({ language: 'C++' }), NOW)).toContain('language:"C++"');
    expect(buildSearchQuery(parse({ language: 'Jupyter Notebook' }), NOW)).toContain(
      'language:"Jupyter Notebook"',
    );
  });

  it('can include archived repositories', () => {
    expect(buildSearchQuery(parse({ q: 'x', includeArchived: 'true' }), NOW)).not.toContain(
      'archived',
    );
  });
});

describe('keyword safety', () => {
  it('drops qualifier-looking tokens so filters only come from fields', () => {
    expect(sanitizeKeywords('react user:torvalds repo:a/b -language:go hooks')).toBe('react hooks');
  });

  it('removes control characters', () => {
    expect(sanitizeKeywords('a\u0000b\nc')).toBe('a b c');
  });
});

describe('search criteria and sorting', () => {
  it('requires at least one criterion', () => {
    expect(hasSearchCriteria(parse({}))).toBe(false);
    expect(hasSearchCriteria(parse({ q: 'user:foo' }))).toBe(false);
    expect(hasSearchCriteria(parse({ language: 'go' }))).toBe(true);
  });

  it('maps sort options', () => {
    expect(searchSort(parse({}))).toEqual({});
    expect(searchSort(parse({ sort: 'stars', order: 'asc' }))).toEqual({
      sort: 'stars',
      order: 'asc',
    });
  });

  it('rejects inconsistent star bounds', () => {
    expect(searchParamsSchema.safeParse({ minStars: 10, maxStars: 5 }).success).toBe(false);
  });
});
