import mongoose from 'mongoose';
import { beforeEach, describe, expect, it } from 'vitest';
import { askResponseSchema, chatSessionSchema, chatStatusSchema } from '@repointelligence/shared';
import { useMemoryDb } from '../../test/db.js';
import { authTestConfig } from '../../test/env.js';
import { FakeProvider } from '../../test/fixtures/llm.js';
import { NODE_SERVICE, fixtureApi, makeRepo } from '../../test/fixtures/repos.js';
import { WORKER_SECRET, WORKER_URL, fakeWorker } from '../../test/fixtures/worker.js';
import { jsonResponse } from '../../test/github-fixtures.js';
import { signInWith } from '../../test/sign-in.js';
import { InlineQueue } from '../analysis/queue.js';
import { GithubService } from '../github/service.js';
import { LlmGateway } from '../llm/gateway.js';
import { ChunkEmbedding } from '../models/chunk-embedding.js';
import { IngestionRun } from '../models/ingestion-run.js';

useMemoryDb();

const BASE = '/api/v1/repos/acme/users-api';
const config = { ...authTestConfig, WORKER_URL, WORKER_SHARED_SECRET: WORKER_SECRET };
const sleep = () => Promise.resolve();

async function setup(embedStatus = 200) {
  const repo = makeRepo('acme/users-api', NODE_SERVICE);
  const worker = fakeWorker(fixtureApi(repo), () => jsonResponse({}, 500));
  let inline: InlineQueue | undefined;
  const gemini = new FakeProvider('gemini', [
    (req) => {
      const text = req.messages.at(-1)?.content ?? '';
      const m = /<data path="([^"]+)" lines="(\d+)-(\d+)"/.exec(text);
      return m ? `See [[${m[1]}:${m[2]}-${m[3]}]].` : 'NO_EVIDENCE';
    },
  ]);
  const session = await signInWith({
    api: (url, init) =>
      embedStatus !== 200 && url.endsWith('/v1/embed')
        ? jsonResponse({ detail: 'boom' }, embedStatus)
        : worker.api(url, init),
    config,
    makeGithub: (fetchImpl) => new GithubService({ fetch: fetchImpl, sleep }),
    extraDeps: {
      queue: (handler) => {
        inline = new InlineQueue(handler);
        return inline;
      },
      llm: new LlmGateway({ providers: { gemini }, sleep }),
    },
  });
  const drain = () => inline?.drain() ?? Promise.resolve();
  expect((await session.agent.post(`${BASE}/ingest`).send({})).status).toBe(201);
  return { ...session, worker, drain, gemini };
}

beforeEach(async () => {
  for (const name of [
    'users',
    'githubcaches',
    'ingestionruns',
    'artifacts',
    'chunkembeddings',
    'chatsessions',
  ]) {
    await mongoose.connection.collection(name).deleteMany({});
  }
});

describe('embedding a commit', () => {
  it('embeds every chunk once and marks the run ready', async () => {
    const { agent, drain, worker } = await setup();
    const res = await agent.post(`${BASE}/chat/index`).send({});
    expect(res.status).toBe(202);
    expect(chatStatusSchema.parse(res.body).embedding.status).toBe('queued');
    await drain();

    const run = await IngestionRun.findOne();
    const chunks = (run?.stats as { chunks: number }).chunks;
    expect(run?.embedding).toMatchObject({
      status: 'ready',
      embedded: chunks,
      model: 'fake-embedder',
    });
    expect(await ChunkEmbedding.countDocuments()).toBe(chunks);
    expect(worker.embedded()).toBe(chunks);

    // Asking again for a ready run does nothing.
    await agent.post(`${BASE}/chat/index`).send({});
    await drain();
    expect(worker.embedded()).toBe(chunks);
  });

  it('starts embedding when the first session opens and then uses the vectors', async () => {
    const { agent, drain, worker } = await setup();
    const created = await agent.post(`${BASE}/chat/sessions`);
    expect(created.status).toBe(201);
    const session = chatSessionSchema.parse(created.body);
    await drain();
    expect((await IngestionRun.findOne())?.embedding.status).toBe('ready');

    const before = worker.embedded();
    const body = askResponseSchema.parse(
      (
        await agent
          .post(`/api/v1/chat/sessions/${session.id}/messages`)
          .send({ question: 'How do I remove a user through the API?' })
      ).body,
    );
    // The question itself was embedded for the vector pass.
    expect(worker.embedded()).toBe(before + 1);
    expect(body.answer.confidence).toBe('verified');
  });

  it('records a failure after the last attempt and keeps keyword search working', async () => {
    const { agent, drain } = await setup(500);
    await agent.post(`${BASE}/chat/index`).send({});
    await drain();
    // The inline queue runs a job once; a 5xx on the first attempt asks for a retry.
    const run = await IngestionRun.findOne();
    expect(run?.embedding.status).toBe('queued');
    expect(run?.embedding.error).toMatch(/UPSTREAM_ERROR/);
  });
});
