import mongoose from 'mongoose';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  activitySchema,
  architectureEvolutionSchema,
  compareSchema,
  dependenciesSchema,
  docQuotaSchema,
  errorResponseSchema,
  languagesSchema,
  qualitySchema,
  releaseSummarySchema,
  releasesSchema,
  snapshotCompareSchema,
  timelineSchema,
} from '@repointelligence/shared';
import { useMemoryDb } from '../../test/db.js';
import { healthyInputs, NOW, troubledInputs } from '../../test/fixtures/analysis.js';
import { fixtureGraph } from '../../test/fixtures/graph.js';
import { FakeProvider } from '../../test/fixtures/llm.js';
import { authTestConfig } from '../../test/env.js';
import { jsonResponse, rawRepo } from '../../test/github-fixtures.js';
import { oauthFetch, signInWith } from '../../test/sign-in.js';
import type { AnalysisInputs } from '../analysis/inputs.js';
import { computeHealth } from '../analysis/scoring.js';
import { createApp } from '../app.js';
import { DOC_QUOTA } from '../docs/quota.js';
import { GithubService } from '../github/service.js';
import { LlmGateway } from '../llm/gateway.js';
import { createLogger } from '../logger.js';
import { AnalysisRun } from '../models/analysis-run.js';
import { ArchitectureGraphModel } from '../models/architecture-graph.js';
import { GithubCache } from '../models/github-cache.js';
import { ReleaseSummary } from '../models/release-summary.js';
import { User } from '../models/user.js';

useMemoryDb();

beforeEach(async () => {
  for (const collection of Object.values(mongoose.connection.collections)) {
    await collection.deleteMany({});
  }
});

const sleep = () => Promise.resolve();
const BASE = '/api/v1/repos/acme/tool/evolution';
const DAY = 86_400_000;
const errorOf = (res: { body: unknown }) => errorResponseSchema.parse(res.body).error;
const SUMMARY = 'Adds CSV export and moves to Express 5.';

interface FakeOptions {
  private?: boolean;
  pending?: 'once' | 'always';
  releases?: boolean;
}

