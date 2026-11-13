import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { implementationPlanSchema, onboardingSchema } from '@repointelligence/shared';
import { OnboardingPanel } from './OnboardingPanel';
import { PlannerPanel } from './PlannerPanel';

const SHA = 'c'.repeat(40);
const base = '/api/v1/repos/acme/tool';
const blob = (path: string) => `https://github.com/acme/tool/blob/${SHA}/${path}`;
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status });
const user = { id: 'u1', login: 'octocat', preferences: { theme: 'system', privateRepoAccess: false, allowPrivateRepoLlm: false }, privateRepoScope: false, docsWriteScope: false }; // prettier-ignore
const ingestion = { fullName: 'acme/tool', sha: SHA, ref: 'main', status: 'completed', private: false, startedAt: '2026-10-01T00:00:00.000Z', completedAt: '2026-10-01T00:01:00.000Z', stats: null, error: null, reused: true }; // prettier-ignore

function onboarding(mode: 'beginner' | 'advanced', done: string[] = []) {
  const stages = mode === 'beginner'
    ? [{ id: 'stage-run', title: 'Get it running', goal: 'Install and start it once.', files: ['package.json'] }]
    : [{ id: 'stage-architecture', title: 'Map the architecture', goal: 'Identify the layers.', files: ['src/index.ts'] }];
  const checklist = [{ id: 'install-npm-ci', text: 'Run `npm ci`' }, ...stages.map((s) => ({ id: s.id, text: s.title }))].map((c) => ({ ...c, done: done.includes(c.id) }));
  return onboardingSchema.parse({
    fullName: 'acme/tool', sha: SHA, mode, notes: [],
    walkthrough: { summary: ['acme/tool: A tool', 'It is built with Node.js, Express.'], layout: [{ path: 'routes', files: 3, role: 'request handlers and user interface' }], entryPoints: [{ path: 'src/index.ts', line: 1, label: 'index.ts' }], flows: [{ path: 'src/routes/orders.ts', line: 5, title: 'GET /orders', handler: null }] },
    prerequisites: [{ id: 'runtime-node', kind: 'runtime', label: 'Node.js >=22', detail: 'The version range the project declares.', source: { path: 'package.json', line: 17 } }],
    install: [{ id: 'install-npm-ci', command: 'npm ci', why: 'install the locked Node.js dependencies', source: { path: 'package-lock.json', line: 1 } }],
    troubleshooting: [{ id: 'trouble-env-jwt-secret', symptom: 'Startup fails because JWT_SECRET is empty.', fix: 'Set JWT_SECRET.', source: { path: '.env.example', line: 6 } }],
    readingList: [{ path: 'README.md', line: null, reason: 'What the project is.' }],
    roadmap: { complexity: 'small', basis: '6 source files in 6 modules', stages },
    checklist,
    progress: { done: checklist.filter((c) => c.done).length, total: checklist.length },
  });
} // prettier-ignore

const task = (id: string, order: number, title: string, done: boolean, over: Record<string, unknown> = {}) => ({
  id, order, title, description: `${title} in the service.`, dependsOn: [], api: [], database: [], done,
  files: [{ path: 'src/services/orders.ts', change: 'modify', module: 'services', layer: 'service', lines: 80, importedBy: 2, reason: 'holds the query' }],
  tests: [{ path: 'src/services/orders.test.ts', exists: true, note: 'Extend the existing tests for orders.ts.' }],
  risk: { level: 'low', reasons: [] }, effort: { low: 1.5, high: 4.5 },
  ...over,
}); // prettier-ignore
function plan(done: string[] = []) {
  const tasks = [
    task('task-1', 1, 'Write CSV rows', done.includes('task-1'), { files: [{ path: 'src/services/orders.ts', change: 'modify', module: 'services', layer: 'service', lines: 80, importedBy: 2, reason: 'holds the query' }, { path: 'src/services/csv.ts', change: 'create', module: 'services', layer: 'service', lines: null, importedBy: null, reason: 'new helper' }] }),
    task('task-2', 2, 'Add the export route', done.includes('task-2'), { dependsOn: ['task-1'], api: [{ method: 'GET', route: '/orders/export', change: 'new' }], risk: { level: 'medium', reasons: ['1 changed files have no tests yet'] } }),
  ];
  return implementationPlanSchema.parse({
    id: 'a'.repeat(24), fullName: 'acme/tool', sha: SHA, goal: 'Add CSV export to the orders list', generatedAt: '2026-11-10T00:00:00.000Z',
    origin: 'model', writtenBy: 'groq/gpt-oss-120b', notes: [], dropped: { tasks: 1, files: 2 }, relevantFiles: [], tasks,
    totals: { effort: { low: 3, high: 9 }, risk: 'medium', files: 2 }, progress: { done: done.length, total: 2 },
  });
} // prettier-ignore

