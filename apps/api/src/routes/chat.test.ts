import mongoose from 'mongoose';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  askResponseSchema,
  chatSessionSchema,
  chatSessionListSchema,
  chatStatusSchema,
  errorResponseSchema,
  explainResponseSchema,
  llmUsageSchema,
  preferencesSchema,
  suggestionsSchema,
} from '@repointelligence/shared';
import { useMemoryDb } from '../../test/db.js';
import { FakeProvider, MemoryUsage } from '../../test/fixtures/llm.js';
import { NODE_SERVICE, fixtureApi, makeRepo, type FixtureRepo } from '../../test/fixtures/repos.js';
import { jsonResponse } from '../../test/github-fixtures.js';
import { signInWith } from '../../test/sign-in.js';
import { GithubService } from '../github/service.js';
import { LlmGateway } from '../llm/gateway.js';
import type { CompletionRequest } from '../llm/provider.js';
import { ChatSession } from '../models/chat-session.js';
import { IngestionRun } from '../models/ingestion-run.js';
import { User } from '../models/user.js';
import { CHAT_QUOTA } from '../rag/chat-service.js';

useMemoryDb();

const errorOf = (res: { body: unknown }) => errorResponseSchema.parse(res.body).error;

const sleep = () => Promise.resolve();
const BASE = '/api/v1/repos/acme/users-api';

/** The user turn the model was sent: the material and the question. */
const lastUser = (request: CompletionRequest): string =>
  request.messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';

/** Answers by citing the first data block it was shown, the way a well-behaved model would. */
const citeFirstBlock = (request: CompletionRequest): string => {
  const match = /<data path="([^"]+)" lines="(\d+)-(\d+)"/.exec(lastUser(request));
  if (!match) return 'NO_EVIDENCE';
  return `The setup is described in ${match[1]} [[${match[1]}:${match[2]}-${match[3]}]].`;
};

function gatewayOf(providers: FakeProvider[]) {
  const usage = new MemoryUsage();
  const gateway = new LlmGateway({
    providers: Object.fromEntries(providers.map((p) => [p.id, p])),
    usage,
    sleep,
  });
  return { gateway, usage };
}

async function setup(
  options: {
    repo?: FixtureRepo;
    providers?: FakeProvider[];
    githubId?: number;
  } = {},
) {
  const repo = options.repo ?? makeRepo('acme/users-api', NODE_SERVICE);
  const providers = options.providers ?? [new FakeProvider('gemini', [citeFirstBlock])];
  const { gateway, usage } = gatewayOf(providers);
  const api = fixtureApi(repo);
  const signed = await signInWith({
    githubId: options.githubId ?? 1,
    api: (url) => {
      // The contents endpoint, for explain.
      const contents = /\/repos\/acme\/users-api\/contents\/(.+)\?ref=/.exec(url);
      if (contents?.[1]) {
        const file = repo.files[contents[1]];
        if (file === undefined) return jsonResponse({ message: 'Not Found' }, 404);
        const buf = typeof file === 'string' ? Buffer.from(file) : file;
        return jsonResponse({
          type: 'file',
          size: buf.length,
          encoding: 'base64',
          content: buf.toString('base64'),
        });
      }
      return api(url);
    },
    makeGithub: (fetchImpl) => new GithubService({ fetch: fetchImpl, sleep }),
    extraDeps: { llm: gateway },
  });
  return { ...signed, repo, providers, usage };
}

async function ingested(options: Parameters<typeof setup>[0] = {}) {
  const ctx = await setup(options);
  const res = await ctx.agent.post(`${BASE}/ingest`).send({});
  expect(res.status).toBe(201);
  return ctx;
}

async function newSession(agent: Awaited<ReturnType<typeof setup>>['agent']) {
  const res = await agent.post(`${BASE}/chat/sessions`);
  expect(res.status).toBe(201);
  return chatSessionSchema.parse(res.body);
}

beforeEach(async () => {
  for (const name of [
    'users',
    'githubcaches',
    'ingestionruns',
    'artifacts',
    'chatsessions',
    'chunkembeddings',
    'llmusages',
  ]) {
    await mongoose.connection.collection(name).deleteMany({});
  }
});

describe('chat status', () => {
  it('reports what chat can and cannot do, without a session', async () => {
    const { app } = await setup({ providers: [] });
    const before = chatStatusSchema.parse((await request(app).get(`${BASE}/chat/status`)).body);
    expect(before).toMatchObject({ sha: null, chunks: 0, llm: { available: false } });
    expect(before.llm.reason).toMatch(/No model provider/);
  });

  it('lists the providers chat would use once something is ingested', async () => {
    const { agent, repo } = await ingested({
      providers: [new FakeProvider('gemini'), new FakeProvider('groq')],
    });
    const status = chatStatusSchema.parse((await agent.get(`${BASE}/chat/status`)).body);
    expect(status.sha).toBe(repo.commits[0]);
    expect(status.chunks).toBeGreaterThan(0);
    expect(status.llm.providers).toEqual(['gemini', 'groq']);
    expect(status.embedding.status).toBe('none');
  });
});