/** GitHub's history endpoints for acme/tool, with dates relative to now. */
function history(options: FakeOptions = {}) {
  const now = Date.now();
  const at = (daysAgo: number) => new Date(now - daysAgo * DAY).toISOString();
  const week = (weeksAgo: number) => Math.floor((now - weeksAgo * 7 * DAY) / 1000);
  const counts = { commitActivity: 0 };
  const accepts: string[] = [];
  const commit = (sha: string, message: string, login = 'ana') => ({ sha, html_url: `https://github.com/acme/tool/commit/${sha}`, commit: { message, author: { name: login, date: at(3) } }, author: { login } }); // prettier-ignore
  const release = (tag: string, daysAgo: number) => ({ tag_name: tag, name: tag, published_at: at(daysAgo), created_at: at(daysAgo), prerelease: false, draft: false, html_url: `https://github.com/acme/tool/releases/${tag}` }); // prettier-ignore
  const pkg = (express: string) => JSON.stringify({ dependencies: { express } });
  const files: Record<string, string> = { 'v1.0.0:package.json': pkg('^4.18.0'), 'v1.1.0:package.json': pkg('^5.1.0') };

  const api = (url: string, init?: RequestInit): Response | undefined => {
    const { pathname, searchParams } = new URL(url);
    const p = '/repos/acme/tool';
    if (pathname === p) return jsonResponse(rawRepo({ private: options.private ?? false, stargazers_count: 250, forks_count: 12, open_issues_count: 4 })); // prettier-ignore
    if (pathname === '/repos/acme/secret') return jsonResponse({ message: 'Not Found' }, 404);
    if (pathname === `${p}/stats/commit_activity`) {
      counts.commitActivity += 1;
      if (options.pending === 'always' || (options.pending === 'once' && counts.commitActivity === 1)) return jsonResponse({}, 202); // prettier-ignore
      return jsonResponse(Array.from({ length: 52 }, (_, i) => ({ week: week(51 - i), total: i % 2 ? 4 : 2, days: [0, 1, 1, 0, 1, 1, 0] }))); // prettier-ignore
    }
    if (pathname === `${p}/stats/code_frequency`) return jsonResponse({ message: 'too many commits' }, 422);
    if (pathname === `${p}/stats/contributors`) {
      return jsonResponse([
        { author: { login: 'ana' }, total: 30, weeks: [{ w: week(1), a: 50, d: 5, c: 10 }, { w: week(0), a: 20, d: 2, c: 5 }] },
        { author: { login: 'bo' }, total: 2, weeks: [{ w: week(1), a: 0, d: 0, c: 0 }, { w: week(0), a: 5, d: 1, c: 2 }] },
      ]);
    } // prettier-ignore
    if (pathname === `${p}/pulls`) {
      return jsonResponse([
        { created_at: at(10), updated_at: at(2), closed_at: at(2), merged_at: at(2) },
        { created_at: at(5), updated_at: at(1), closed_at: null, merged_at: null },
      ]);
    } // prettier-ignore
    if (pathname === `${p}/issues`) {
      return jsonResponse([
        { created_at: at(8), updated_at: at(1), closed_at: at(1) },
        { created_at: at(4), updated_at: at(4), closed_at: null, pull_request: { url: 'x' } },
      ]);
    } // prettier-ignore
    if (pathname === `${p}/stargazers`) {
      accepts.push(new Headers(init?.headers).get('accept') ?? '');
      const page = Number(searchParams.get('page'));
      return jsonResponse([{ starred_at: at(300 - page * 50) }]);
    }
    if (pathname === `${p}/languages`) return jsonResponse({ TypeScript: 9000, Python: 1000 });
    if (pathname === `${p}/releases`) {
      return jsonResponse(options.releases === false ? [] : [release('v1.1.0', 7), release('v1.0.0', 40)]);
    }
    if (pathname === `${p}/tags`) return jsonResponse([{ name: 'v0.2' }, { name: 'v0.1' }]);
    if (pathname === `${p}/commits`) {
      return jsonResponse([commit('c2', 'feat(api): add CSV export (#9)'), commit('c1', 'Merge branch dev', 'bo')]);
    }
    if (pathname === `${p}/compare/v1.0.0...v1.1.0`) {
      return jsonResponse({
        status: 'ahead', ahead_by: 2, behind_by: 0, total_commits: 2,
        commits: [commit('c1', 'feat: add CSV export'), commit('c2', 'chore(deps): express 5', 'bo')],
        files: [
          { filename: 'package.json', status: 'modified', additions: 1, deletions: 1 },
          { filename: 'src/export/csv.ts', status: 'added', additions: 80, deletions: 0 },
        ],
      });
    } // prettier-ignore
    const contents = new RegExp(`^${p}/contents/(.+)$`).exec(pathname);
    if (contents?.[1]) {
      const file = files[`${searchParams.get('ref') ?? ''}:${contents[1]}`];
      if (file === undefined) return jsonResponse({ message: 'Not Found' }, 404);
      return jsonResponse({ type: 'file', encoding: 'base64', content: Buffer.from(file).toString('base64') });
    }
    return undefined;
  };
  return { api, counts, accepts };
} // prettier-ignore

function anonymous(options: FakeOptions = {}) {
  const fake = history(options);
  const fetchImpl = oauthFetch(1, fake.api);
  const app = createApp(authTestConfig, createLogger(authTestConfig), {
    fetch: fetchImpl,
    github: new GithubService({ fetch: fetchImpl, sleep }),
    sleep,
  });
  return { app, ...fake };
}

async function signedIn(options: FakeOptions & { replies?: string[] } = {}) {
  const fake = history(options);
  const provider = new FakeProvider('groq', options.replies ?? [JSON.stringify({ summary: SUMMARY, highlights: ['CSV export'], risks: ['Express 5 is a major upgrade'] })]); // prettier-ignore
  const signed = await signInWith({
    api: fake.api,
    makeGithub: (fetchImpl) => new GithubService({ fetch: fetchImpl, sleep }),
    extraDeps: { llm: new LlmGateway({ providers: { groq: provider }, sleep }), sleep },
  });
  const user = await User.findOne({ githubId: 1 });
  if (!user) throw new Error('expected a user');
  return { ...signed, ...fake, provider, userId: user.id };
}

