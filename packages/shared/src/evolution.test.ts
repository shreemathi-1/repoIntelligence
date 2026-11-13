import { describe, expect, it } from 'vitest';
import {
  refCompareQuerySchema,
  evolutionQuerySchema,
  releaseSummarySchema,
  releasesSchema,
} from './index.js';

const envelope = {
  fullName: 'acme/tool',
  retrievedAt: '2026-10-01T00:00:00.000Z',
  sources: ['github'],
  notes: [],
};
const releasesFacts = { source: 'releases', releases: [], inWindow: 0, medianDaysBetween: null };

describe('evolution envelope', () => {
  it('keeps facts-only responses free of interpretation', () => {
    expect(
      releasesSchema.safeParse({ ...envelope, facts: releasesFacts, interpretation: null }).success,
    ).toBe(true);
    expect(
      releasesSchema.safeParse({
        ...envelope,
        facts: releasesFacts,
        interpretation: {
          summary: 'x',
          highlights: [],
          risks: [],
          writtenBy: 'm',
          generatedAt: '',
        },
      }).success,
    ).toBe(false);
  });

  it('carries model text only in the interpretation of a release summary', () => {
    const summary = {
      ...envelope,
      id: 'a'.repeat(24),
      reused: false,
      interpretationNote: null,
      facts: { tag: 'v1.0.0', base: null, publishedAt: null, compare: null },
      interpretation: {
        summary: 'Adds export.',
        highlights: ['Export'],
        risks: [],
        writtenBy: 'groq/model',
        generatedAt: '2026-10-01T00:00:00.000Z',
      },
    };
    expect(releaseSummarySchema.parse(summary).interpretation?.writtenBy).toBe('groq/model');
    expect(releaseSummarySchema.safeParse({ ...summary, interpretation: null }).success).toBe(true);
  });
});

describe('evolution queries', () => {
  it('defaults to 52 weeks and accepts only the offered windows', () => {
    expect(evolutionQuerySchema.parse({})).toEqual({ weeks: 52 });
    expect(evolutionQuerySchema.parse({ weeks: '12' })).toEqual({ weeks: 12 });
    expect(evolutionQuerySchema.safeParse({ weeks: '30' }).success).toBe(false);
  });

  it('accepts branch and tag names but not ranges', () => {
    expect(refCompareQuerySchema.safeParse({ base: 'v1.2.0', head: 'feature/x' }).success).toBe(
      true,
    );
    expect(refCompareQuerySchema.safeParse({ base: 'main..dev', head: 'x' }).success).toBe(false);
    expect(refCompareQuerySchema.safeParse({ base: 'a b', head: 'x' }).success).toBe(false);
  });
});
