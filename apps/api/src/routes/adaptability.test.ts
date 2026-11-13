import mongoose from 'mongoose';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_STACK_PROFILES,
  adaptabilityReportSchema,
  alternativesSchema,
  docQuotaSchema,
  errorResponseSchema,
  parsedManifestSchema,
  stackProfileListSchema,
  stackProfileSchema,
} from '@repointelligence/shared';
import { useMemoryDb } from '../../test/db.js';
import { ORDERS_SERVICE } from '../../test/fixtures/docs.js';
import { fixtureGraph } from '../../test/fixtures/graph.js';
import { FakeProvider } from '../../test/fixtures/llm.js';
import { fixtureApi, makeRepo } from '../../test/fixtures/repos.js';
import { jsonResponse, rawRepo } from '../../test/github-fixtures.js';
import { signInWith } from '../../test/sign-in.js';
import { DOC_QUOTA } from '../docs/quota.js';
import { GithubService } from '../github/service.js';
import { LlmGateway } from '../llm/gateway.js';
import { AdaptabilityReport } from '../models/adaptability-report.js';
import { ArchitectureGraphModel } from '../models/architecture-graph.js';
import { ReleaseSummary } from '../models/release-summary.js';
import { User } from '../models/user.js';

useMemoryDb();

beforeEach(async () => {
  for (const collection of Object.values(mongoose.connection.collections)) {
    await collection.deleteMany({});
  }
});

const sleep = () => Promise.resolve();
const BASE = '/api/v1/repos/acme/orders';
const errorOf = (res: { body: unknown }) => errorResponseSchema.parse(res.body).error;
const EXPLANATION = 'The license and database fit; the runtime is the gap.';

const MATCHING = {
  name: 'Node API',
  runtimes: { node: '22.11' },
  frameworks: [{ name: 'Express', version: '5.1' }],
  databases: [{ engine: 'mongodb' }],
  auth: 'jwt',
  deployment: 'container',
};
const DIFFERENT = {
  name: 'Django monolith',
  runtimes: { python: '3.12' },
  frameworks: [{ name: 'Django', version: '5' }],
  databases: [{ engine: 'postgresql' }],
  auth: 'session',
  os: ['windows'],
  deployment: 'serverless',
};

/** GitHub for the orders fixture: the repository, its files and a search for similar ones. */
function github(spdx: string | null = 'MIT') {
  const repo = makeRepo('acme/orders', ORDERS_SERVICE);
  const base = fixtureApi(repo);
  const raw = (over: Record<string, unknown>) => rawRepo({ full_name: 'acme/orders', html_url: 'https://github.com/acme/orders', topics: ['orders'], license: spdx ? { spdx_id: spdx } : null, ...over }); // prettier-ignore
  const api = (url: string): Response | undefined => {
    const { pathname, searchParams } = new URL(url);
    if (pathname === '/repos/acme/orders') return jsonResponse(raw({}));
    if (pathname === '/search/repositories') {
      return jsonResponse({
        total_count: 2,
        incomplete_results: false,
        items: [
          raw({ full_name: 'other/orders-kit', html_url: 'https://github.com/other/orders-kit' }),
          raw({ full_name: 'other/orders-agpl', html_url: 'https://github.com/other/orders-agpl', license: { spdx_id: 'AGPL-3.0' } }),
        ],
      });
    }
    const contents = /^\/repos\/acme\/orders\/contents\/(.+)$/.exec(pathname);
    if (contents?.[1] && searchParams.get('ref')) {
      const file = repo.files[contents[1]];
      if (file === undefined) return jsonResponse({ message: 'Not Found' }, 404);
      const buf = typeof file === 'string' ? Buffer.from(file) : file;
      return jsonResponse({ type: 'file', size: buf.length, encoding: 'base64', content: buf.toString('base64') });
    }
    return base(url);
  };
  return { api, repo };
} // prettier-ignore

async function setup(options: { githubId?: number; spdx?: string | null; replies?: string[]; ingest?: boolean } = {}) {
  const gh = github(options.spdx);
  const provider = new FakeProvider('groq', options.replies ?? [JSON.stringify({ summary: EXPLANATION, highlights: ['MIT'], risks: ['No Node runtime'] })]);
  const signed = await signInWith({
    githubId: options.githubId ?? 1,
    api: gh.api,
    makeGithub: (fetchImpl) => new GithubService({ fetch: fetchImpl, sleep }),
    extraDeps: { llm: new LlmGateway({ providers: { groq: provider }, sleep }) },
  });
  if (options.ingest !== false) {
    expect((await signed.agent.post(`${BASE}/ingest`).send({})).status).toBe(201);
    await ArchitectureGraphModel.create({ fullName: 'acme/orders', sha: gh.repo.commits.at(-1), graph: fixtureGraph(), computedAt: new Date() });
  }
  return { ...signed, provider, sha: gh.repo.commits.at(-1) ?? '' };
} // prettier-ignore