async function seedRun(fullName: string, inputs: AnalysisInputs, daysAgo: number, sha: string) {
  return AnalysisRun.create({
    fullName,
    requestedBy: new mongoose.Types.ObjectId(),
    sha,
    status: 'succeeded',
    score: computeHealth(inputs, NOW),
    inputs,
    finishedAt: new Date(Date.now() - daysAgo * DAY),
  });
}

describe('activity', () => {
  it('builds every series from GitHub for an anonymous visitor', async () => {
    const { app, counts, accepts } = anonymous({ pending: 'once' });
    const res = await request(app).get(`${BASE}/activity?weeks=12`);
    expect(res.status).toBe(200);
    const body = activitySchema.parse(res.body);
    expect(body.interpretation).toBeNull();
    expect(body.sources).toEqual(['github', 'computed']);
    const { facts } = body;

    // GitHub answered 202 first; the second answer was used.
    expect(counts.commitActivity).toBe(2);
    expect(facts.commits.status).toBe('ok');
    expect(facts.commits.points).toHaveLength(12);
    expect(facts.commits.points.every((p) => p.commits !== null)).toBe(true);

    expect(facts.codeFrequency).toMatchObject({ status: 'unavailable', points: [] });
    expect(facts.codeFrequency.reason).toMatch(/large/);

    expect(facts.contributors.top.map((t) => [t.login, t.commits])).toEqual([['ana', 15], ['bo', 2]]);
    expect(facts.contributors.busFactor).toBe(1);

    const sum = <T>(xs: T[], f: (x: T) => number | null) => xs.reduce((a, x) => a + (f(x) ?? 0), 0);
    expect(sum(facts.pullRequests.points, (p) => p.opened)).toBe(2);
    expect(sum(facts.pullRequests.points, (p) => p.merged)).toBe(1);
    expect(facts.pullRequests.medianHoursToMerge).toBe(192);
    // The pull request in the issues listing is not counted as an issue.
    expect(sum(facts.issues.points, (p) => p.opened)).toBe(1);
    expect(facts.issues.medianHoursToClose).toBe(168);

    expect(facts.growth).toMatchObject({ status: 'ok', stars: 250, forks: 12, openIssues: 4, sampled: false });
    expect(facts.growth.starPoints.map((p) => p.stars)).toEqual([1, 101, 201, 250]);
    expect(accepts).toEqual(Array(3).fill('application/vnd.github.star+json'));
  }); // prettier-ignore

  it('reports statistics GitHub is still computing as pending, never as zero', async () => {
    const { app } = anonymous({ pending: 'always' });
    const body = activitySchema.parse((await request(app).get(`${BASE}/activity`)).body);
    expect(body.facts.commits).toMatchObject({ status: 'pending', points: [], total: null });
    expect(body.notes.join(' ')).toMatch(/still computing/);
    expect(body.facts.weeks).toBe(52);
  });

  it('rejects windows it does not offer', async () => {
    const { app } = anonymous();
    expect((await request(app).get(`${BASE}/activity?weeks=30`)).status).toBe(400);
  });
});

describe('timeline, releases and compare', () => {
  it('lists recent commits with their groups and the releases', async () => {
    const { app } = anonymous();
    const body = timelineSchema.parse((await request(app).get(`${BASE}/timeline`)).body);
    expect(body.facts.ref).toBe('main');
    expect(body.facts.commits.map((c) => [c.group, c.pr])).toEqual([
      ['feat', 9],
      ['merge', null],
    ]);
    expect(body.facts.releases.map((r) => r.tag)).toEqual(['v1.1.0', 'v1.0.0']);
    expect(body.facts.hasMore).toBe(false);
  });

  it('measures release cadence, and falls back to undated tags', async () => {
    const withReleases = releasesSchema.parse((await request(anonymous().app).get(`${BASE}/releases?weeks=12`)).body);
    expect(withReleases.facts).toMatchObject({ source: 'releases', inWindow: 2, medianDaysBetween: 33 });
    // Both apps share the database, so drop the cached release listing first.
    await GithubCache.deleteMany({});
    const tagsOnly = releasesSchema.parse((await request(anonymous({ releases: false }).app).get(`${BASE}/releases`)).body);
    expect(tagsOnly.facts).toMatchObject({ source: 'tags', inWindow: null, medianDaysBetween: null });
    expect(tagsOnly.notes[0]).toMatch(/tags carry no dates/);
  }); // prettier-ignore

  it('compares two refs with file and dependency changes', async () => {
    const { app } = anonymous();
    const res = await request(app).get(`${BASE}/compare?base=v1.0.0&head=v1.1.0`);
    expect(res.status).toBe(200);
    const { facts } = compareSchema.parse(res.body);
    expect(facts).toMatchObject({ status: 'ahead', aheadBy: 2, totalCommits: 2, authors: 2 });
    expect(facts.groups).toMatchObject({ feat: 1, chore: 1 });
    expect(facts.files.directories[0]).toMatchObject({ path: 'src/export', files: 1 });
    expect(facts.dependencies.manifests[0]?.changed).toEqual([
      { name: 'express', scope: 'runtime', from: '^4.18.0', to: '^5.1.0', change: 'major', direction: 'upgrade' },
    ]);
    const deps = dependenciesSchema.parse((await request(app).get(`${BASE}/dependencies?base=v1.0.0&head=v1.1.0`)).body);
    expect(deps.facts.changes.manifests).toHaveLength(1);
  }); // prettier-ignore

  it('rejects ranges and unknown refs', async () => {
    const { app } = anonymous();
    expect((await request(app).get(`${BASE}/compare?base=a..b&head=main`)).status).toBe(400);
    expect((await request(app).get(`${BASE}/compare?base=v0&head=v9`)).status).toBe(404);
  });
});

