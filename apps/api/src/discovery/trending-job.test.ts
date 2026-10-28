import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useMemoryDb } from '../../test/db.js';
import { jsonResponse, rawRepo, routedFetch } from '../../test/github-fixtures.js';
import { createLogger } from '../logger.js';
import { GithubService } from '../github/service.js';
import { JobRecord } from '../models/job-record.js';
import { TrendingSnapshot } from '../models/trending-snapshot.js';
import { GithubCache } from '../models/github-cache.js';
import { runTrendingJob } from './trending-job.js';

useMemoryDb();

const NOW = Date.parse('2026-03-31T00:00:00Z');
const logger = createLogger({ LOG_LEVEL: 'silent', NODE_ENV: 'test' });
const sleep = vi.fn(() => Promise.resolve());

const fresh = rawRepo({
  full_name: 'a/fresh',
  stargazers_count: 300,
  created_at: new Date(NOW - 2 * 86_400_000).toISOString(),
  pushed_at: new Date(NOW - 3600_000).toISOString(),
});
const old = rawRepo({
  full_name: 'a/old',
  stargazers_count: 90_000,
  created_at: '2015-01-01T00:00:00Z',
  pushed_at: new Date(NOW - 3600_000).toISOString(),
});
const idle = rawRepo({
  full_name: 'a/idle',
  stargazers_count: 9000,
  created_at: '2015-01-01T00:00:00Z',
  pushed_at: '2020-01-01T00:00:00Z',
});

beforeEach(async () => {
  await Promise.all([
    GithubCache.deleteMany({}),
    JobRecord.deleteMany({}),
    TrendingSnapshot.deleteMany({}),
  ]);
  sleep.mockClear();
});

describe('runTrendingJob', () => {
  it('stores a ranked list for every period and topic and records the run', async () => {
    const fetchMock = routedFetch([
      [
        /\/search\/repositories/,
        () =>
          jsonResponse({ total_count: 3, incomplete_results: false, items: [old, fresh, idle] }),
      ],
    ]);
    const github = new GithubService({ fetch: fetchMock, now: () => NOW, sleep });
    const result = await runTrendingJob({ github, logger, now: () => NOW, sleep, paceMs: 5 });

    expect(result).toEqual({ lists: 33, failed: [] });
    expect(await TrendingSnapshot.countDocuments()).toBe(33);
    const weekly = await TrendingSnapshot.findOne({ key: 'weekly|all' }).lean();
    const names = (weekly?.items as { repo: { fullName: string } }[]).map((i) => i.repo.fullName);
    expect(names).toEqual(['a/fresh', 'a/old']);
    expect(await JobRecord.findOne({ type: 'trending' })).toMatchObject({ status: 'completed' });
    expect(sleep).toHaveBeenCalledWith(5);
  });

  it('keeps going when one list fails and keeps the failure visible', async () => {
    const fetchMock = routedFetch([
      [/topic:llm/, () => jsonResponse({ message: 'Validation Failed' }, 422)],
      [
        /\/search\/repositories/,
        () => jsonResponse({ total_count: 1, incomplete_results: false, items: [fresh] }),
      ],
    ]);
    const github = new GithubService({ fetch: fetchMock, now: () => NOW, sleep });
    const result = await runTrendingJob({ github, logger, now: () => NOW, sleep, paceMs: 0 });
    expect(result.failed).toEqual(['daily|llm', 'weekly|llm', 'monthly|llm']);
    expect(result.lists).toBe(30);
    expect(await JobRecord.findOne({ type: 'trending' })).toMatchObject({ status: 'failed' });
  });

  it('stops on a rate limit instead of hammering GitHub', async () => {
    const reset = String(Math.floor(NOW / 1000) + 3600);
    const fetchMock = routedFetch([
      [
        /\/search\/repositories/,
        () => jsonResponse({}, 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset }),
      ],
    ]);
    const github = new GithubService({ fetch: fetchMock, now: () => NOW, sleep });
    await expect(
      runTrendingJob({ github, logger, now: () => NOW, sleep, paceMs: 0 }),
    ).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await JobRecord.findOne({ type: 'trending' })).toMatchObject({ status: 'failed' });
    expect(await TrendingSnapshot.countDocuments()).toBe(0);
  });
});