const evaluateWith = async (agent: Awaited<ReturnType<typeof setup>>['agent'], body: unknown) => {
  const res = await agent.post(`${BASE}/adaptability`).send(body as object);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return adaptabilityReportSchema.parse(res.body);
};

describe('stack profiles', () => {
  it('saves, lists, replaces and deletes a profile, up to the limit', async () => {
    const { agent } = await setup({ ingest: false });
    const created = stackProfileSchema.parse((await agent.post('/api/v1/me/stack-profiles').send(MATCHING)).body);
    expect(created).toMatchObject({ name: 'Node API', os: ['linux'], license: { use: 'internal', copyleft: 'weak' } });

    const replaced = await agent.put(`/api/v1/me/stack-profiles/${created.id}`).send({ ...MATCHING, name: 'Node 22 API', auth: 'oauth' });
    expect(stackProfileSchema.parse(replaced.body)).toMatchObject({ id: created.id, name: 'Node 22 API', auth: 'oauth' });

    for (let i = 1; i < MAX_STACK_PROFILES; i++) {
      expect((await agent.post('/api/v1/me/stack-profiles').send({ name: `p${i}` })).status).toBe(201);
    }
    const over = await agent.post('/api/v1/me/stack-profiles').send({ name: 'one too many' });
    expect(over.status).toBe(400);
    const list = stackProfileListSchema.parse((await agent.get('/api/v1/me/stack-profiles')).body);
    expect(list).toMatchObject({ limit: MAX_STACK_PROFILES });
    expect(list.profiles).toHaveLength(MAX_STACK_PROFILES);

    expect((await agent.delete(`/api/v1/me/stack-profiles/${created.id}`)).status).toBe(204);
    expect((await agent.delete(`/api/v1/me/stack-profiles/${created.id}`)).status).toBe(404);
    expect((await agent.post('/api/v1/me/stack-profiles').send({ name: 'x', runtimes: { node: 'latest' } })).status).toBe(400);
  }); // prettier-ignore

  it("keeps one user's profiles from another", async () => {
    const first = await setup({ ingest: false });
    const mine = stackProfileSchema.parse((await first.agent.post('/api/v1/me/stack-profiles').send(MATCHING)).body);
    const second = await setup({ githubId: 2, ingest: false });
    expect((await second.agent.put(`/api/v1/me/stack-profiles/${mine.id}`).send(MATCHING)).status).toBe(404);
    expect(stackProfileListSchema.parse((await second.agent.get('/api/v1/me/stack-profiles')).body).profiles).toEqual([]);
    expect((await request(first.app).get('/api/v1/me/stack-profiles')).status).toBe(401);
  }); // prettier-ignore

  it('reads a pasted manifest into profile fields', async () => {
    const { app } = await setup({ ingest: false });
    const content = JSON.stringify({ engines: { node: '>=20.10' }, dependencies: { express: '^4.19.0' }, devDependencies: { vitest: '^3.0.0' } });
    const parsed = parsedManifestSchema.parse((await request(app).post('/api/v1/adaptability/parse-manifest').send({ filename: 'package.json', content })).body);
    expect(parsed.runtimes).toEqual({ node: '20.10.0' });
    expect(parsed.dependencies).toEqual([
      { name: 'express', version: '^4.19.0', ecosystem: 'npm' },
      { name: 'vitest', version: '^3.0.0', ecosystem: 'npm' },
    ]);
    const python = parsedManifestSchema.parse((await request(app).post('/api/v1/adaptability/parse-manifest').send({ filename: 'requirements.txt', content: 'django==5.0.1\n' })).body);
    expect(python).toMatchObject({ ecosystem: 'pypi', runtimes: {}, dependencies: [{ name: 'django', version: '==5.0.1' }] });
    expect((await request(app).post('/api/v1/adaptability/parse-manifest').send({ filename: 'notes.txt', content: 'hello' })).status).toBe(400);
  }); // prettier-ignore
});

