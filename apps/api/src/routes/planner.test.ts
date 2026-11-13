import mongoose from 'mongoose';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_PLANS_PER_REPO,
  docQuotaSchema,
  errorResponseSchema,
  implementationPlanSchema,
  onboardingSchema,
  planListSchema,
  starterIssuesSchema,
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
import { ArchitectureGraphModel } from '../models/architecture-graph.js';
import { ImplementationPlan } from '../models/implementation-plan.js';
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
const GOAL = 'Add CSV export to the orders list';
const FILES = Object.keys(ORDERS_SERVICE);
const errorOf = (res: { body: unknown }) => errorResponseSchema.parse(res.body).error;

/** A proposal with one sound task, one that mixes a real and an invented file, and one invented. */
const PROPOSAL = JSON.stringify({
  tasks: [
    { title: 'Add the export route', description: 'Register GET /orders/export next to the list route.', files: [{ path: 'src/routes/orders.ts', change: 'modify', reason: 'holds the order routes' }], api: [{ method: 'GET', route: '/orders/export' }] },
    { title: 'Serialise orders as CSV', description: 'Turn Order documents into rows.', files: [{ path: 'src/models/order.ts', change: 'modify', reason: 'defines the fields' }, { path: 'src/routes/csv.ts', change: 'create', reason: 'new helper' }, { path: 'src/utils/csvWriter.ts', change: 'modify', reason: 'existing writer' }], models: ['Order'] },
    { title: 'Update the exporter service', description: 'Wire it in.', files: [{ path: 'src/exporters/service.ts', change: 'modify', reason: 'the exporter' }] },
  ],
}); // prettier-ignore

