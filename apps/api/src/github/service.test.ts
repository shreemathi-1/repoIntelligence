import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { jsonResponse, repoJson } from '../../test/github-fixtures.js';
import { useMemoryDb } from '../../test/db.js';
import { GithubCache } from '../models/github-cache.js';
import { GithubService } from './service.js';

useMemoryDb();

let clock = 1_000_000_000_000;
const sleep = vi.fn(() => Promise.resolve());

function service(fetchImpl: typeof fetch): GithubService {
  return new GithubService({ fetch: fetchImpl, now: () => clock, sleep, freshMs: 60_000 });
}

function mockFetch(...responses: Response[]): ReturnType<typeof vi.fn<typeof fetch>> {
  const fn = vi.fn<typeof fetch>();
  for (const response of responses) fn.mockResolvedValueOnce(response);
  return fn;
}

beforeEach(async () => {
  await GithubCache.deleteMany({});
  sleep.mockClear();
});

describe('GithubService.getRepo', () => {
  it('fetches, maps and caches a repository', async () => {
    const fetchMock = mockFetch(jsonResponse(repoJson, 200, { etag: '"v1"' }));
    const result = await service(fetchMock).getRepo('acme', 'tool');
    expect(result.source).toBe('network');
    expect(result.repo).toMatchObject({ fullName: 'acme/tool', stars: 42, language: 'TypeScript' });
    expect(await GithubCache.countDocuments()).toBe(1);
  });

  it('serves a fresh entry without calling GitHub', async () => {
    const fetchMock = mockFetch(jsonResponse(repoJson, 200, { etag: '"v1"' }));
    const github = service(fetchMock);
    await github.getRepo('acme', 'tool');
    clock += 30_000;
    const again = await github.getRepo('acme', 'tool');
    expect(again.source).toBe('cache');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('revalidates a stale entry with its ETag and keeps the cached body on 304', async () => {
    const fetchMock = mockFetch(
      jsonResponse(repoJson, 200, { etag: '"v1"' }),
      jsonResponse(null, 304),
    );
    const github = service(fetchMock);
    await github.getRepo('acme', 'tool');
    clock += 120_000;
    const again = await github.getRepo('acme', 'tool');
    expect(again.source).toBe('revalidated');
    expect(again.repo.stars).toBe(42);
    const init = fetchMock.mock.calls[1]?.[1];
    expect(new Headers(init?.headers).get('if-none-match')).toBe('"v1"');
  });

  it('keeps cache entries separate per viewer', async () => {
    const fetchMock = mockFetch(
      jsonResponse({ ...repoJson, private: true }),
      jsonResponse({ ...repoJson, stargazers_count: 7 }),
    );
    const github = service(fetchMock);
    const mine = await github.getRepo('acme', 'tool', { userId: 'u1', token: 't1' });
    const anon = await github.getRepo('acme', 'tool');
    expect(mine.repo.private).toBe(true);
    expect(anon.repo.stars).toBe(7);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('answers 404 for missing or inaccessible repositories and drops stale cache', async () => {
    const fetchMock = mockFetch(jsonResponse({ message: 'Not Found' }, 404));
    await expect(service(fetchMock).getRepo('acme', 'secret')).rejects.toMatchObject({
      statusCode: 404,
      code: 'NOT_FOUND',
    });
  });

  it('waits out a short rate limit and retries', async () => {
    const reset = String(Math.floor(clock / 1000) + 5);
    const fetchMock = mockFetch(
      jsonResponse({ message: 'rate limited' }, 403, {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': reset,
      }),
      jsonResponse(repoJson),
    );
    const result = await service(fetchMock).getRepo('acme', 'tool');
    expect(result.source).toBe('network');
    expect(sleep).toHaveBeenCalledOnce();
  });

  it('fails fast with RATE_LIMITED when the reset is far away', async () => {
    const reset = String(Math.floor(clock / 1000) + 3600);
    const fetchMock = mockFetch(
      jsonResponse({ message: 'rate limited' }, 403, {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': reset,
      }),
    );
    await expect(service(fetchMock).getRepo('acme', 'tool')).rejects.toMatchObject({
      statusCode: 429,
      code: 'RATE_LIMITED',
    });
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries server errors with backoff and then gives up', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(jsonResponse({}, 502)));
    await expect(service(fetchMock).getRepo('acme', 'tool')).rejects.toMatchObject({
      statusCode: 502,
      code: 'UPSTREAM_ERROR',
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it('reports an unexpected response shape as an upstream error', async () => {
    const fetchMock = mockFetch(jsonResponse({ full_name: 'x' }));
    await expect(service(fetchMock).getRepo('acme', 'tool')).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR',
    });
  });
});

describe('GithubService.getJson', () => {
  it('caches each parsed shape of the same response separately', async () => {
    const fetchMock = mockFetch(
      jsonResponse({ ...repoJson, forks_count: 9 }),
      jsonResponse({ ...repoJson, forks_count: 9 }),
    );
    const github = service(fetchMock);
    await github.getRepo('acme', 'tool');
    const counts = await github.getJson({
      route: 'GET /repos/{owner}/{repo}',
      params: { owner: 'acme', repo: 'tool' },
      schema: z.object({ forks_count: z.number() }),
    });
    expect(counts).toEqual({ data: { forks_count: 9 }, source: 'network' });
    expect((await github.getRepo('acme', 'tool')).source).toBe('cache');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('sends a requested media type and keeps it apart in the cache', async () => {
    const fetchMock = mockFetch(jsonResponse([{ starred_at: '2026-01-01T00:00:00Z' }]));
    const { data } = await service(fetchMock).getJson({
      route: 'GET /repos/{owner}/{repo}/stargazers',
      params: { owner: 'acme', repo: 'tool' },
      schema: z.array(z.object({ starred_at: z.string() })),
      accept: 'application/vnd.github.star+json',
    });
    expect(data).toHaveLength(1);
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('accept')).toBe(
      'application/vnd.github.star+json',
    );
    const entry = await GithubCache.findOne().lean();
    expect(entry?.key).toContain('application/vnd.github.star+json');
  });
});