type Handler = (url: URL, body: unknown) => Response;
function stubApi(routes: Record<string, Handler>, opts: { signedIn?: boolean; ingested?: boolean } = {}) {
  const calls: { key: string; body: unknown; search: string }[] = [];
  vi.stubGlobal('fetch', vi.fn<typeof fetch>((input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const key = `${init?.method ?? 'GET'} ${url.pathname}`;
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ key, body, search: url.search });
    const handler = routes[key];
    if (handler) return Promise.resolve(handler(url, body));
    if (url.pathname === '/api/v1/me') return Promise.resolve(opts.signedIn ? json({ user }) : json({ error: { code: 'UNAUTHORIZED', message: 'x' } }, 401));
    if (url.pathname === `${base}/ingestions/latest`) return Promise.resolve(opts.ingested === false ? json({ error: { code: 'NOT_FOUND', message: 'x' } }, 404) : json(ingestion));
    return Promise.resolve(json({ error: { code: 'NOT_FOUND', message: 'nope' } }, 404));
  }));
  return calls;
} // prettier-ignore

function renderWith(panel: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{panel}</MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Get started panel', () => {
  it('asks for an ingestion first', async () => {
    stubApi({}, { ingested: false });
    renderWith(<OnboardingPanel fullName="acme/tool" />);
    expect(await screen.findByText(/Ingest this repository to build a walkthrough/)).toBeVisible();
  });

  it('shows setup steps with links to the files they came from and switches mode', async () => {
    const calls = stubApi({
      [`GET ${base}/onboarding`]: (url) => json(onboarding(url.searchParams.get('mode') === 'advanced' ? 'advanced' : 'beginner')),
      [`GET ${base}/starter-issues`]: () => json({ fullName: 'acme/tool', sha: SHA, github: [{ repo: 'acme/tool', number: 7, title: 'Fix typo', htmlUrl: 'https://github.com/acme/tool/issues/7', labels: ['good first issue'], comments: 0, createdAt: '2026-01-01T00:00:00Z' }], candidates: [{ id: 'tests-src/a.ts', kind: 'missing-tests', title: 'Add tests for src/a.ts', detail: '40 lines.', path: 'src/a.ts', line: null }], notes: [] }),
    }); // prettier-ignore
    renderWith(<OnboardingPanel fullName="acme/tool" />);
    const install = await screen.findByRole('region', { name: 'Install steps' });
    expect(within(install).getByText('npm ci')).toBeVisible();
    expect(within(install).getByRole('link', { name: 'package-lock.json:1' })).toHaveAttribute('href', `${blob('package-lock.json')}#L1`);
    expect(screen.getByText('Built from the repository files')).toBeVisible();
    expect(within(screen.getByRole('region', { name: 'Prerequisites' })).getByRole('link', { name: 'package.json:17' })).toHaveAttribute('href', `${blob('package.json')}#L17`);
    expect(within(screen.getByRole('region', { name: 'Learning roadmap' })).getByText('Get it running.')).toBeVisible();
    const starters = await screen.findByRole('region', { name: 'Starter issues' });
    expect(within(starters).getByRole('link', { name: '#7 Fix typo' })).toBeVisible();
    expect(within(starters).getByText('Add tests for src/a.ts')).toBeVisible();

    // Anonymous ticks stay on the page.
    await userEvent.click(screen.getByLabelText('Run `npm ci`'));
    expect(screen.getByText('Your progress: 1 of 2')).toBeVisible();
    expect(screen.getByText(/Sign in to keep your progress/)).toBeVisible();
    expect(calls.some((c) => c.key.startsWith('PUT'))).toBe(false);

    await userEvent.click(screen.getByRole('button', { name: 'Advanced' }));
    expect(await screen.findByText('Map the architecture.')).toBeVisible();
    expect(calls.filter((c) => c.key === `GET ${base}/onboarding`).at(-1)?.search).toBe('?mode=advanced');
  }); // prettier-ignore

  it('stores ticks for a signed-in user', async () => {
    let saved = ['stage-run'];
    const calls = stubApi({
      [`GET ${base}/onboarding`]: () => json(onboarding('beginner', saved)),
      [`PUT ${base}/onboarding/progress`]: (_u, body) => {
        saved = (body as { done: string[] }).done;
        return new Response(null, { status: 204 });
      },
    }, { signedIn: true }); // prettier-ignore
    renderWith(<OnboardingPanel fullName="acme/tool" />);
    expect(await screen.findByText('Your progress: 1 of 2')).toBeVisible();
    expect(screen.getByLabelText('Get it running')).toBeChecked();
    await userEvent.click(screen.getByLabelText('Run `npm ci`'));
    expect(calls.find((c) => c.key.startsWith('PUT'))?.body).toEqual({
      done: ['stage-run', 'install-npm-ci'],
    });
    expect(await screen.findByText('Your progress: 2 of 2')).toBeVisible();
    expect(screen.queryByText(/Sign in to keep your progress/)).not.toBeInTheDocument();
  });
});