describe('stored history', () => {
  beforeEach(async () => {
    await seedRun('acme/tool', healthyInputs(), 20, 'a'.repeat(40));
    await seedRun('acme/tool', troubledInputs(), 2, 'b'.repeat(40));
  });

  it('charts health, debt and regressions across analyses', async () => {
    const body = qualitySchema.parse((await request(anonymous().app).get(`${BASE}/quality`)).body);
    expect(body.sources).toEqual(['analysis', 'computed']);
    expect(body.facts.points.map((p) => p.sha[0])).toEqual(['a', 'b']);
    expect(body.facts.regressions.length).toBeGreaterThan(0);
    expect(body.facts.regressions.every((r) => r.sha === 'b'.repeat(40))).toBe(true);
    expect(body.facts.thresholds).toEqual({ overallDrop: 10, areaDrop: 10, findingsRise: 0.2 });
  });

  it('compares two snapshots by id and refuses ids from another repository', async () => {
    const { app } = anonymous();
    const [a = '', b = ''] = (await AnalysisRun.find({ fullName: 'acme/tool' }).sort({ finishedAt: 1 })).map((r) => r.id);
    const res = await request(app).get(`${BASE}/snapshots/compare?a=${a}&b=${b}`);
    const { facts } = snapshotCompareSchema.parse(res.body);
    expect(facts.delta.overall).toBeLessThan(0);
    expect(facts.findings.introducedCount).toBeGreaterThan(0);
    expect(facts.findings.resolvedCount).toBe(0);
    expect(facts.languages.a).toEqual({ Python: 0.8, TypeScript: 0.2 });

    const other = await seedRun('acme/other', healthyInputs(), 1, 'c'.repeat(40));
    const foreign = await request(app).get(`${BASE}/snapshots/compare?a=${a}&b=${other.id}`);
    expect(foreign.status).toBe(404);
    expect((await request(app).get(`${BASE}/snapshots/compare?a=1&b=2`)).status).toBe(400);
  }); // prettier-ignore

  it('combines analysed language lines with the current breakdown from GitHub', async () => {
    const body = languagesSchema.parse((await request(anonymous().app).get(`${BASE}/languages`)).body);
    expect(body.facts.points.map((p) => [p.source, p.unit])).toEqual([['analysis', 'lines'], ['analysis', 'lines'], ['github', 'bytes']]);
    expect(body.facts.points.at(-1)?.shares).toEqual({ TypeScript: 0.9, Python: 0.1 });
    expect(body.notes[0]).toMatch(/2 analysis snapshots/);
  }); // prettier-ignore

  it('detects architecture changes between stored graphs', async () => {
    const before = fixtureGraph();
    const after = fixtureGraph();
    after.files = after.files.slice(1);
    await ArchitectureGraphModel.create([
      { fullName: 'acme/tool', sha: 'a'.repeat(40), graph: before, computedAt: new Date(Date.now() - 5 * DAY) },
      { fullName: 'acme/tool', sha: 'b'.repeat(40), graph: after, computedAt: new Date() },
    ]); // prettier-ignore
    const body = architectureEvolutionSchema.parse(
      (await request(anonymous().app).get(`${BASE}/architecture`)).body,
    );
    expect(body.facts.snapshots).toHaveLength(2);
    expect(body.facts.changes[0]).toMatchObject({
      from: 'a'.repeat(40),
      to: 'b'.repeat(40),
      filesRemoved: 1,
    });
  });

  it('hides stored history of a repository the visitor cannot see on GitHub', async () => {
    await seedRun('acme/secret', healthyInputs(), 1, 'd'.repeat(40));
    const res = await request(anonymous().app).get('/api/v1/repos/acme/secret/evolution/quality');
    expect(res.status).toBe(404);
  });
});

