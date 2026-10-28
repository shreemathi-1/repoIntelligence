import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  activityResponseSchema,
  beginnerScoreSchema,
  compareResponseSchema,
  contributeResponseSchema,
  developerProfileSchema,
  errorResponseSchema,
  searchResponseSchema,
  similarResponseSchema,
  repoResponseSchema,
  trendingResponseSchema,
  trendingTopicsResponseSchema,
} from '@repointelligence/shared';
import { useMemoryDb } from '../../test/db.js';
import { testConfig } from '../../test/env.js';
import { jsonResponse, rawRepo, routedFetch } from '../../test/github-fixtures.js';
import { createApp } from '../app.js';
import { createLogger } from '../logger.js';
import { GithubCache } from '../models/github-cache.js';
import { TrendingSnapshot } from '../models/trending-snapshot.js';

useMemoryDb();

const config = { ...testConfig, GITHUB_TOKEN: 'srv_token' };

const searchBody = (items: Record<string, unknown>[]) => ({
  total_count: items.length,
  incomplete_results: false,
  items,
});

const issues = (count: number) => ({
  total_count: count,
  items: [
    {
      number: 7,
      title: 'Fix typo',
      html_url: 'https://github.com/acme/tool/issues/7',
      comments: 1,
      created_at: '2026-01-01T00:00:00Z',
      repository_url: 'https://api.github.com/repos/acme/tool',
      labels: [{ name: 'good first issue' }],
    },
  ].slice(0, Math.max(count, 0)),
});

function appWith(routes: Parameters<typeof routedFetch>[0]) {
  const fetchMock = routedFetch(routes);
  return { app: createApp(config, createLogger(config), { fetch: fetchMock }), fetchMock };
}

beforeEach(async () => {
  await GithubCache.deleteMany({});
  await TrendingSnapshot.deleteMany({});
});

describe('GET /search', () => {
  const searchRoutes: Parameters<typeof routedFetch>[0] = [
    [
      /\/search\/repositories/,
      () =>
        jsonResponse(
          searchBody([
            rawRepo(),
            rawRepo({ full_name: 'acme/gpl', license: { spdx_id: 'GPL-3.0' } }),
          ]),
        ),
    ],
  ];

  it('searches anonymously with the server token and adds license flags', async () => {
    const { app, fetchMock } = appWith(searchRoutes);
    const res = await request(app).get('/api/v1/search?q=cli&language=typescript&minStars=10');
    expect(res.status).toBe(200);
    const body = searchResponseSchema.parse(res.body);
    expect(body.query).toBe('cli language:typescript stars:>=10 archived:false');
    expect(body.items[1]?.license.category).toBe('strong-copyleft');
    expect(body.items[1]?.license.flags.length).toBeGreaterThan(0);
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get('authorization')).toBe('token srv_token');
  });

  it('caches repeated searches', async () => {
    const { app, fetchMock } = appWith(searchRoutes);
    await request(app).get('/api/v1/search?q=cli');
    await request(app).get('/api/v1/search?q=cli');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a search with no criteria or inverted star bounds', async () => {
    const { app, fetchMock } = appWith(searchRoutes);
    const empty = await request(app).get('/api/v1/search');
    expect(empty.status).toBe(400);
    expect(errorResponseSchema.parse(empty.body).error.message).toMatch(/search term/);
    expect((await request(app).get('/api/v1/search?minStars=10&maxStars=2')).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not let keywords inject qualifiers', async () => {
    const { app } = appWith(searchRoutes);
    const res = await request(app).get('/api/v1/search').query({ q: 'cli user:torvalds' });
    expect(searchResponseSchema.parse(res.body).query).toBe('cli archived:false');
  });
});