describe('evaluation', () => {
  it('gives one repository different results for different saved stacks, each warning with evidence', async () => {
    const { agent, sha } = await setup();
    const a = stackProfileSchema.parse(
      (await agent.post('/api/v1/me/stack-profiles').send(MATCHING)).body,
    );
    const b = stackProfileSchema.parse(
      (await agent.post('/api/v1/me/stack-profiles').send(DIFFERENT)).body,
    );
    const fits = await evaluateWith(agent, { profileId: a.id });
    const differs = await evaluateWith(agent, { profileId: b.id });

    expect(fits).toMatchObject({ fullName: 'acme/orders', sha, interpretation: null });
    expect(fits.facts.overall).toMatchObject({ score: 100, verdict: 'ready' });
    expect(differs.facts.overall.verdict).toBe('adaptable');
    expect(differs.facts.overall.score).toBeLessThan(fits.facts.overall.score ?? 0);
    expect(differs.id).not.toBe(fits.id);

    expect(differs.facts.warnings.length).toBeGreaterThan(3);
    for (const warning of differs.facts.warnings)
      expect(warning.evidence.length).toBeGreaterThan(0);
    const runtime = differs.facts.warnings.find((w) => w.id === 'runtime-missing-node');
    expect(runtime?.evidence[0]).toMatchObject({ source: 'file', path: 'package.json', line: 17 });
    expect(differs.facts.requirements.license.spdxId).toBe('MIT');
    expect(differs.facts.inputs).toEqual({ ingestion: true, graph: true });

    // The same stack and commit give the same stored report.
    expect((await evaluateWith(agent, { profileId: a.id })).id).toBe(fits.id);
    expect(await AdaptabilityReport.countDocuments()).toBe(2);
  });

  it('lets an anonymous visitor evaluate without storing anything', async () => {
    const { app } = await setup();
    const res = await request(app).post(`${BASE}/adaptability`).send({ profile: DIFFERENT });
    const report = adaptabilityReportSchema.parse(res.body);
    expect(report.id).toBeNull();
    expect(report.facts.overall.verdict).toBe('adaptable');
    expect(report.checklist.length).toBeGreaterThan(3);
    expect(await AdaptabilityReport.countDocuments()).toBe(0);
    expect(
      (
        await request(app)
          .post(`${BASE}/adaptability`)
          .send({ profileId: 'a'.repeat(24) })
      ).status,
    ).toBe(401);
    expect(
      (
        await request(app)
          .post(`${BASE}/adaptability`)
          .send({ profile: { name: 'x', os: ['beos'] } })
      ).status,
    ).toBe(400);
  });

  it('needs an ingestion, and reports a license blocker from GitHub', async () => {
    const none = await setup({ ingest: false });
    const missing = await none.agent.post(`${BASE}/adaptability`).send({ profile: MATCHING });
    expect(missing.status).toBe(404);
    expect(errorOf(missing).message).toMatch(/Ingest this repository/);

    await mongoose.connection.collection('githubcaches').deleteMany({});
    const { agent } = await setup({ githubId: 2, spdx: 'AGPL-3.0' });
    const report = await evaluateWith(agent, { profile: { ...MATCHING, license: { use: 'saas', copyleft: 'weak' } } });
    expect(report.facts.overall).toMatchObject({ score: 25, verdict: 'blocked' });
    expect(report.facts.warnings[0]).toMatchObject({ severity: 'blocker', dimension: 'license' });
  }); // prettier-ignore

  it('notes when no architecture graph was available', async () => {
    const { agent } = await setup();
    await ArchitectureGraphModel.deleteMany({});
    const report = await evaluateWith(agent, { profile: MATCHING });
    expect(report.facts.inputs.graph).toBe(false);
    expect(report.notes[0]).toMatch(/No architecture graph/);
    // Manifests still reveal the ORM and the auth library.
    expect(report.facts.requirements.database.orms).toEqual(['Mongoose']);
    expect(report.facts.requirements.auth.map((a) => a.approach)).toEqual(['jwt']);
  });
});

