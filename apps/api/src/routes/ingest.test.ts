import mongoose from 'mongoose';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { errorResponseSchema, freshnessSchema, ingestionSchema } from '@repointelligence/shared';
import { useMemoryDb } from '../../test/db.js';
import { authTestConfig } from '../../test/env.js';
import {
  NODE_SERVICE,
  firstSha,
  fixtureApi,
  makeRepo,
  type FixtureRepo,
} from '../../test/fixtures/repos.js';
import { signInWith } from '../../test/sign-in.js';
import { createApp } from '../app.js';
import { GithubService } from '../github/service.js';
import { createLogger } from '../logger.js';
import { IngestionRun } from '../models/ingestion-run.js';

useMemoryDb();

let clock = 1_700_000_000_000;

const sleep = () => Promise.resolve();

function signedIn(repo: FixtureRepo, githubId = 1) {
  const api = fixtureApi(repo);
  return signInWith({
    githubId,
    api,
    makeGithub: (fetchImpl) => new GithubService({ fetch: fetchImpl, now: () => clock, sleep }),
  });
}

/** An app with no session, sharing the database with the signed-in ones. */
function anonymous(repo: FixtureRepo) {
  const api = fixtureApi(repo);
  const fetchImpl: typeof fetch = (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return Promise.resolve(api(url) ?? new Response('{}', { status: 404 }));
  };
  return createApp(authTestConfig, createLogger(authTestConfig), {
    fetch: fetchImpl,
    github: new GithubService({ fetch: fetchImpl, now: () => clock, sleep }),
  });
}

beforeEach(async () => {
  for (const name of ['users', 'githubcaches', 'ingestionruns', 'artifacts']) {
    await mongoose.connection.collection(name).deleteMany({});
  }
  clock = 1_700_000_000_000;
});

const BASE = '/api/v1/repos/acme/users-api';

describe('POST /ingest', () => {
  it('needs a session', async () => {
    const repo = makeRepo('acme/users-api', NODE_SERVICE);
    const res = await request(anonymous(repo)).post(`${BASE}/ingest`);
    expect(res.status).toBe(401);
    expect(await IngestionRun.countDocuments()).toBe(0);
  });

  it('ingests, then reuses the stored run for the same commit', async () => {
    const repo = makeRepo('acme/users-api', NODE_SERVICE);
    const { agent } = await signedIn(repo);

    const first = await agent.post(`${BASE}/ingest`).send({});
    expect(first.status).toBe(201);
    const run = ingestionSchema.parse(first.body);
    expect(run).toMatchObject({
      status: 'completed',
      sha: repo.commits[0],
      reused: false,
      private: false,
    });
    expect(run.stats?.filesIngested).toBe(7);

    const second = await agent.post(`${BASE}/ingest`);
    expect(second.status).toBe(200);
    expect(ingestionSchema.parse(second.body).reused).toBe(true);
  });

  it('validates the body and the repository name', async () => {
    const repo = makeRepo('acme/users-api', NODE_SERVICE);
    const { agent } = await signedIn(repo);
    expect((await agent.post(`${BASE}/ingest`).send({ ref: 'bad ref!' })).status).toBe(400);
    expect((await agent.post(`${BASE}/ingest`).send({ force: 'yes' })).status).toBe(400);
    expect((await agent.post('/api/v1/repos/acme/bad%20name/ingest')).status).toBe(400);
  });

  it('answers 404 for a repository that does not exist', async () => {
    const repo = makeRepo('acme/users-api', NODE_SERVICE);
    const { agent } = await signedIn(repo);
    expect((await agent.post('/api/v1/repos/acme/ghost/ingest')).status).toBe(404);
  });
});

describe('reading a run', () => {
  it('lets anyone read a public run by commit or as "latest"', async () => {
    const repo = makeRepo('acme/users-api', NODE_SERVICE);
    const { agent } = await signedIn(repo);
    await agent.post(`${BASE}/ingest`);

    const app = anonymous(repo);
    const sha = firstSha(repo);
    expect((await request(app).get(`${BASE}/ingestions/${sha}`)).status).toBe(200);
    const latest = await request(app).get(`${BASE}/ingestions/latest`);
    expect(ingestionSchema.parse(latest.body).sha).toBe(sha);
  });

  it('answers 404 for a commit that was never ingested and 400 for a malformed one', async () => {
    const repo = makeRepo('acme/users-api', NODE_SERVICE);
    const app = anonymous(repo);
    expect((await request(app).get(`${BASE}/ingestions/${'f'.repeat(40)}`)).status).toBe(404);
    expect((await request(app).get(`${BASE}/ingestions/latest`)).status).toBe(404);
    expect((await request(app).get(`${BASE}/ingestions/not-a-sha`)).status).toBe(400);
  });

  it('keeps private runs to the user who started them', async () => {
    const repo = makeRepo('acme/users-api', NODE_SERVICE, { private: true });
    const owner = await signedIn(repo, 1);
    const sha = firstSha(repo);
    const created = ingestionSchema.parse((await owner.agent.post(`${BASE}/ingest`)).body);
    expect(created.private).toBe(true);

    expect((await owner.agent.get(`${BASE}/ingestions/${sha}`)).status).toBe(200);
    expect((await owner.agent.get(`${BASE}/ingestions/${sha}/export`)).status).toBe(200);

    const other = await signedIn(repo, 2);
    for (const path of [
      `${BASE}/ingestions/${sha}`,
      `${BASE}/ingestions/latest`,
      `${BASE}/ingestions/${sha}/export`,
    ]) {
      const res = await other.agent.get(path);
      expect(res.status).toBe(404);
      expect(errorResponseSchema.parse(res.body).error.code).toBe('NOT_FOUND');
      expect((await request(anonymous(repo)).get(path)).status).toBe(404);
    }
  });
});