function github() {
  const repo = makeRepo('acme/orders', ORDERS_SERVICE);
  const base = fixtureApi(repo);
  const api = (url: string): Response | undefined => {
    const { pathname, searchParams } = new URL(url);
    if (pathname === '/repos/acme/orders') return jsonResponse(rawRepo({ full_name: 'acme/orders', html_url: 'https://github.com/acme/orders', description: 'Orders service' }));
    if (pathname === '/search/issues') {
      return jsonResponse({ total_count: 1, items: [{ number: 7, title: 'Fix typo in README', html_url: 'https://github.com/acme/orders/issues/7', comments: 1, created_at: '2026-01-01T00:00:00Z', repository_url: 'https://api.github.com/repos/acme/orders', labels: [{ name: 'good first issue' }] }] });
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

async function setup(options: { githubId?: number; replies?: string[] | null; ingest?: boolean } = {}) {
  const gh = github();
  const provider = new FakeProvider('groq', options.replies ?? [PROPOSAL]);
  const signed = await signInWith({
    githubId: options.githubId ?? 1,
    api: gh.api,
    makeGithub: (fetchImpl) => new GithubService({ fetch: fetchImpl, sleep }),
    extraDeps: { llm: new LlmGateway({ providers: options.replies === null ? {} : { groq: provider }, sleep }) },
  });
  if (options.ingest !== false) {
    expect((await signed.agent.post(`${BASE}/ingest`).send({})).status).toBe(201);
    await ArchitectureGraphModel.create({ fullName: 'acme/orders', sha: gh.repo.commits.at(-1), graph: fixtureGraph(), computedAt: new Date() });
  }
  return { ...signed, provider, sha: gh.repo.commits.at(-1) ?? '' };
} // prettier-ignore

describe('onboarding', () => {
  it('gives an anonymous visitor a walkthrough built from the real files', async () => {
    const { app, sha } = await setup();
    const res = await request(app).get(`${BASE}/onboarding`);
    expect(res.status).toBe(200);
    const o = onboardingSchema.parse(res.body);
    expect(o).toMatchObject({ fullName: 'acme/orders', sha, mode: 'beginner', progress: { done: 0 } });
    expect(o.install.map((s) => s.command)).toEqual(['npm ci', 'cp .env.example .env', 'npm run dev', 'npm run test']);
    expect(o.prerequisites[0]).toMatchObject({ label: 'Node.js >=22', source: { path: 'package.json', line: 17 } });
    for (const r of o.readingList) expect(FILES).toContain(r.path);
    for (const s of o.install) expect(s.source === null || FILES.includes(s.source.path)).toBe(true);

    const advanced = onboardingSchema.parse((await request(app).get(`${BASE}/onboarding?mode=advanced`)).body);
    expect(advanced.roadmap.stages[0]?.id).toBe('stage-architecture');
    expect(o.roadmap.stages[0]?.id).toBe('stage-run');
    expect((await request(app).get(`${BASE}/onboarding?mode=expert`)).status).toBe(400);
  }); // prettier-ignore

  it('needs an ingestion', async () => {
    const { app } = await setup({ ingest: false });
    const res = await request(app).get(`${BASE}/onboarding`);
    expect(res.status).toBe(404);
    expect(errorOf(res).message).toMatch(/Ingest this repository/);
  });

  it('keeps progress for a signed-in user only', async () => {
    const { app, agent } = await setup();
    expect((await request(app).put(`${BASE}/onboarding/progress`).send({ done: ['stage-run'] })).status).toBe(401);
    expect((await agent.put(`${BASE}/onboarding/progress`).send({ done: ['install-npm-ci', 'stage-run', 'stage-run'] })).status).toBe(204);
    const mine = onboardingSchema.parse((await agent.get(`${BASE}/onboarding`)).body);
    expect(mine.checklist.filter((c) => c.done).map((c) => c.id)).toEqual(['install-npm-ci', 'stage-run']);
    expect(mine.progress.done).toBe(2);
    // Progress follows the user across modes, where the step exists in both.
    const advanced = onboardingSchema.parse((await agent.get(`${BASE}/onboarding?mode=advanced`)).body);
    expect(advanced.checklist.filter((c) => c.done).map((c) => c.id)).toEqual(['install-npm-ci']);

    const other = await setup({ githubId: 2, ingest: false });
    expect(onboardingSchema.parse((await other.agent.get(`${BASE}/onboarding`)).body).progress.done).toBe(0);
    expect((await agent.put(`${BASE}/onboarding/progress`).send({ done: 'all' })).status).toBe(400);
  }); // prettier-ignore

  it('lists starter issues from GitHub and from gaps in the files', async () => {
    const { app } = await setup();
    const s = starterIssuesSchema.parse((await request(app).get(`${BASE}/starter-issues`)).body);
    expect(s.github.map((i) => [i.number, i.title])).toEqual([[7, 'Fix typo in README']]);
    expect(
      s.candidates.some((c) => c.kind === 'missing-tests' && c.path === 'src/routes/orders.ts'),
    ).toBe(true);
  });
});

describe('feature plans', () => {
  it('requires sign-in and a real goal', async () => {
    const { app, agent } = await setup();
    expect((await request(app).post(`${BASE}/plans`).send({ goal: GOAL })).status).toBe(401);
    expect((await agent.post(`${BASE}/plans`).send({ goal: 'csv' })).status).toBe(400);
    expect((await agent.post(`${BASE}/plans`).send({ goal: GOAL, extra: true })).status).toBe(400);
    expect((await request(app).get(`${BASE}/plans`)).status).toBe(401);
  });

  it('stores a plan that only references real paths, in dependency order', async () => {
    const { agent, provider, sha } = await setup();
    const res = await agent.post(`${BASE}/plans`).send({ goal: GOAL });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const plan = implementationPlanSchema.parse(res.body);
    expect(plan).toMatchObject({ fullName: 'acme/orders', sha, goal: GOAL, origin: 'model' });
    expect(plan.writtenBy).toMatch(/^groq\//);
    expect(provider.calls).toHaveLength(1);

    // The invented file and the invented task are gone, and counted.
    expect(plan.dropped).toEqual({ tasks: 1, files: 2 });
    expect(plan.tasks.map((t) => t.title)).toEqual(['Serialise orders as CSV', 'Add the export route']);
    for (const t of plan.tasks) {
      for (const f of t.files) expect(f.change === 'create' ? f.path.startsWith('src/routes/') : FILES.includes(f.path)).toBe(true);
    }
    // The route file imports the service that imports the model, so the model task comes first.
    const [model, route] = plan.tasks;
    expect(model?.files.map((f) => [f.path, f.change])).toEqual([['src/models/order.ts', 'modify'], ['src/routes/csv.ts', 'create']]);
    expect(model?.database).toEqual([{ model: 'Order', change: 'existing', path: 'src/models/order.ts' }]);
    expect(model?.risk.level).toBe('high');
    expect(route?.api).toEqual([{ method: 'GET', route: '/orders/export', change: 'new' }]);
    expect(route?.tests).toEqual([{ path: 'src/routes/orders.test.ts', exists: false, note: 'orders.ts has no test file; add one.' }]);
    expect(plan.totals.files).toBe(3);
    expect(plan.totals.risk).toBe('high');
    expect(plan.relevantFiles.every((f) => FILES.includes(f.path))).toBe(true);
    expect(docQuotaSchema.parse((await agent.get('/api/v1/me/docs-quota')).body).usedToday).toBe(1);
  }); // prettier-ignore

  it('persists progress, lists, exports and deletes a plan, for its owner only', async () => {
    const { agent, sha } = await setup();
    const plan = implementationPlanSchema.parse((await agent.post(`${BASE}/plans`).send({ goal: GOAL })).body);
    const ticked = await agent.put(`/api/v1/plans/${plan.id}/progress`).send({ done: ['task-1', 'task-9'] });
    expect(implementationPlanSchema.parse(ticked.body).progress).toEqual({ done: 1, total: 2 });
    const again = implementationPlanSchema.parse((await agent.get(`/api/v1/plans/${plan.id}`)).body);
    expect(again.tasks.map((t) => t.done)).toEqual([true, false]);

    const list = planListSchema.parse((await agent.get(`${BASE}/plans`)).body);
    expect(list).toMatchObject({ limit: MAX_PLANS_PER_REPO, plans: [{ id: plan.id, goal: GOAL, progress: { done: 1, total: 2 } }] });

    const md = await agent.get(`/api/v1/plans/${plan.id}/export`);
    expect(md.headers['content-type']).toMatch(/text\/markdown/);
    expect(md.headers['content-disposition']).toBe(`attachment; filename="acme-orders-plan-${sha.slice(0, 7)}.md"`);
    expect(md.text).toContain(`# Implementation plan: ${GOAL}`);
    expect(md.text).toContain(`(https://github.com/acme/orders/blob/${sha}/src/models/order.ts)`);
    expect(md.text).toContain('1 proposed tasks and 2 proposed files were removed');
    const issue = await agent.get(`/api/v1/plans/${plan.id}/export?format=issue`);
    expect(issue.text).toContain('- [x] **Serialise orders as CSV**');
    expect(issue.text).toContain('- [ ] **Add the export route**');
    expect((await agent.get(`/api/v1/plans/${plan.id}/export?format=pdf`)).status).toBe(400);

    const other = await setup({ githubId: 2, ingest: false });
    expect((await other.agent.get(`/api/v1/plans/${plan.id}`)).status).toBe(404);
    expect((await other.agent.delete(`/api/v1/plans/${plan.id}`)).status).toBe(404);
    expect(planListSchema.parse((await other.agent.get(`${BASE}/plans`)).body).plans).toEqual([]);

    expect((await agent.delete(`/api/v1/plans/${plan.id}`)).status).toBe(204);
    expect((await agent.get(`/api/v1/plans/${plan.id}`)).status).toBe(404);
  }); // prettier-ignore

  it('lists the relevant files in order when no model is configured, without using the quota', async () => {
    const { agent } = await setup({ replies: null });
    const plan = implementationPlanSchema.parse((await agent.post(`${BASE}/plans`).send({ goal: GOAL })).body);
    expect(plan).toMatchObject({ origin: 'files-only', writtenBy: null, dropped: { tasks: 0, files: 0 } });
    expect(plan.notes.join(' ')).toMatch(/No suitable model is configured/);
    expect(plan.tasks.length).toBeGreaterThan(0);
    expect(plan.tasks.every((t) => t.description === null && t.title.startsWith('Review ') && FILES.includes(t.files[0]?.path ?? ''))).toBe(true);
    expect(docQuotaSchema.parse((await agent.get('/api/v1/me/docs-quota')).body).usedToday).toBe(0);
  }); // prettier-ignore

  it('falls back to the files when nothing the model proposed exists', async () => {
    const invented = JSON.stringify({ tasks: [{ title: 'Edit the controller', files: [{ path: 'app/controllers/orders_controller.rb', change: 'modify' }] }] });
    const { agent } = await setup({ replies: [invented] });
    const plan = implementationPlanSchema.parse((await agent.post(`${BASE}/plans`).send({ goal: GOAL })).body);
    expect(plan.origin).toBe('files-only');
    expect(plan.dropped).toEqual({ tasks: 1, files: 1 });
    expect(plan.notes.join(' ')).toMatch(/None of the proposed tasks referred to files in this repository/);
  }); // prettier-ignore

  it('shares the daily quota and limits plans per repository', async () => {
    const { agent } = await setup();
    const user = await User.findOne({ githubId: 1 });
    if (!user) throw new Error('expected a user');
    await ReleaseSummary.create(Array.from({ length: DOC_QUOTA.dailyGenerations }, (_, i) => ({ fullName: 'acme/x', tag: `v${i}`, createdBy: user.id, facts: {}, charged: true })));
    const limited = await agent.post(`${BASE}/plans`).send({ goal: GOAL });
    expect(limited.status).toBe(429);
    expect(errorOf(limited).code).toBe('QUOTA_EXCEEDED');

    await ReleaseSummary.deleteMany({});
    await ImplementationPlan.create(Array.from({ length: MAX_PLANS_PER_REPO }, () => ({ fullName: 'acme/orders', sha: 'a'.repeat(40), createdBy: user.id, goal: GOAL, origin: 'files-only' as const, dropped: { tasks: 0, files: 0 }, relevantFiles: [], tasks: [], generatedAt: new Date(0) })));
    const full = await agent.post(`${BASE}/plans`).send({ goal: GOAL });
    expect(full.status).toBe(400);
    expect(errorOf(full).message).toMatch(/up to 20 plans/);
  }); // prettier-ignore
});