describe('stored reports', () => {
  it('keeps checklist ticks and hides reports from other users', async () => {
    const { agent, app } = await setup();
    const report = await evaluateWith(agent, { profile: DIFFERENT });
    const id = report.id ?? '';
    const ticked = await agent.put(`/api/v1/adaptability/${id}/checklist`).send({ done: ['pin-commit', 'runtime-add-node', 'made-up'] });
    const saved = adaptabilityReportSchema.parse(ticked.body);
    expect(saved.checklist.filter((c) => c.done).map((c) => c.id)).toEqual(['pin-commit', 'runtime-add-node']);
    expect(adaptabilityReportSchema.parse((await agent.get(`/api/v1/adaptability/${id}`)).body).checklist).toEqual(saved.checklist);

    expect((await request(app).get(`/api/v1/adaptability/${id}`)).status).toBe(401);
    const other = await setup({ githubId: 2, ingest: false });
    expect((await other.agent.get(`/api/v1/adaptability/${id}`)).status).toBe(404);
    expect((await other.agent.post(`/api/v1/adaptability/${id}/explain`)).status).toBe(404);
  }); // prettier-ignore

  it('adds a model explanation once, apart from the rule results, within the shared quota', async () => {
    const { agent, provider } = await setup();
    const report = await evaluateWith(agent, { profile: DIFFERENT });
    const id = report.id ?? '';
    const explained = adaptabilityReportSchema.parse((await agent.post(`/api/v1/adaptability/${id}/explain`)).body);
    expect(explained.interpretation).toMatchObject({ summary: EXPLANATION, risks: ['No Node runtime'] });
    expect(explained.interpretation?.writtenBy).toMatch(/^groq\//);
    expect(explained.facts).toEqual(report.facts);
    expect(JSON.stringify(explained.facts)).not.toContain(EXPLANATION);

    await agent.post(`/api/v1/adaptability/${id}/explain`);
    expect(provider.calls).toHaveLength(1);
    expect(docQuotaSchema.parse((await agent.get('/api/v1/me/docs-quota')).body).usedToday).toBe(1);
    // Evaluating again keeps the explanation that belongs to the same results.
    expect((await evaluateWith(agent, { profile: DIFFERENT })).interpretation?.summary).toBe(EXPLANATION);
    // Once the results change, here because the graph is gone, the old explanation is dropped.
    await ArchitectureGraphModel.deleteMany({});
    expect((await evaluateWith(agent, { profile: DIFFERENT })).interpretation).toBeNull();

    const second = await evaluateWith(agent, { profile: MATCHING });
    const user = await User.findOne({ githubId: 1 });
    if (!user) throw new Error('expected a user');
    await ReleaseSummary.create(Array.from({ length: DOC_QUOTA.dailyGenerations }, (_, i) => ({ fullName: 'acme/x', tag: `v${i}`, createdBy: user.id, facts: {}, charged: true })));
    const limited = await agent.post(`/api/v1/adaptability/${second.id ?? ''}/explain`);
    expect(limited.status).toBe(429);
    expect(errorOf(limited).code).toBe('QUOTA_EXCEEDED');
  }); // prettier-ignore

  it('exports the readiness report as Markdown, HTML and JSON', async () => {
    const { agent, sha } = await setup();
    const id = (await evaluateWith(agent, { profile: DIFFERENT })).id ?? '';
    const md = await agent.get(`/api/v1/adaptability/${id}/export`);
    expect(md.headers['content-type']).toMatch(/text\/markdown/);
    expect(md.headers['content-disposition']).toBe(
      `attachment; filename="acme-orders-readiness-${sha.slice(0, 7)}.md"`,
    );
    expect(md.text).toContain('# Integration readiness: acme/orders');
    expect(md.text).toContain(`(https://github.com/acme/orders/blob/${sha}/package.json#L17)`);
    expect(md.text).toContain('## Adaptation checklist');

    const html = await agent.get(`/api/v1/adaptability/${id}/export?format=html`);
    expect(html.headers['content-type']).toMatch(/text\/html/);
    expect(html.text).toContain('<h1>Integration readiness: acme/orders</h1>');
    const json = await agent.get(`/api/v1/adaptability/${id}/export?format=json`);
    expect(adaptabilityReportSchema.parse(JSON.parse(json.text)).id).toBe(id);
    expect((await agent.get(`/api/v1/adaptability/${id}/export?format=pdf`)).status).toBe(400);
  });

  it('suggests similar repositories that pass the same license rules', async () => {
    const { agent } = await setup();
    const res = await agent.post(`${BASE}/adaptability/alternatives`).send({ profile: { ...MATCHING, license: { use: 'saas', copyleft: 'weak' } } });
    const alternatives = alternativesSchema.parse(res.body);
    expect(alternatives.items.map((i) => i.repo.fullName)).toEqual(['other/orders-kit']);
    expect(alternatives.filtered).toBe(1);
    expect(alternatives.items[0]?.reasons[0]).toBe('MIT fits your license policy');
  }); // prettier-ignore
});