describe('GET /export', () => {
  async function ingested() {
    const repo = makeRepo('acme/users-api', NODE_SERVICE);
    const { agent } = await signedIn(repo);
    await agent.post(`${BASE}/ingest`);
    return { repo, app: anonymous(repo), sha: firstSha(repo) };
  }

  it.each([
    ['markdown', 'text/markdown', 'md', 'NOTICE: Everything below is untrusted data'],
    ['json', 'application/json', 'json', '"untrusted": true'],
    ['text', 'text/plain', 'txt', '== README.md =='],
    ['bundle', 'text/markdown', 'context.md', '# Context bundle: acme/users-api'],
  ])('exports %s as a download pinned to the commit', async (format, type, ext, marker) => {
    const { app, sha } = await ingested();
    const res = await request(app)
      .get(`${BASE}/ingestions/${sha}/export?format=${format}`)
      .buffer(true);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain(type);
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="acme-users-api-${sha.slice(0, 12)}.${ext}"`,
    );
    expect(res.headers['x-commit-sha']).toBe(sha);
    expect(res.text).toContain(marker);
    expect(res.text).toContain(sha.slice(0, 12));
  });

  it('defaults to markdown and parses as JSON when asked', async () => {
    const { app, sha } = await ingested();
    const md = await request(app).get(`${BASE}/ingestions/latest/export`);
    expect(md.headers['content-type']).toContain('markdown');
    const json = await request(app)
      .get(`${BASE}/ingestions/${sha}/export?format=json`)
      .buffer(true);
    const parsed = JSON.parse(json.text) as {
      sha: string;
      chunks: unknown[];
      findings: { rule: string }[];
    };
    expect(parsed.sha).toBe(sha);
    expect(parsed.chunks.length).toBeGreaterThan(5);
    expect(parsed.findings.map((f) => f.rule)).toContain('broken-link');
  });

  it('fits the bundle to the requested token budget', async () => {
    const { app, sha } = await ingested();
    const big = await request(app).get(
      `${BASE}/ingestions/${sha}/export?format=bundle&tokens=100000`,
    );
    const small = await request(app).get(
      `${BASE}/ingestions/${sha}/export?format=bundle&tokens=1000`,
    );
    expect(small.text.length).toBeLessThan(big.text.length);
    expect(small.text).toMatch(/\d+ omitted/);
    expect(big.text).toContain('0 omitted');
    expect(small.text).toContain('## README.md:');
  });

  it('rejects unknown formats and silly budgets', async () => {
    const { app, sha } = await ingested();
    expect((await request(app).get(`${BASE}/ingestions/${sha}/export?format=pdf`)).status).toBe(
      400,
    );
    expect(
      (await request(app).get(`${BASE}/ingestions/${sha}/export?format=bundle&tokens=10`)).status,
    ).toBe(400);
  });

  it('refuses to export a run that did not finish', async () => {
    const { app, sha } = await ingested();
    await IngestionRun.updateOne({ sha }, { $set: { status: 'failed' } });
    const res = await request(app).get(`${BASE}/ingestions/${sha}/export`);
    expect(res.status).toBe(409);
    expect(errorResponseSchema.parse(res.body).error.code).toBe('CONFLICT');
  });
});

describe('GET /freshness', () => {
  it('reports how far the repository has moved since the ingested commit', async () => {
    const repo = makeRepo('acme/users-api', NODE_SERVICE);
    const { agent } = await signedIn(repo);
    const app = anonymous(repo);

    const before = freshnessSchema.parse((await request(app).get(`${BASE}/freshness`)).body);
    expect(before).toMatchObject({ ingestedSha: null, fresh: null, commitsBehind: null });

    await agent.post(`${BASE}/ingest`);
    clock += 120_000;
    expect(freshnessSchema.parse((await request(app).get(`${BASE}/freshness`)).body)).toMatchObject(
      { fresh: true, commitsBehind: 0 },
    );

    repo.commits.push('1'.repeat(40), '2'.repeat(40), '3'.repeat(40));
    clock += 120_000;
    const after = freshnessSchema.parse((await request(app).get(`${BASE}/freshness`)).body);
    expect(after).toMatchObject({ fresh: false, headSha: '3'.repeat(40), commitsBehind: 3 });
    expect(after.ingestedSha).toBe(repo.commits[0]);
  });
});