describe('release summaries', () => {
  it('requires sign-in', async () => {
    const res = await request(anonymous().app)
      .post(`${BASE}/release-summary`)
      .send({ tag: 'v1.1.0' });
    expect(res.status).toBe(401);
  });

  it('keeps retrieved facts and the model reading in separate fields, and reuses it', async () => {
    const { agent, provider } = await signedIn();
    const res = await agent.post(`${BASE}/release-summary`).send({ tag: 'v1.1.0' });
    expect(res.status).toBe(201);
    const body = releaseSummarySchema.parse(res.body);
    expect(body.facts).toMatchObject({ tag: 'v1.1.0', base: 'v1.0.0' });
    expect(body.facts.compare?.dependencies.manifests[0]?.changed[0]?.change).toBe('major');
    expect(body.interpretation).toMatchObject({ summary: SUMMARY, highlights: ['CSV export'] });
    expect(body.interpretation?.writtenBy).toMatch(/^groq\//);
    expect(JSON.stringify(body.facts)).not.toContain(SUMMARY);

    const again = await agent.post(`${BASE}/release-summary`).send({ tag: 'v1.1.0' });
    expect(again.status).toBe(200);
    expect(releaseSummarySchema.parse(again.body)).toMatchObject({ id: body.id, reused: true });
    expect(provider.calls).toHaveLength(1);

    const quota = docQuotaSchema.parse((await agent.get('/api/v1/me/docs-quota')).body);
    expect(quota.usedToday).toBe(1);
  });

  it('has nothing to compare the first release with, and charges nothing for it', async () => {
    const { agent, provider } = await signedIn();
    const body = releaseSummarySchema.parse((await agent.post(`${BASE}/release-summary`).send({ tag: 'v1.0.0' })).body);
    expect(body.facts.compare).toBeNull();
    expect(body.interpretation).toBeNull();
    expect(body.interpretationNote).toMatch(/first release/);
    expect(provider.calls).toHaveLength(0);
    expect(await ReleaseSummary.countDocuments({ charged: true })).toBe(0);
  }); // prettier-ignore

  it('keeps private repositories away from models without the opt-in', async () => {
    const { agent, provider } = await signedIn({ private: true });
    const body = releaseSummarySchema.parse((await agent.post(`${BASE}/release-summary`).send({ tag: 'v1.1.0' })).body);
    expect(body.facts.compare).not.toBeNull();
    expect(body.interpretation).toBeNull();
    expect(body.interpretationNote).toMatch(/private repositories is off/);
    expect(provider.calls).toHaveLength(0);
  }); // prettier-ignore

  it('shares the daily generation quota with documents and rejects unknown tags', async () => {
    const { agent, userId } = await signedIn();
    expect((await agent.post(`${BASE}/release-summary`).send({ tag: 'v9.9.9' })).status).toBe(404);
    expect(
      (await agent.post(`${BASE}/release-summary`).send({ tag: 'v1.1.0', extra: 1 })).status,
    ).toBe(400);
    await ReleaseSummary.create(
      Array.from({ length: DOC_QUOTA.dailyGenerations }, (_, i) => ({
        fullName: 'acme/other', tag: `v${i}`, createdBy: userId, facts: {}, charged: true,
      })),
    ); // prettier-ignore
    const res = await agent.post(`${BASE}/release-summary`).send({ tag: 'v1.1.0' });
    expect(res.status).toBe(429);
    expect(errorOf(res).code).toBe('QUOTA_EXCEEDED');
  });
});