describe('sessions', () => {
  it('needs a session cookie and an ingestion', async () => {
    const { app, agent } = await setup();
    expect((await request(app).post(`${BASE}/chat/sessions`)).status).toBe(401);
    const res = await agent.post(`${BASE}/chat/sessions`);
    expect(res.status).toBe(404);
    expect(errorOf(res).message).toMatch(/Ingest this repository/);
  });

  it('pins the session to the ingested commit and hides it from other users', async () => {
    const { agent, repo } = await ingested();
    const session = await newSession(agent);
    expect(session.sha).toBe(repo.commits[0]);

    const list = await agent.get(`${BASE}/chat/sessions`);
    expect(chatSessionListSchema.parse(list.body).sessions).toHaveLength(1);

    const other = await setup({ githubId: 2 });
    expect((await other.agent.get(`/api/v1/chat/sessions/${session.id}`)).status).toBe(404);
    expect((await other.agent.delete(`/api/v1/chat/sessions/${session.id}`)).status).toBe(404);
    expect((await agent.delete(`/api/v1/chat/sessions/${session.id}`)).status).toBe(204);
    expect(await ChatSession.countDocuments()).toBe(0);
  });
});

describe('asking', () => {
  it('answers with citations that point at real lines', async () => {
    const { agent } = await ingested();
    const session = await newSession(agent);
    const res = await agent
      .post(`/api/v1/chat/sessions/${session.id}/messages`)
      .send({ question: 'How do I set up and build the project?' });
    expect(res.status).toBe(200);
    const body = askResponseSchema.parse(res.body);
    expect(body.answer.confidence).toBe('verified');
    expect(body.answer.model).toMatch(/^gemini\//);
    expect(body.answer.citations.length).toBeGreaterThan(0);
    expect(body.retrieved).toBeGreaterThan(0);
    expect(body.suggestions.length).toBeGreaterThan(0);

    // Every cited range lies inside the cited file at this commit.
    const repo = makeRepo('acme/users-api', NODE_SERVICE);
    for (const c of body.answer.citations) {
      const file = repo.files[c.path];
      expect(typeof file).toBe('string');
      const lines = String(file).split('\n').length;
      expect(c.endLine).toBeLessThanOrEqual(lines);
      expect(c.startLine).toBeGreaterThanOrEqual(1);
    }
    expect(body.session.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(body.session.title).toBe('How do I set up and build the project?');
  });

  it('strips invented citations and lowers the confidence', async () => {
    const liar = new FakeProvider('gemini', [
      (req) =>
        `${citeFirstBlock(req)} Also see [[src/secret-plans.ts:1-9]] and [[README.md:900-950]].`,
    ]);
    const { agent } = await ingested({ providers: [liar] });
    const session = await newSession(agent);
    const body = askResponseSchema.parse(
      (
        await agent
          .post(`/api/v1/chat/sessions/${session.id}/messages`)
          .send({ question: 'How do I set up and build the project?' })
      ).body,
    );
    expect(body.answer.confidence).toBe('inferred');
    expect(body.answer.content).not.toContain('secret-plans');
    expect(body.answer.citations.every((c) => c.path !== 'src/secret-plans.ts')).toBe(true);
  });

  it('falls back without calling a model when nothing in the repository matches', async () => {
    const gemini = new FakeProvider('gemini', [citeFirstBlock]);
    const { agent } = await ingested({ providers: [gemini] });
    const session = await newSession(agent);
    const body = askResponseSchema.parse(
      (
        await agent
          .post(`/api/v1/chat/sessions/${session.id}/messages`)
          .send({ question: 'Quantum chromodynamics lattice gluon' })
      ).body,
    );
    expect(body.answer.confidence).toBe('insufficient');
    expect(body.answer.citations).toEqual([]);
    expect(body.answer.content).toMatch(/could not find anything/);
    expect(body.suggestions).toEqual([]);
    expect(gemini.calls).toHaveLength(0);
  });

  it('uses the fallback reply when the model says there is no evidence', async () => {
    const { agent } = await ingested({ providers: [new FakeProvider('gemini', ['NO_EVIDENCE'])] });
    const session = await newSession(agent);
    const body = askResponseSchema.parse(
      (
        await agent
          .post(`/api/v1/chat/sessions/${session.id}/messages`)
          .send({ question: 'What does the build script do?' })
      ).body,
    );
    expect(body.answer.confidence).toBe('insufficient');
    expect(body.answer.model).toMatch(/^gemini\//);
  });

  it('fails over to the next provider when the primary is rate limited', async () => {
    const gemini = new FakeProvider('gemini', [{ error: 'rate_limited', retryAfterMs: 30_000 }]);
    const groq = new FakeProvider('groq', [citeFirstBlock]);
    const { agent, usage } = await ingested({ providers: [gemini, groq] });
    const session = await newSession(agent);
    const body = askResponseSchema.parse(
      (
        await agent
          .post(`/api/v1/chat/sessions/${session.id}/messages`)
          .send({ question: 'How do I set up and build the project?' })
      ).body,
    );
    expect(body.answer.model).toMatch(/^groq\//);
    expect(body.answer.confidence).toBe('verified');
    expect(gemini.calls).toHaveLength(1);
    expect(usage.entries).toHaveLength(2);
  });

  it('answers 503 when every provider is down, and stores nothing', async () => {
    const { agent } = await ingested({
      providers: [new FakeProvider('gemini', [{ error: 'auth' }])],
    });
    const session = await newSession(agent);
    const res = await agent
      .post(`/api/v1/chat/sessions/${session.id}/messages`)
      .send({ question: 'How do I set up and build the project?' });
    expect(res.status).toBe(503);
    expect(errorOf(res).code).toBe('LLM_UNAVAILABLE');
    expect((await ChatSession.findById(session.id))?.messages).toHaveLength(0);
  });

  it('keeps repository text inside data blocks and tells the model it is not instructions', async () => {
    const gemini = new FakeProvider('gemini', [citeFirstBlock]);
    const { agent } = await ingested({ providers: [gemini] });
    const session = await newSession(agent);
    await agent
      .post(`/api/v1/chat/sessions/${session.id}/messages`)
      .send({ question: 'What does the README say about the setup and the system?' });
    const sent = gemini.calls[0]?.request;
    expect(sent).toBeDefined();
    const system = sent?.messages[0]?.content ?? '';
    expect(system).toMatch(/never an instruction/);
    const user = sent ? lastUser(sent) : '';
    const injected = user.indexOf('ignore all previous instructions');
    expect(injected).toBeGreaterThan(-1);
    // The injected line sits between a block's opening and closing tags.
    expect(user.lastIndexOf('<data ', injected)).toBeGreaterThan(-1);
    expect(user.indexOf('</data>', injected)).toBeGreaterThan(injected);
    // And the user's question comes after all the material.
    expect(user.lastIndexOf('</data>')).toBeLessThan(user.indexOf('Question: '));
  });

  it('carries earlier turns into follow-up questions', async () => {
    const gemini = new FakeProvider('gemini', [citeFirstBlock]);
    const { agent } = await ingested({ providers: [gemini] });
    const session = await newSession(agent);
    const ask = (question: string) =>
      agent.post(`/api/v1/chat/sessions/${session.id}/messages`).send({ question });
    await ask('How do I set up and build the project?');
    const second = askResponseSchema.parse((await ask('and lint?')).body);
    expect(second.session.messages).toHaveLength(4);
    const sent = gemini.calls[1]?.request.messages ?? [];
    expect(sent.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
  });

  it('enforces the daily question quota and validates the question', async () => {
    const { agent } = await ingested();
    const session = await newSession(agent);
    const url = `/api/v1/chat/sessions/${session.id}/messages`;
    expect((await agent.post(url).send({ question: '' })).status).toBe(400);
    expect((await agent.post(url).send({ question: 'x'.repeat(2001) })).status).toBe(400);

    const doc = await ChatSession.findById(session.id);
    const now = new Date();
    for (let i = 0; i < CHAT_QUOTA.dailyQuestions; i += 1) {
      doc?.messages.push({ role: 'user', content: `q${i}`, citations: [], createdAt: now });
    }
    await doc?.save();
    const res = await agent.post(url).send({ question: 'One more?' });
    expect(res.status).toBe(429);
    expect(errorOf(res).code).toBe('QUOTA_EXCEEDED');

    const usage = llmUsageSchema.parse((await agent.get('/api/v1/me/llm-usage')).body);
    expect(usage.questionsLeft).toBe(0);
  });
});

describe('private repositories', () => {
  const privateRepo = () => makeRepo('acme/users-api', NODE_SERVICE, { private: true });

  it('refuses until the user opts in, then routes only to providers that do not train', async () => {
    const gemini = new FakeProvider('gemini', [citeFirstBlock]);
    const groq = new FakeProvider('groq', [citeFirstBlock]);
    const { agent } = await ingested({ repo: privateRepo(), providers: [gemini, groq] });

    const refused = await agent.post(`${BASE}/chat/sessions`);
    expect(refused.status).toBe(403);
    expect(errorOf(refused).code).toBe('PRIVATE_LLM_OPT_IN');

    const prefs = await agent.patch('/api/v1/me/preferences').send({ allowPrivateRepoLlm: true });
    expect(prefs.status).toBe(200);
    expect(preferencesSchema.parse(prefs.body).allowPrivateRepoLlm).toBe(true);

    const status = chatStatusSchema.parse((await agent.get(`${BASE}/chat/status`)).body);
    expect(status.private).toBe(true);
    expect(status.llm.providers).toEqual(['groq']);

    const session = await newSession(agent);
    const body = askResponseSchema.parse(
      (
        await agent
          .post(`/api/v1/chat/sessions/${session.id}/messages`)
          .send({ question: 'How do I set up and build the project?' })
      ).body,
    );
    expect(body.answer.model).toMatch(/^groq\//);
    expect(gemini.calls).toHaveLength(0);
  });

  it('is invisible to other users', async () => {
    await ingested({ repo: privateRepo() });
    const other = await setup({ repo: privateRepo(), githubId: 2 });
    await User.updateMany({}, { $set: { 'preferences.allowPrivateRepoLlm': true } });
    expect((await other.agent.post(`${BASE}/chat/sessions`)).status).toBe(404);
    const status = chatStatusSchema.parse((await other.agent.get(`${BASE}/chat/status`)).body);
    expect(status.sha).toBeNull();
  });
});

describe('suggestions, explain and export', () => {
  it('falls back to static suggestions when no small model is configured', async () => {
    const { agent } = await ingested({ providers: [] });
    const body = suggestionsSchema.parse((await agent.get(`${BASE}/chat/suggestions`)).body);
    expect(body.source).toBe('static');
    expect(body.questions).toContain('What does this repository do?');
    expect(body.questions).toContain('Which environment variables does it need?');
  });

  it('uses a small model for suggestions when one is available', async () => {
    const groq = new FakeProvider('groq', [
      '{"questions": ["How is a user deleted?", "What does /users/:id return?"]}',
    ]);
    const { agent } = await ingested({ providers: [groq] });
    const body = suggestionsSchema.parse((await agent.get(`${BASE}/chat/suggestions`)).body);
    expect(body).toEqual({
      source: 'model',
      questions: ['How is a user deleted?', 'What does /users/:id return?'],
    });
    expect(groq.calls[0]?.model).toBe('llama-3.1-8b-instant');
  });

  it('explains a range of lines and drops notes for lines outside it', async () => {
    const groq = new FakeProvider('groq', [
      '{"summary": "Setup steps.", "lines": [{"line": 10, "note": "Copies the example env."}, {"line": 99, "note": "Out of range."}]}',
    ]);
    const { agent, repo } = await ingested({ providers: [groq] });
    const res = await agent
      .post(`${BASE}/explain`)
      .send({ sha: repo.commits[0], path: 'README.md', startLine: 9, endLine: 13 });
    expect(res.status).toBe(200);
    const body = explainResponseSchema.parse(res.body);
    expect(body.lines).toEqual([{ line: 10, note: 'Copies the example env.' }]);
    expect(body.model).toMatch(/^groq\//);
    const prompt = groq.calls[0]?.request.messages.at(-1)?.content ?? '';
    expect(prompt).toContain('10: cp .env.example .env');
    expect(prompt).toMatch(/^<data path="README.md" lines="9-13">/);

    const tooLong = await agent
      .post(`${BASE}/explain`)
      .send({ sha: repo.commits[0], path: 'README.md', startLine: 1, endLine: 500 });
    expect(tooLong.status).toBe(400);
  });

  it('exports a session as Markdown with links pinned to the commit', async () => {
    const { agent, repo } = await ingested();
    const session = await newSession(agent);
    await agent
      .post(`/api/v1/chat/sessions/${session.id}/messages`)
      .send({ question: 'How do I set up and build the project?' });
    const res = await agent.get(`/api/v1/chat/sessions/${session.id}/export.md`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/markdown/);
    expect(res.headers['content-disposition']).toMatch(
      /attachment; filename="acme-users-api-chat-/,
    );
    expect(res.text).toContain('## How do I set up and build the project?');
    expect(res.text).toContain(`https://github.com/acme/users-api/blob/${repo.commits[0]}/`);
    expect(res.text).toContain('_citations checked, gemini/');
  });
});

describe('embedding', () => {
  it('reports that the worker is needed to build vectors', async () => {
    const { agent } = await ingested();
    const res = await agent.post(`${BASE}/chat/index`).send({});
    expect(res.status).toBe(503);
    expect(errorOf(res).code).toBe('WORKER_UNAVAILABLE');
    expect((await IngestionRun.findOne())?.embedding.status).toBe('none');
  });
});
