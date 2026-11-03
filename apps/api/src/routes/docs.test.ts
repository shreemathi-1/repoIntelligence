import mongoose from 'mongoose';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DOC_KINDS,
  docDriftSchema,
  docPullRequestSchema,
  docQuotaSchema,
  docReviewSchema,
  errorResponseSchema,
  generatedDocSchema,
  missingDocsSchema,
} from '@repointelligence/shared';
import { useMemoryDb } from '../../test/db.js';
import { ORDERS_SERVICE } from '../../test/fixtures/docs.js';
import { fixtureGraph } from '../../test/fixtures/graph.js';
import { FakeProvider } from '../../test/fixtures/llm.js';
import { commitSha, fixtureApi, makeRepo, type FixtureRepo } from '../../test/fixtures/repos.js';
import { jsonResponse, rawRepo } from '../../test/github-fixtures.js';
import { signInWith } from '../../test/sign-in.js';
import { GithubService } from '../github/service.js';
import { LlmGateway } from '../llm/gateway.js';
import type { CompletionRequest } from '../llm/provider.js';
import { ArchitectureGraphModel } from '../models/architecture-graph.js';
import { DocPullRequest } from '../models/doc-pull-request.js';
import { GeneratedDoc } from '../models/generated-doc.js';
import { User } from '../models/user.js';
import { DOC_QUOTA } from '../docs/service.js';

useMemoryDb();

const sleep = () => Promise.resolve();
const BASE = '/api/v1/repos/acme/orders';
const errorOf = (res: { body: unknown }) => errorResponseSchema.parse(res.body).error;

/** Writes prose for each requested section, citing the first data block shown for it. */
function writer(extra: (id: string) => string = () => ''): (req: CompletionRequest) => string {
  return (req) => {
    const prompt = req.messages.at(-1)?.content ?? '';
    const parts = prompt.split(/^### Section "/m).slice(1);
    const sections = parts.map((part) => {
      const id = part.slice(0, part.indexOf('"'));
      const block = /<data path="([^"]+)" lines="(\d+)-(\d+)"/.exec(part);
      const text = block
        ? `This part is defined in ${block[1]} [[${block[1]}:${block[2]}-${block[3]}]].${extra(id)}`
        : `Highlights for users.${extra(id)}`;
      return { id, text };
    });
    return JSON.stringify({ sections });
  };
}

interface Writes {
  calls: { method: string; path: string; body: unknown }[];
}

/** GitHub for the fixture: reads, contents, tags and compare, and the write endpoints. */
function github(repo: FixtureRepo, options: { push?: boolean; existingBranches?: string[]; compare?: unknown } = {}) {
  const base = fixtureApi(repo);
  const writes: Writes = { calls: [] };
  const api = (url: string, init?: RequestInit): Response | undefined => {
    const { pathname, searchParams } = new URL(url);
    const method = init?.method ?? 'GET';
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const prefix = `/repos/${repo.fullName}`;
    if (method !== 'GET') writes.calls.push({ method, path: pathname, body });
    if (pathname === prefix && method === 'GET') {
      return jsonResponse(rawRepo({ full_name: repo.fullName, private: repo.private, default_branch: 'main', html_url: `https://github.com/${repo.fullName}`, description: 'Orders service', permissions: { push: options.push ?? true } }));
    }
    const contents = new RegExp(`^${prefix}/contents/(.+)$`).exec(pathname);
    if (contents?.[1] && searchParams.get('ref')) {
      const file = repo.files[contents[1]];
      if (file === undefined) return jsonResponse({ message: 'Not Found' }, 404);
      const buf = typeof file === 'string' ? Buffer.from(file) : file;
      return jsonResponse({ type: 'file', size: buf.length, encoding: 'base64', content: buf.toString('base64') });
    }
    if (pathname === `${prefix}/tags`) return jsonResponse([{ name: 'v1.0.0', commit: { sha: 'f'.repeat(40) } }]);
    if (pathname.startsWith(`${prefix}/compare/`) && options.compare) return jsonResponse(options.compare);
    const ref = new RegExp(`^${prefix}/git/ref/heads/(.+)$`).exec(pathname);
    if (ref?.[1]) {
      const name = decodeURIComponent(ref[1]);
      if (name === 'main' || options.existingBranches?.includes(name)) return jsonResponse({ object: { sha: 'b'.repeat(40) } });
      return jsonResponse({ message: 'Not Found' }, 404);
    }
    if (pathname === `${prefix}/git/commits/${'b'.repeat(40)}`) return jsonResponse({ sha: 'b'.repeat(40), tree: { sha: 't'.repeat(40) } });
    if (pathname === `${prefix}/git/trees` && method === 'POST') return jsonResponse({ sha: 'n'.repeat(40) }, 201);
    if (pathname === `${prefix}/git/commits` && method === 'POST') return jsonResponse({ sha: 'c'.repeat(40) }, 201);
    if (pathname === `${prefix}/git/refs` && method === 'POST') return jsonResponse({ ref: 'refs/heads/x', object: { sha: 'c'.repeat(40) } }, 201);
    if (pathname === `${prefix}/pulls` && method === 'POST') return jsonResponse({ number: 7, html_url: `https://github.com/${repo.fullName}/pull/7`, draft: true }, 201);
    return base(url);
  };
  return { api, writes };
} // prettier-ignore

