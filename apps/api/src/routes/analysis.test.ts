import mongoose from 'mongoose';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  analysisRunSchema,
  errorResponseSchema,
  healthHistorySchema,
  quotaSchema,
  simulateResponseSchema,
} from '@repointelligence/shared';
import { InlineQueue, type RunHandler } from '../analysis/queue.js';
import { useMemoryDb } from '../../test/db.js';
import { authTestConfig } from '../../test/env.js';
import { healthyScan, NOW } from '../../test/fixtures/analysis.js';
import { NODE_SERVICE, makeRepo, withSignals } from '../../test/fixtures/repos.js';
import { WORKER_SECRET, WORKER_URL, fakeWorker } from '../../test/fixtures/worker.js';
import { signInWith } from '../../test/sign-in.js';
import { createApp } from '../app.js';
import { GithubService } from '../github/service.js';
import { createLogger } from '../logger.js';
import { AnalysisRun } from '../models/analysis-run.js';

useMemoryDb();

const config = { ...authTestConfig, WORKER_URL, WORKER_SHARED_SECRET: WORKER_SECRET };
const BASE = '/api/v1/repos/acme/users-api';
let clock = NOW;

/** Everything the routes need: a fake GitHub, a fake worker and an inline queue we can drain. */
function build() {
  const repo = makeRepo('acme/users-api', NODE_SERVICE);
  const fake = fakeWorker(withSignals(repo), healthyScan);
  let inline: InlineQueue | undefined;
  const deps = {
    makeGithub: (fetchImpl: typeof fetch) =>
      new GithubService({ fetch: fetchImpl, now: () => clock, sleep: () => Promise.resolve() }),
    queue: (handler: RunHandler) => {
      inline = new InlineQueue(handler);
      return inline;
    },
  };
  const drain = () => inline?.drain() ?? Promise.resolve();
  return { repo, fake, deps, drain };
}

beforeEach(async () => {
  for (const name of ['users', 'githubcaches', 'analysisruns', 'scancaches']) {
    await mongoose.connection.collection(name).deleteMany({});
  }
  clock = NOW;
});

async function signedIn(githubId = 1) {
  const { fake, deps, drain, repo } = build();
  const session = await signInWith({
    githubId,
    api: fake.api,
    makeGithub: deps.makeGithub,
    config,
    extraDeps: { queue: deps.queue },
  });
  return { ...session, drain, repo };
}

describe('POST /repos/:owner/:name/analyze', () => {
  it('needs a session', async () => {
    const { fake } = build();
    const app = createApp(config, createLogger(config), { fetch: fake.fetch });
    expect((await request(app).post(`${BASE}/analyze`)).status).toBe(401);
  });

  it('queues a run, reports progress and ends with a score', async () => {
    const { agent, drain } = await signedIn();
    const started = await agent.post(`${BASE}/analyze`).send({});
    expect(started.status).toBe(202);
    const run = analysisRunSchema.parse(started.body);
    expect(run.status).toBe('queued');
    expect(run.score).toBeNull();

    await drain();
    const finished = analysisRunSchema.parse((await agent.get(`/api/v1/analyses/${run.id}`)).body);
    expect(
      finished.status,
      `${finished.progress.message} ${finished.error ?? ''} attempt=${finished.attempt}`,
    ).toBe('succeeded');
    expect(finished.progress).toMatchObject({ step: 'done', percent: 100 });
    expect(finished.score?.overall).toBeGreaterThan(70);
    expect(finished.score?.areas).toHaveLength(11);

    const again = await agent.post(`${BASE}/analyze`);
    expect(again.status).toBe(200);
    expect(analysisRunSchema.parse(again.body).reused).toBe(true);
  });

  it('validates the body', async () => {
    const { agent } = await signedIn();
    expect((await agent.post(`${BASE}/analyze`).send({ ref: 'bad ref!' })).status).toBe(400);
    expect((await agent.post(`${BASE}/analyze`).send({ force: 'yes' })).status).toBe(400);
  });
});

describe('reading results', () => {
  it('answers 404 before any analysis and serves the latest score to anyone afterwards', async () => {
    const { agent, drain, app } = await signedIn();
    expect((await request(app).get(`${BASE}/health`)).status).toBe(404);
    await agent.post(`${BASE}/analyze`);
    await drain();
    const health = await request(app).get(`${BASE}/health`);
    expect(health.status).toBe(200);
    const run = analysisRunSchema.parse(health.body);
    expect(run.score?.formula).toContain('weight-averaged');
    expect(run.score?.areas.find((a) => a.id === 'architecture')?.score).toBeNull();
    const history = healthHistorySchema.parse(
      (await request(app).get(`${BASE}/health/history`)).body,
    );
    expect(history.items).toHaveLength(1);
  });

  it('simulates against the latest score', async () => {
    const { agent, drain, app } = await signedIn();
    await agent.post(`${BASE}/analyze`);
    await drain();
    const res = await request(app)
      .post(`${BASE}/health/simulate`)
      .send({ addFiles: ['ci'] });
    expect(res.status).toBe(200);
    const sim = simulateResponseSchema.parse(res.body);
    expect(sim.estimate).toBe(true);
    expect((await request(app).post(`${BASE}/health/simulate`).send({ unknown: 1 })).status).toBe(
      400,
    );
    expect(
      (await request(app).post('/api/v1/repos/acme/never/health/simulate').send({})).status,
    ).toBe(404);
  });

  it('rejects malformed run ids', async () => {
    const { app } = await signedIn();
    expect((await request(app).get('/api/v1/analyses/not-an-id')).status).toBe(400);
    expect((await request(app).get(`/api/v1/analyses/${'a'.repeat(24)}`)).status).toBe(404);
  });
});

describe('cancel and quota', () => {
  it('lets only the requester cancel, and reports the quota', async () => {
    const owner = await signedIn(1);
    const started = analysisRunSchema.parse((await owner.agent.post(`${BASE}/analyze`)).body);
    const other = await signedIn(2);
    const denied = await other.agent.post(`/api/v1/analyses/${started.id}/cancel`);
    expect(denied.status).toBe(404);
    expect((await request(other.app).post(`/api/v1/analyses/${started.id}/cancel`)).status).toBe(
      401,
    );

    const cancelled = await owner.agent.post(`/api/v1/analyses/${started.id}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(['cancelled', 'running', 'succeeded']).toContain(
      analysisRunSchema.parse(cancelled.body).status,
    );
    await owner.drain();

    const quota = quotaSchema.parse((await owner.agent.get('/api/v1/me/analysis-quota')).body);
    expect(quota).toMatchObject({ dailyLimit: 5, usedToday: 1, maxRunning: 1 });
    expect(await AnalysisRun.countDocuments()).toBe(1);
  });

  it('answers 429 with the quota when the daily limit is used up', async () => {
    const { agent, drain } = await signedIn();
    for (let i = 0; i < 5; i++) {
      const res = await agent.post(`${BASE}/analyze`).send({ force: true });
      expect(res.status).toBe(202);
      await drain();
    }
    const res = await agent.post(`${BASE}/analyze`).send({ force: true });
    expect(res.status).toBe(429);
    const body = errorResponseSchema.parse(res.body);
    expect(body.error.code).toBe('QUOTA_EXCEEDED');
    expect(body.error.details).toMatchObject({ usedToday: 5 });
  });
});