describe('GET /trending', () => {
  it('says "not computed yet" instead of returning an empty list as a result', async () => {
    const { app } = appWith([]);
    const body = trendingResponseSchema.parse((await request(app).get('/api/v1/trending')).body);
    expect(body).toMatchObject({ period: 'weekly', computedAt: null, estimate: true, items: [] });
  });

  it('serves the stored list for a period and topic', async () => {
    await TrendingSnapshot.create({
      key: 'daily|react',
      period: 'daily',
      topic: 'react',
      computedAt: new Date('2026-03-01T03:00:00Z'),
      items: [{ repo: { fullName: 'a/b' }, score: 9 }],
    });
    const { app } = appWith([]);
    const res = await request(app).get('/api/v1/trending?period=daily&topic=react');
    const body = res.body as { computedAt: string; items: unknown[] };
    expect(body.computedAt).toBe('2026-03-01T03:00:00.000Z');
    expect(body.items).toHaveLength(1);
  });

  it('rejects unknown topics and periods, and lists the known topics', async () => {
    const { app } = appWith([]);
    expect((await request(app).get('/api/v1/trending?topic=nope')).status).toBe(400);
    expect((await request(app).get('/api/v1/trending?period=hourly')).status).toBe(400);
    const topics = await request(app).get('/api/v1/trending/topics');
    const parsed = trendingTopicsResponseSchema.parse(topics.body);
    expect(parsed.technologies.map((t) => t.id)).toContain('react');
    expect(parsed.useCases.map((t) => t.id)).toContain('rag');
  });
});