async function setup(
  options: {
    repo?: FixtureRepo;
    providers?: FakeProvider[];
    githubId?: number;
    push?: boolean;
    existingBranches?: string[];
    compare?: unknown;
    graph?: boolean;
  } = {},
) {
  const repo = options.repo ?? makeRepo('acme/orders', ORDERS_SERVICE);
  const providers = options.providers ?? [new FakeProvider('groq', [writer()])];
  const gateway = new LlmGateway({ providers: Object.fromEntries(providers.map((p) => [p.id, p])), sleep });
  const gh = github(repo, options);
  const signed = await signInWith({
    githubId: options.githubId ?? 1,
    api: gh.api,
    makeGithub: (fetchImpl) => new GithubService({ fetch: fetchImpl, sleep }),
    extraDeps: { llm: gateway },
  });
  return { ...signed, repo, providers, writes: gh.writes };
} // prettier-ignore

async function ingested(options: Parameters<typeof setup>[0] = {}) {
  const ctx = await setup(options);
  const res = await ctx.agent.post(`${BASE}/ingest`).send({});
  expect(res.status).toBe(201);
  if (options.graph !== false) {
    await ArchitectureGraphModel.create({
      fullName: 'acme/orders',
      sha: ctx.repo.commits.at(-1),
      graph: fixtureGraph(),
      computedAt: new Date(),
    });
  }
  return ctx;
}

async function generate(agent: Awaited<ReturnType<typeof setup>>['agent'], kind: string, extra: Record<string, unknown> = {}) {
  const res = await agent.post(`${BASE}/docs`).send({ kind, ...extra });
  expect([200, 201], `${kind}: ${JSON.stringify(res.body)}`).toContain(res.status);
  return generatedDocSchema.parse(res.body);
} // prettier-ignore

/** Every citation in a document points at lines that exist in the fixture file. */
function expectRealCitations(repo: FixtureRepo, citations: { path: string; startLine: number; endLine: number }[]) {
  expect(citations.length).toBeGreaterThan(0);
  for (const c of citations) {
    const file = repo.files[c.path];
    expect(file, c.path).toBeDefined();
    expect(c.endLine).toBeLessThanOrEqual(String(file).split('\n').length);
    expect(c.startLine).toBeGreaterThanOrEqual(1);
  }
} // prettier-ignore

beforeEach(async () => {
  for (const name of ['users', 'githubcaches', 'ingestionruns', 'artifacts', 'architecturegraphs', 'generateddocs', 'docpullrequests']) {
    await mongoose.connection.collection(name).deleteMany({});
  }
}); // prettier-ignore

