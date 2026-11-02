import mongoose from 'mongoose';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  graphDiffSchema,
  graphRunSchema,
  graphSummarySchema,
  graphViewResponseSchema,
  sourceFileSchema,
  traceResponseSchema,
} from '@repointelligence/shared';
import { InlineQueue, type RunHandler } from '../analysis/queue.js';
import { useMemoryDb } from '../../test/db.js';
import { authTestConfig } from '../../test/env.js';
import { fixtureGraph } from '../../test/fixtures/graph.js';
import {
  NODE_SERVICE,
  makeRepo,
  withSignals,
  type FixtureRepo,
} from '../../test/fixtures/repos.js';
import { WORKER_SECRET, WORKER_URL, fakeWorker } from '../../test/fixtures/worker.js';
import { jsonResponse } from '../../test/github-fixtures.js';
import { signInWith } from '../../test/sign-in.js';
import { createApp } from '../app.js';
import { GithubService } from '../github/service.js';
import { createLogger } from '../logger.js';
import { ArchitectureGraphModel } from '../models/architecture-graph.js';
import { GraphRun } from '../models/graph-run.js';

useMemoryDb();

const config = { ...authTestConfig, WORKER_URL, WORKER_SHARED_SECRET: WORKER_SECRET };
const BASE = '/api/v1/repos/acme/users-api';

function build(repo: FixtureRepo, graph = fixtureGraph) {
  const github = withSignals(repo);
  const api = (url: string): Response | undefined => {
    const { pathname, searchParams } = new URL(url);
    if (pathname === '/repos/acme/users-api/contents/src/index.ts' && searchParams.get('ref')) {
      return jsonResponse({
        type: 'file',
        size: 12,
        encoding: 'base64',
        content: Buffer.from('const a = 1;').toString('base64'),
      });
    }
    return github(url);
  };
  // The worker answers /v1/graph with the fixture; /v1/scan is never called here.
  const fake = fakeWorker(api, () => jsonResponse(graph()));
  let inline: InlineQueue | undefined;
  return {
    fake,
    deps: {
      makeGithub: (fetchImpl: typeof fetch) =>
        new GithubService({ fetch: fetchImpl, sleep: () => Promise.resolve() }),
      queue: (handler: RunHandler) => {
        inline = new InlineQueue(handler);
        return inline;
      },
    },
    drain: () => inline?.drain() ?? Promise.resolve(),
  };
}

async function signedIn(repo = makeRepo('acme/users-api', NODE_SERVICE), githubId = 1) {
  const { fake, deps, drain } = build(repo);
  const session = await signInWith({
    githubId,
    api: fake.api,
    makeGithub: deps.makeGithub,
    config,
    extraDeps: { queue: deps.queue },
  });
  return { ...session, drain, repo, fake };
}

beforeEach(async () => {
  for (const name of ['users', 'githubcaches', 'graphruns', 'architecturegraphs']) {
    await mongoose.connection.collection(name).deleteMany({});
  }
});

describe('POST /repos/:owner/:name/graph', () => {
  it('needs a session and a configured worker', async () => {
    const { fake } = build(makeRepo('acme/users-api', NODE_SERVICE));
    const anon = createApp(config, createLogger(config), { fetch: fake.fetch });
    expect((await request(anon).post(`${BASE}/graph`)).status).toBe(401);
    const { agent } = await signInWith({ api: fake.api, config: authTestConfig });
    const res = await agent.post(`${BASE}/graph`);
    expect(res.status).toBe(503);
    expect((res.body as { error: { code: string } }).error.code).toBe('WORKER_UNAVAILABLE');
  });

  it('builds, stores and reuses a graph for the commit', async () => {
    const { agent, drain, repo, fake } = await signedIn();
    const started = await agent.post(`${BASE}/graph`);
    expect(started.status).toBe(202);
    const run = graphRunSchema.parse(started.body);
    expect(run.status).toBe('queued');
    await drain();

    const finished = graphRunSchema.parse((await agent.get(`/api/v1/graph-builds/${run.id}`)).body);
    expect(finished.status).toBe('succeeded');
    expect(finished.summary?.stats.filesParsed).toBe(6);
    expect(finished.summary?.routes).toHaveLength(3);
    expect(finished.summary?.detected).toBe(true);
    expect(await ArchitectureGraphModel.countDocuments({ sha: repo.commits[0] })).toBe(1);
    expect(fake.scans()).toBe(1);

    const again = await agent.post(`${BASE}/graph`);
    expect(again.status).toBe(200);
    expect(graphRunSchema.parse(again.body).reused).toBe(true);
  });
});