describe('repository insight routes', () => {
  const repoRoutes: Parameters<typeof routedFetch>[0] = [
    [
      /\/repos\/acme\/tool\/contents/,
      () =>
        jsonResponse([
          { name: 'README.md', type: 'file' },
          { name: 'CONTRIBUTING.md', type: 'file' },
          { name: 'tests', type: 'dir' },
        ]),
    ],
    [/\/search\/issues/, () => jsonResponse(issues(3))],
    [
      /\/repos\/acme\/tool\/stats\/commit_activity/,
      () => jsonResponse(Array.from({ length: 52 }, () => ({ total: 2 }))),
    ],
    [/\/repos\/acme\/tool\/stats\/contributors/, () => jsonResponse([{}, {}, {}])],
    [/\/repos\/acme\/tool$/, () => jsonResponse(rawRepo())],
  ];

  it('scores beginner-friendliness from observed signals', async () => {
    const { app } = appWith(repoRoutes);
    const res = await request(app).get('/api/v1/repos/acme/tool/beginner');
    const body = beginnerScoreSchema.parse(res.body);
    expect(body.score).toBe(100);
    expect(body.confidence).toBe(1);
  });

  it('marks signals unavailable, not absent, when the listing cannot be read', async () => {
    const { app } = appWith([
      [/\/search\/issues/, () => jsonResponse(issues(0))],
      [/\/repos\/acme\/tool$/, () => jsonResponse(rawRepo())],
    ]);
    const body = beginnerScoreSchema.parse(
      (await request(app).get('/api/v1/repos/acme/tool/beginner')).body,
    );
    expect(body.signals.find((s) => s.id === 'readme')?.status).toBe('unavailable');
    expect(body.signals.find((s) => s.id === 'good-first-issues')?.status).toBe('absent');
    expect(body.confidence).toBeLessThan(1);
  });

  it('returns weekly activity and contributors', async () => {
    const { app } = appWith(repoRoutes);
    const body = activityResponseSchema.parse(
      (await request(app).get('/api/v1/repos/acme/tool/activity')).body,
    );
    expect(body).toMatchObject({ status: 'ready', contributors: 3, stars: 42 });
    expect(body.commitsByWeek).toHaveLength(52);
  });

  it('reports pending, never zero, while GitHub computes statistics', async () => {
    const { app } = appWith([
      [/\/stats\//, () => new Response('', { status: 202 })],
      [/\/repos\/acme\/tool$/, () => jsonResponse(rawRepo())],
    ]);
    const body = activityResponseSchema.parse(
      (await request(app).get('/api/v1/repos/acme/tool/activity')).body,
    );
    expect(body).toMatchObject({ status: 'pending', commitsByWeek: null, contributors: null });
  });

  it('ranks similar repositories by shared topics and language', async () => {
    const { app } = appWith([
      [
        /\/search\/repositories/,
        () =>
          jsonResponse(
            searchBody([
              rawRepo({ full_name: 'acme/tool' }),
              rawRepo({ full_name: 'x/close', topics: ['cli', 'devtools'], stargazers_count: 5 }),
              rawRepo({
                full_name: 'x/far',
                topics: ['cli'],
                language: 'Go',
                description: 'unrelated',
                stargazers_count: 9000,
              }),
            ]),
          ),
      ],
      [/\/repos\/acme\/tool$/, () => jsonResponse(rawRepo())],
    ]);
    const body = similarResponseSchema.parse(
      (await request(app).get('/api/v1/repos/acme/tool/similar')).body,
    );
    expect(body.items.map((i) => i.repo.fullName)).toEqual(['x/close', 'x/far']);
  });

  it('serves a repository to anonymous visitors', async () => {
    const { app } = appWith(repoRoutes);
    const res = await request(app).get('/api/v1/repos/acme/tool');
    expect(res.status).toBe(200);
    expect(repoResponseSchema.parse(res.body).repo.fullName).toBe('acme/tool');
  });
});

describe('GET /compare', () => {
  it('compares repositories and flags the ones that do not exist', async () => {
    const { app } = appWith([
      [/\/repos\/acme\/tool\/contents/, () => jsonResponse([{ name: 'README.md', type: 'file' }])],
      [/\/search\/issues/, () => jsonResponse(issues(1))],
      [
        /\/stats\/commit_activity/,
        () => jsonResponse(Array.from({ length: 52 }, () => ({ total: 3 }))),
      ],
      [/\/repos\/acme\/tool$/, () => jsonResponse(rawRepo())],
    ]);
    const res = await request(app).get('/api/v1/compare?repos=acme/tool,acme/missing');
    const body = compareResponseSchema.parse(res.body);
    expect(body.items[0]).toMatchObject({ status: 'ok', commitsLast4Weeks: 12 });
    expect(body.items[1]).toMatchObject({
      status: 'not_found',
      repo: null,
      commitsLast4Weeks: null,
    });
  });

  it('needs between two and four valid repositories', async () => {
    const { app } = appWith([]);
    expect((await request(app).get('/api/v1/compare?repos=acme/tool')).status).toBe(400);
    expect((await request(app).get('/api/v1/compare?repos=a/b,c/d,e/f,g/h,i/j')).status).toBe(400);
    expect((await request(app).get('/api/v1/compare?repos=bad,worse')).status).toBe(400);
  });
});

describe('GET /contribute and /developers', () => {
  it('lists good first issues', async () => {
    const { app } = appWith([[/\/search\/issues/, () => jsonResponse(issues(1))]]);
    const res = await request(app).get('/api/v1/contribute?language=typescript');
    const body = contributeResponseSchema.parse(res.body);
    expect(body.items[0]).toMatchObject({ repo: 'acme/tool', number: 7 });
  });

  it('summarises a developer from public repositories', async () => {
    const { app } = appWith([
      [
        /\/users\/octo\/repos/,
        () =>
          jsonResponse([
            rawRepo({ full_name: 'octo/a', stargazers_count: 10 }),
            rawRepo({ full_name: 'octo/b', stargazers_count: 30, language: 'Go' }),
            rawRepo({ full_name: 'octo/old', stargazers_count: 5, archived: true }),
          ]),
      ],
      [
        /\/users\/octo$/,
        () =>
          jsonResponse({
            login: 'octo',
            name: 'Octo',
            avatar_url: null,
            bio: null,
            public_repos: 3,
            followers: 8,
            created_at: '2015-01-01T00:00:00Z',
          }),
      ],
    ]);
    const body = developerProfileSchema.parse(
      (await request(app).get('/api/v1/developers/octo')).body,
    );
    expect(body.totalStars).toBe(40);
    expect(body.topRepos[0]?.fullName).toBe('octo/b');
    expect(body.topLanguages.map((l) => l.language).sort()).toEqual(['Go', 'TypeScript']);
  });

  it('answers 404 for an unknown developer and 400 for a bad login', async () => {
    const { app } = appWith([]);
    expect((await request(app).get('/api/v1/developers/ghost')).status).toBe(404);
    expect((await request(app).get('/api/v1/developers/-bad-')).status).toBe(400);
  });
});