describe('generating documentation', () => {
  it('needs a session and an ingestion', async () => {
    const { app, agent } = await setup();
    expect((await request(app).post(`${BASE}/docs`).send({ kind: 'api' })).status).toBe(401);
    const res = await agent.post(`${BASE}/docs`).send({ kind: 'api' });
    expect(res.status).toBe(404);
    expect((await agent.post(`${BASE}/docs`).send({ kind: 'novel' })).status).toBe(400);
  });

  it('writes an API reference whose citations point at real lines, and reuses it', async () => {
    const { agent, repo, providers } = await ingested();
    const doc = await generate(agent, 'api');
    expect(doc).toMatchObject({ kind: 'api', origin: 'prose', targetPath: 'docs/API.md', droppedCitations: 0 });
    expect(doc.model).toMatch(/^groq\//);
    expect(doc.content).toMatch(/^# API reference/);
    expect(doc.content).toContain('| GET | `/orders` |');
    expect(doc.content).toContain('[[src/routes/orders.ts:5-5]]');
    expectRealCitations(repo, doc.citations);

    const again = await agent.post(`${BASE}/docs`).send({ kind: 'api' });
    expect(again.status).toBe(200);
    expect(providers[0]?.calls).toHaveLength(1);
    expect((await agent.post(`${BASE}/docs`).send({ kind: 'api', force: true })).status).toBe(201);
    expect(providers[0]?.calls).toHaveLength(2);
  }); // prettier-ignore

  it('removes citations the model invented', async () => {
    const liar = new FakeProvider('groq', [writer(() => ' Also see [[src/secret.ts:1-9]].')]);
    const { agent } = await ingested({ providers: [liar] });
    const doc = await generate(agent, 'database');
    expect(doc.droppedCitations).toBeGreaterThan(0);
    expect(doc.content).not.toContain('src/secret.ts');
    expect(doc.content).toContain('```mermaid');
  });

  it('falls back to facts only when no model is configured', async () => {
    const { agent, repo } = await ingested({ providers: [] });
    const doc = await generate(agent, 'env');
    expect(doc.origin).toBe('facts');
    expect(doc.model).toBeNull();
    expect(doc.notes.join(' ')).toMatch(/no model provider/);
    expect(doc.content).toContain('`JWT_SECRET`');
    expect(doc.content).toMatch(
      /\| `MONGODB_URI` \| MongoDB connection string \| yes \| \[\[\.env\.example:4-4\]\]/,
    );
    expectRealCitations(repo, doc.citations);
  });

  it('generates every kind from facts', async () => {
    const { agent } = await ingested({ providers: [] });
    const yesterday = new Date(Date.now() - 86_400_000);
    for (const kind of DOC_KINDS) {
      // Age earlier documents so twelve kinds fit under the daily quota.
      await GeneratedDoc.updateMany({}, { $set: { generatedAt: yesterday } });
      const doc = await generate(agent, kind);
      expect(doc.content, kind).toMatch(/^# /);
      expect(doc.sections.length, kind).toBeGreaterThan(0);
    }
    const setup = await GeneratedDoc.findOne({ kind: 'setup' });
    expect(setup?.content).toContain('`npm ci`');
    expect(setup?.content).toContain('node >=22');
    const deploy = await GeneratedDoc.findOne({ kind: 'deployment' });
    expect(deploy?.content).toContain('`EXPOSE 4000` [[Dockerfile:5-5]]');
    const sequence = await GeneratedDoc.findOne({ kind: 'sequence' });
    expect(sequence?.content).toContain('sequenceDiagram');
    expect(sequence?.content).toContain('client->>');
    const contributing = await GeneratedDoc.findOne({ kind: 'contributing' });
    expect(contributing?.content).toContain('`.github/workflows/ci.yml`');
  });

  it('says what is missing instead of inventing it when the architecture is not mapped', async () => {
    const { agent } = await ingested({ providers: [], graph: false });
    const doc = await generate(agent, 'database');
    expect(doc.sections[0]?.missing).toMatch(/map the architecture/);
    expect(doc.content).toContain('_Not found in the repository:');
  });

  it('groups the changelog by commit type and leaves out chores', async () => {
    const commits = [
      { sha: '1'.repeat(40), commit: { message: 'feat(api): add order search (#12)' } },
      { sha: '2'.repeat(40), commit: { message: 'fix: handle empty carts' } },
      { sha: '3'.repeat(40), commit: { message: 'chore(deps): bump express' } },
      { sha: '4'.repeat(40), commit: { message: 'feat!: drop the v1 routes' } },
      { sha: '5'.repeat(40), commit: { message: 'Tidy up the readme' } },
    ];
    const prose = writer();
    const model = new FakeProvider('groq', [
      (req) =>
        req.messages[0]?.content.includes('Classify commit messages')
          ? '{"items": [{"index": 0, "group": "docs"}]}'
          : prose(req),
    ]);
    const { agent } = await ingested({
      providers: [model],
      compare: { commits, total_commits: 5 },
    });
    const doc = await generate(agent, 'changelog');
    expect(doc.content).toContain('### Breaking changes');
    expect(doc.content).toContain('- **api:** add order search ([1111111](https://github.com/acme/orders/commit/');
    expect(doc.content).toContain('[#12](https://github.com/acme/orders/pull/12)');
    expect(doc.content).toContain('### Fixed');
    expect(doc.content).toContain('### Documentation\n\n- Tidy up the readme');
    expect(doc.content).not.toContain('bump express');
    expect(doc.content).toContain('Unreleased (v1.0.0');
  }); // prettier-ignore

  it('enforces the daily generation quota', async () => {
    const { agent } = await ingested({ providers: [] });
    const user = await User.findOne();
    const now = new Date();
    await GeneratedDoc.insertMany(
      Array.from({ length: DOC_QUOTA.dailyGenerations }, (_, i) => ({
        fullName: 'acme/other', sha: `${i}`.padStart(40, '0'), kind: 'readme', createdBy: user?._id, title: 't', targetPath: 'README.md', content: '# t', origin: 'facts', generatedAt: now,
      })),
    );
    const res = await agent.post(`${BASE}/docs`).send({ kind: 'api' });
    expect(res.status).toBe(429);
    expect(errorOf(res).code).toBe('QUOTA_EXCEEDED');
    expect(docQuotaSchema.parse((await agent.get('/api/v1/me/docs-quota')).body)).toMatchObject({ usedToday: DOC_QUOTA.dailyGenerations, canProposePullRequests: false });
  }); // prettier-ignore
});

describe('private repositories', () => {
  it('writes facts only, and calls no model, until the user opts in', async () => {
    const model = new FakeProvider('groq', [writer()]);
    const repo = makeRepo('acme/orders', ORDERS_SERVICE, { private: true });
    const { agent } = await ingested({ repo, providers: [model] });
    const doc = await generate(agent, 'api');
    expect(doc.origin).toBe('facts');
    expect(doc.notes.join(' ')).toMatch(/private repositories are off/);
    expect(model.calls).toHaveLength(0);

    await agent.patch('/api/v1/me/preferences').send({ allowPrivateRepoLlm: true });
    const again = await generate(agent, 'api', { force: true });
    expect(again.origin).toBe('prose');
    expect(model.calls).toHaveLength(1);
  });
});

describe('editing, export and review', () => {
  it('keeps documents private to their author', async () => {
    const { agent } = await ingested({ providers: [] });
    const doc = await generate(agent, 'readme');
    const other = await setup({ githubId: 2, providers: [] });
    expect((await other.agent.get(`/api/v1/docs/${doc.id}`)).status).toBe(404);
    expect(
      (await other.agent.patch(`/api/v1/docs/${doc.id}`).send({ content: '# x' })).status,
    ).toBe(404);
  });

  it('saves edits and recomputes the citations', async () => {
    const { agent } = await ingested({ providers: [] });
    const doc = await generate(agent, 'readme');
    const res = await agent.patch(`/api/v1/docs/${doc.id}`).send({ content: '# Orders\n\nStarts in [[src/index.ts:1-7]].\n', title: 'Orders' });
    expect(res.status).toBe(200);
    const edited = generatedDocSchema.parse(res.body);
    expect(edited).toMatchObject({ origin: 'edited', title: 'Orders', citations: [{ path: 'src/index.ts', startLine: 1, endLine: 7 }] });
    expect(edited.editedAt).not.toBeNull();
    expect((await agent.patch(`/api/v1/docs/${doc.id}`).send({ content: '' })).status).toBe(400);
  }); // prettier-ignore

  it('exports Markdown with links pinned to the commit or relative to the target file', async () => {
    const { agent, repo } = await ingested({ providers: [] });
    const doc = await generate(agent, 'api');
    const sha = repo.commits.at(-1) ?? '';
    const pinned = await agent.get(`/api/v1/docs/${doc.id}/export`);
    expect(pinned.headers['content-disposition']).toBe('attachment; filename="API.md"');
    expect(pinned.text).toContain(`([src/routes/orders.ts:5](https://github.com/acme/orders/blob/${sha}/src/routes/orders.ts#L5))`);
    expect(pinned.text).not.toContain('[[');
    const relative = await agent.get(`/api/v1/docs/${doc.id}/export?links=relative`);
    expect(relative.text).toContain('([src/routes/orders.ts:5](../src/routes/orders.ts#L5))');
  }); // prettier-ignore

  it('exports HTML without running markup from the document', async () => {
    const { agent } = await ingested({ providers: [] });
    const doc = await generate(agent, 'readme');
    await agent.patch(`/api/v1/docs/${doc.id}`).send({ content: '# T\n\n<script>alert(1)</script>\n\n[bad](javascript:alert(1)) [ok](https://example.com)\n' });
    const res = await agent.get(`/api/v1/docs/${doc.id}/export?format=html`);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).not.toContain('<script>alert');
    expect(res.text).toContain('&lt;script&gt;');
    expect(res.text).not.toContain('href="javascript');
    expect(res.text).toContain('<a href="https://example.com" rel="noreferrer">ok</a>');
  }); // prettier-ignore

  it('reviews a document with rule checks when no model is available', async () => {
    const { agent } = await ingested({ providers: [] });
    const doc = await generate(agent, 'readme');
    await agent.patch(`/api/v1/docs/${doc.id}`).send({ content: '# T\n\nRun `npm run deploy` first. TODO: more.\n\nSee [[src/ghost.ts:1-2]].\n' });
    const review = docReviewSchema.parse((await agent.post(`/api/v1/docs/${doc.id}/review`)).body);
    const rules = review.issues.map((i) => i.rule);
    expect(rules).toEqual(expect.arrayContaining(['unknown-script', 'placeholder', 'unknown-citation']));
    expect(review.model).toBeNull();
    expect(review.score).toBeLessThan(80);
  }); // prettier-ignore

  it('adds model scores to the review when a model is available', async () => {
    const reviewer = new FakeProvider('groq', ['{"accuracy": 4, "completeness": 3, "clarity": 5, "summary": "Clear.", "issues": [{"message": "Add an example", "line": 3}]}']);
    const { agent } = await ingested({ providers: [reviewer] });
    const doc = await GeneratedDoc.create({ fullName: 'acme/orders', sha: commitSha('acme/orders:1'), kind: 'readme', createdBy: (await User.findOne())?._id, title: 'T', targetPath: 'README.md', content: '# T\n\nStarts in [[src/index.ts:1-7]].\n', origin: 'edited', generatedAt: new Date() });
    const review = docReviewSchema.parse((await agent.post(`/api/v1/docs/${doc.id}/review`)).body);
    expect(review.scores).toEqual({ accuracy: 4, completeness: 3, clarity: 5 });
    expect(review.score).toBe(80);
    expect(review.issues).toContainEqual({ rule: 'review', severity: 'info', message: 'Add an example', line: 3, source: 'model' });
  }); // prettier-ignore
});

describe('drift and missing documentation', () => {
  it('flags sections whose cited files changed in a newer ingested commit', async () => {
    const first = commitSha('orders:1');
    const second = commitSha('orders:2');
    const repo = makeRepo('acme/orders', ORDERS_SERVICE, { commits: [first, second] });
    const compare = { ahead_by: 3, files: [{ filename: 'src/routes/orders.ts' }, { filename: 'unrelated.md' }] };
    const ctx = await setup({ repo, providers: [], compare });
    expect((await ctx.agent.post(`${BASE}/ingest`).send({ ref: first })).status).toBe(201);
    await ArchitectureGraphModel.create({ fullName: 'acme/orders', sha: first, graph: fixtureGraph(), computedAt: new Date() });
    const doc = await generate(ctx.agent, 'api');

    const current = docDriftSchema.parse((await ctx.agent.get(`/api/v1/docs/${doc.id}/drift`)).body);
    expect(current.status).toBe('current');

    expect((await ctx.agent.post(`${BASE}/ingest`).send({})).status).toBe(201);
    const drift = docDriftSchema.parse((await ctx.agent.get(`/api/v1/docs/${doc.id}/drift`)).body);
    expect(drift).toMatchObject({ status: 'drifted', latestSha: second, commitsBehind: 3, changedFiles: ['src/routes/orders.ts'] });
    expect(drift.sections.map((s) => s.heading)).toContain('Endpoints');
  }); // prettier-ignore

  it('lists missing documents, undocumented routes and symbols', async () => {
    const { app } = await ingested({ providers: [] });
    const body = missingDocsSchema.parse((await request(app).get(`${BASE}/docs/missing`)).body);
    const labels = body.items.map((i) => i.label);
    expect(labels).toContain('No CONTRIBUTING file');
    expect(labels).toContain('GET /orders is not documented');
    expect(body.items.find((i) => i.label === 'No CONTRIBUTING file')?.suggest).toBe('contributing');
    expect(body.items.some((i) => i.kind === 'symbol' && i.suggest === 'docstrings')).toBe(true);
    expect(body.symbolCoverage).not.toBeNull();
  }); // prettier-ignore
});

describe('documentation pull requests', () => {
  const grant = () => User.updateMany({}, { $set: { tokenScopes: ['read:user', 'public_repo'] } });

  it('needs the write scope and an exact confirmation of the files', async () => {
    const { agent, writes } = await ingested({ providers: [] });
    const doc = await generate(agent, 'api');
    const url = '/api/v1/docs/pull-requests';
    const denied = await agent.post(url).send({ docIds: [doc.id], confirmPaths: ['docs/API.md'] });
    expect(denied.status).toBe(403);
    expect(errorOf(denied).code).toBe('DOCS_WRITE_SCOPE');

    await grant();
    const mismatch = await agent.post(url).send({ docIds: [doc.id], confirmPaths: ['README.md'] });
    expect(mismatch.status).toBe(400);
    expect(writes.calls).toEqual([]);
  });

  it('opens a draft pull request on a new branch in one commit', async () => {
    const { agent, writes } = await ingested({ providers: [], existingBranches: [] });
    const api = await generate(agent, 'api');
    const env = await generate(agent, 'env');
    await grant();
    const res = await agent.post('/api/v1/docs/pull-requests').send({ docIds: [api.id, env.id], confirmPaths: ['docs/CONFIGURATION.md', 'docs/API.md'] });
    expect(res.status).toBe(201);
    const pr = docPullRequestSchema.parse(res.body);
    expect(pr).toMatchObject({ number: 7, draft: true, base: 'main', files: ['docs/API.md', 'docs/CONFIGURATION.md'] });
    expect(pr.branch).toMatch(/^repointelligence\/docs-[0-9a-f]{7}$/);

    expect(writes.calls.map((c) => `${c.method} ${c.path.replace('/repos/acme/orders', '')}`)).toEqual(['POST /git/trees', 'POST /git/commits', 'POST /git/refs', 'POST /pulls']);
    const tree = writes.calls[0]?.body as { tree: { path: string; content: string }[] };
    expect(tree.tree.map((t) => t.path).sort()).toEqual(['docs/API.md', 'docs/CONFIGURATION.md']);
    expect(tree.tree.find((t) => t.path === 'docs/API.md')?.content).toContain('(../src/routes/orders.ts#L5)');
    const refs = writes.calls[2]?.body as { ref: string };
    expect(refs.ref).toBe(`refs/heads/${pr.branch}`);
    const pull = writes.calls[3]?.body as { draft: boolean; base: string };
    expect(pull).toMatchObject({ draft: true, base: 'main' });
    expect(await DocPullRequest.countDocuments()).toBe(1);
  }); // prettier-ignore

  it('picks a free branch name and refuses repositories the user cannot push to', async () => {
    const taken = await ingested({ providers: [], existingBranches: [`repointelligence/docs-${commitSha('acme/orders:1').slice(0, 7)}`] });
    const doc = await generate(taken.agent, 'readme');
    await grant();
    const ok = docPullRequestSchema.parse((await taken.agent.post('/api/v1/docs/pull-requests').send({ docIds: [doc.id], confirmPaths: ['README.md'] })).body);
    expect(ok.branch).toMatch(/-2$/);

    await mongoose.connection.collection('users').deleteMany({});
    const readonly = await setup({ providers: [], push: false, githubId: 3 });
    const mine = await GeneratedDoc.create({ fullName: 'acme/orders', sha: commitSha('acme/orders:1'), kind: 'readme', createdBy: (await User.findOne())?._id, title: 'T', targetPath: 'README.md', content: '# T\n', origin: 'facts', generatedAt: new Date() });
    await grant();
    const res = await readonly.agent.post('/api/v1/docs/pull-requests').send({ docIds: [mine.id], confirmPaths: ['README.md'] });
    expect(res.status).toBe(403);
    expect(errorOf(res).code).toBe('NO_WRITE_ACCESS');
    expect(readonly.writes.calls).toEqual([]);
  }); // prettier-ignore
});
