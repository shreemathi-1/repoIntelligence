import { describe, expect, it } from 'vitest';
import type { RepoCard } from '@repointelligence/shared';
import { classifyLicense } from './license.js';
import {
  beginnerScore,
  inspectRootListing,
  similarity,
  trendingScore,
  type BeginnerInput,
} from './ranking.js';

const NOW = Date.parse('2026-03-31T00:00:00Z');
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

describe('trendingScore', () => {
  it('ranks a fast-rising new repo above a larger old one', () => {
    const fresh = trendingScore(
      { stars: 700, createdAt: daysAgo(3), pushedAt: daysAgo(0) },
      7,
      NOW,
    );
    const old = trendingScore(
      { stars: 50_000, createdAt: daysAgo(2000), pushedAt: daysAgo(1) },
      7,
      NOW,
    );
    expect(fresh).toBeGreaterThan(old);
  });

  it('gives older repos a damped score that falls as the last push ages', () => {
    const recent = trendingScore(
      { stars: 1000, createdAt: daysAgo(900), pushedAt: daysAgo(0) },
      30,
      NOW,
    );
    const stale = trendingScore(
      { stars: 1000, createdAt: daysAgo(900), pushedAt: daysAgo(25) },
      30,
      NOW,
    );
    expect(recent).toBeGreaterThan(stale);
    expect(stale).toBeGreaterThan(0);
  });

  it('scores zero when nothing happened inside the window', () => {
    expect(
      trendingScore({ stars: 9000, createdAt: daysAgo(900), pushedAt: daysAgo(100) }, 30, NOW),
    ).toBe(0);
  });
});

const card = (over: Partial<RepoCard>): RepoCard => ({
  fullName: 'a/b',
  description: null,
  language: 'TypeScript',
  stars: 1,
  forks: 0,
  openIssues: 0,
  topics: [],
  license: classifyLicense('MIT'),
  pushedAt: null,
  createdAt: null,
  sizeKb: null,
  archived: false,
  htmlUrl: 'https://github.com/a/b',
  ...over,
});

describe('similarity', () => {
  const base = card({
    topics: ['rag', 'llm', 'search'],
    description: 'Retrieval augmented generation toolkit',
  });

  it('is highest for shared topics, language and wording', () => {
    const close = card({ topics: ['rag', 'llm'], description: 'Retrieval toolkit for generation' });
    const far = card({ language: 'Go', topics: ['game'], description: 'A tiny platformer' });
    expect(similarity(base, close)).toBeGreaterThan(similarity(base, far));
  });

  it('is 0 to 1 and 0 when nothing is shared', () => {
    expect(similarity(base, card({ language: 'Go', topics: ['x'], description: 'zzz' }))).toBe(0);
    expect(similarity(base, base)).toBeLessThanOrEqual(1);
  });
});

const input = (over: Partial<BeginnerInput> = {}): BeginnerInput => ({
  hasReadme: 'present',
  hasContributing: 'present',
  hasTests: 'present',
  goodFirstIssues: 4,
  hasLicense: true,
  pushedAt: daysAgo(10),
  sizeKb: 2000,
  now: NOW,
  ...over,
});

describe('beginnerScore', () => {
  it('scores 100 with full confidence when every signal is present', () => {
    expect(beginnerScore(input())).toMatchObject({ score: 100, confidence: 1 });
  });

  it('lowers the score for absent signals', () => {
    const result = beginnerScore(input({ hasTests: 'absent', goodFirstIssues: 0 }));
    expect(result.score).toBe(Math.round((10 / 16) * 100));
  });

  it('leaves unavailable signals out of the score and lowers confidence', () => {
    const result = beginnerScore(input({ goodFirstIssues: null, hasContributing: 'unavailable' }));
    expect(result.score).toBe(100);
    expect(result.confidence).toBeLessThan(1);
    expect(result.signals.find((s) => s.id === 'good-first-issues')?.status).toBe('unavailable');
  });

  it('reports very low confidence when almost nothing could be observed', () => {
    const result = beginnerScore(
      input({
        hasReadme: 'unavailable',
        hasContributing: 'unavailable',
        hasTests: 'unavailable',
        goodFirstIssues: null,
        pushedAt: null,
        sizeKb: null,
      }),
    );
    expect(result.confidence).toBeLessThan(0.1);
    expect(result.signals.filter((s) => s.status === 'unavailable')).toHaveLength(6);
  });
});

describe('inspectRootListing', () => {
  it('finds README, CONTRIBUTING and a test directory', () => {
    const result = inspectRootListing([
      { name: 'README.md', type: 'file' },
      { name: 'CONTRIBUTING.md', type: 'file' },
      { name: '__tests__', type: 'dir' },
    ]);
    expect(result).toEqual({
      hasReadme: 'present',
      hasContributing: 'present',
      hasTests: 'present',
    });
  });

  it('does not call contributing absent when .github could hold it', () => {
    const result = inspectRootListing([{ name: '.github', type: 'dir' }]);
    expect(result.hasContributing).toBe('unavailable');
    expect(result.hasReadme).toBe('absent');
  });
});