describe('Plan a feature panel', () => {
  it('asks an anonymous visitor to sign in', async () => {
    stubApi({});
    renderWith(<PlannerPanel fullName="acme/tool" />);
    expect(await screen.findByRole('link', { name: 'Sign in to plan a feature' })).toBeVisible();
    expect(screen.queryByLabelText(/What do you want to build/)).not.toBeInTheDocument();
  });

  it('creates a plan, shows what was checked, keeps ticks and offers exports', async () => {
    let done: string[] = [];
    const id = 'a'.repeat(24);
    const calls = stubApi({
      [`GET ${base}/plans`]: () => json({ plans: [], limit: 20 }),
      [`POST ${base}/plans`]: () => json(plan(), 201),
      [`PUT /api/v1/plans/${id}/progress`]: (_u, body) => {
        done = (body as { done: string[] }).done;
        return json(plan(done));
      },
    }, { signedIn: true }); // prettier-ignore
    renderWith(<PlannerPanel fullName="acme/tool" />);
    const goal = await screen.findByLabelText(/What do you want to build/);
    expect(screen.getByRole('button', { name: 'Create plan' })).toBeDisabled();
    await userEvent.type(goal, 'Add CSV export to the orders list');
    await userEvent.click(screen.getByRole('button', { name: 'Create plan' }));

    const view = await screen.findByRole('region', { name: 'Implementation plan' });
    expect(calls.find((c) => c.key === `POST ${base}/plans`)?.body).toEqual({ goal: 'Add CSV export to the orders list' });
    expect(within(view).getByText('Tasks proposed by groq/gpt-oss-120b')).toBeVisible();
    expect(within(view).getByText(/Paths, order, tests, effort and risk checked against commit ccccccc/)).toBeVisible();
    expect(within(view).getByText(/1 proposed tasks and 2 proposed files were removed/)).toBeVisible();

    const items = within(view).getAllByRole('listitem').filter((li) => li.className.includes('rounded-lg'));
    expect(items).toHaveLength(2);
    const [first, second] = items as [HTMLElement, HTMLElement];
    expect(within(first).getByRole('link', { name: 'src/services/orders.ts' })).toHaveAttribute('href', blob('src/services/orders.ts'));
    expect(within(first).getByText('New file')).toBeVisible();
    expect(within(first).getByText('src/services/csv.ts')).toBeVisible();
    expect(within(second).getByText('task 1')).toBeVisible();
    expect(within(second).getByText('add GET /orders/export')).toBeVisible();
    expect(within(second).getByText(/1 changed files have no tests yet/)).toBeVisible();

    await userEvent.click(within(view).getByLabelText('1. Write CSV rows'));
    expect(calls.find((c) => c.key.startsWith('PUT'))?.body).toEqual({ done: ['task-1'] });
    expect(await within(view).findByText('1 of 2')).toBeVisible();
    expect(within(view).getByLabelText('1. Write CSV rows')).toBeChecked();

    expect(within(view).getByRole('link', { name: 'Markdown' })).toHaveAttribute('href', expect.stringContaining(`/api/v1/plans/${id}/export?format=markdown`));
    expect(within(view).getByRole('link', { name: 'Issue checklist' })).toHaveAttribute('href', expect.stringContaining('format=issue'));
  }); // prettier-ignore

  it('opens and deletes a saved plan, and shows the server message when planning fails', async () => {
    const id = 'a'.repeat(24);
    let plans = [
      {
        id,
        goal: 'Add CSV export to the orders list',
        sha: SHA,
        generatedAt: '2026-11-10T00:00:00.000Z',
        origin: 'model',
        progress: { done: 1, total: 2 },
      },
    ];
    stubApi({
      [`GET ${base}/plans`]: () => json({ plans, limit: 20 }),
      [`GET /api/v1/plans/${id}`]: () => json(plan(['task-1'])),
      [`DELETE /api/v1/plans/${id}`]: () => {
        plans = [];
        return new Response(null, { status: 204 });
      },
      [`POST ${base}/plans`]: () => json({ error: { code: 'QUOTA_EXCEEDED', message: "You have used today's 10 generations" } }, 429),
    }, { signedIn: true }); // prettier-ignore
    renderWith(<PlannerPanel fullName="acme/tool" />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Add CSV export to the orders list' }),
    );
    const view = await screen.findByRole('region', { name: 'Implementation plan' });
    expect(within(view).getByLabelText('1. Write CSV rows')).toBeChecked();

    await userEvent.type(
      screen.getByLabelText(/What do you want to build/),
      'Add rate limiting to the API',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Create plan' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "You have used today's 10 generations",
    );

    await userEvent.click(screen.getByRole('button', { name: /Delete plan/ }));
    expect(await screen.findByText(/What do you want to build/)).toBeVisible();
    await vi.waitFor(() => {
      expect(screen.queryByRole('region', { name: 'Implementation plan' })).not.toBeInTheDocument();
    });
  });
});