describe('reading a graph', () => {
  async function ready() {
    const session = await signedIn();
    await session.agent.post(`${BASE}/graph`);
    await session.drain();
    return { ...session, sha: session.repo.commits[0] ?? '' };
  }

  it('serves the summary, views, mermaid, trace and source to anyone', async () => {
    const { app, sha } = await ready();
    const summary = graphSummarySchema.parse((await request(app).get(`${BASE}/graph/latest`)).body);
    expect(summary.sha).toBe(sha);
    expect(summary.layers.presentation).toBe(1);
    expect(summary.folders.children[0]?.name).toBe('src');
    expect(summary.cycles).toHaveLength(1);

    const modules = graphViewResponseSchema.parse(
      (await request(app).get(`${BASE}/graph/${sha}/view?view=modules`)).body,
    );
    expect(modules.nodes.length).toBeGreaterThan(3);
    const symbols = graphViewResponseSchema.parse(
      (await request(app).get(`${BASE}/graph/${sha}/view?view=symbols&file=src/services/orders.ts`))
        .body,
    );
    expect(symbols.nodes.some((n) => n.id === 'src/services/orders.ts#save')).toBe(true);

    const mermaid = await request(app).get(`${BASE}/graph/${sha}/mermaid?diagram=routes`);
    expect(mermaid.headers['content-type']).toContain('text/plain');
    expect(mermaid.headers['content-disposition']).toContain('routes.mmd');
    expect(mermaid.text).toContain('flowchart LR');
    expect(mermaid.text).toContain('GET /orders');

    const trace = traceResponseSchema.parse(
      (
        await request(app).get(
          `${BASE}/graph/${sha}/trace?route=${encodeURIComponent('POST /orders')}`,
        )
      ).body,
    );
    expect(trace.steps.map((s) => s.label)).toContain('notify');

    const source = sourceFileSchema.parse(
      (await request(app).get(`${BASE}/source/${sha}/src/index.ts`)).body,
    );
    expect(source).toMatchObject({
      content: 'const a = 1;',
      language: 'typescript',
      truncated: false,
    });
  });

  it('validates inputs and answers 404 when nothing was built', async () => {
    const { app, sha } = await ready();
    expect((await request(app).get(`${BASE}/graph/${sha}/view?view=nope`)).status).toBe(400);
    expect((await request(app).get(`${BASE}/graph/${sha}/mermaid?diagram=pie`)).status).toBe(400);
    expect((await request(app).get(`${BASE}/graph/${sha}/trace`)).status).toBe(400);
    expect((await request(app).get(`${BASE}/graph/${'f'.repeat(40)}`)).status).toBe(404);
    expect((await request(app).get('/api/v1/repos/acme/other/graph/latest')).status).toBe(404);
    expect((await request(app).get(`${BASE}/source/${sha}/../etc/passwd`)).status).toBe(400);
    expect((await request(app).get(`${BASE}/source/not-a-sha/src/index.ts`)).status).toBe(400);
  });

  it('diffs two stored graphs', async () => {
    const { app, agent, drain, repo, sha } = await ready();
    repo.commits.push('b'.repeat(40));
    await ArchitectureGraphModel.updateOne({ sha }, { $set: { treeDigest: 'old' } });
    // The branch head is cached for a minute, so the second build names its commit.
    await agent.post(`${BASE}/graph`).send({ ref: 'b'.repeat(40) });
    await drain();
    expect(await GraphRun.countDocuments({ status: 'succeeded' })).toBe(2);
    const res = await request(app).get(`${BASE}/graph/diff?from=${sha}&to=${'b'.repeat(40)}`);
    expect(res.status).toBe(200);
    const diff = graphDiffSchema.parse(res.body);
    expect(diff.files).toEqual({ added: [], removed: [] });
    expect(diff.stats).toEqual({ filesBefore: 6, filesAfter: 6 });
    expect((await request(app).get(`${BASE}/graph/diff?from=${sha}`)).status).toBe(400);
  });
});
