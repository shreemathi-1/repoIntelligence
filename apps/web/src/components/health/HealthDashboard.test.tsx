import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../App';

const SHA = 'a'.repeat(40);
const user = {
  id: 'u1',
  login: 'octocat',
  preferences: { theme: 'system', privateRepoAccess: false, allowPrivateRepoLlm: false },
  privateRepoScope: false,
  docsWriteScope: false,
};
const repo = {
  repo: {
    fullName: 'acme/tool',
    description: 'A tool',
    private: false,
    defaultBranch: 'main',
    language: 'Python',
    stars: 3,
    htmlUrl: 'https://github.com/acme/tool',
  },
  source: 'network',
};

const metric = (
  id: string,
  status: 'measured' | 'inferred' | 'unavailable',
  score: number | null,
  evidence: string,
) => ({
  id,
  label: id,
  status,
  value: score,
  unit: status === 'unavailable' ? null : 'units',
  score,
  weight: 1,
  evidence,
  source: 'test',
});
const area = (
  id: string,
  label: string,
  weight: number,
  score: number | null,
  metrics: ReturnType<typeof metric>[],
) => ({
  id,
  label,
  weight,
  score,
  confidence: metrics.filter((m) => m.status !== 'unavailable').length / metrics.length,
  metrics,
});
const AREAS = [
  ['codeQuality', 'Code quality', 15],
  ['security', 'Security', 15],
  ['tests', 'Tests', 12],
  ['maintainability', 'Maintainability', 10],
  ['documentation', 'Documentation', 10],
  ['dependencies', 'Dependencies', 10],
  ['architecture', 'Architecture', 10],
  ['community', 'Community', 5],
  ['activity', 'Activity', 5],
  ['cicd', 'CI/CD', 5],
  ['busFactor', 'Bus factor', 3],
] as const;
const score = (overall: number | null) => ({
  overall,
  status: overall === null ? 'insufficient-data' : 'scored',
  confidence: 0.8,
  observedWeight: 80,
  totalWeight: 100,
  formula:
    'Each metric scores 0-100 from a stated rule. The overall score is the weight-averaged mean of scored areas.',
  weights: Object.fromEntries(AREAS.map(([id, , w]) => [id, w])),
  areas: AREAS.map(([id, label, w]) =>
    id === 'architecture'
      ? area(id, label, w, null, [
          metric(
            'architecture.graph',
            'unavailable',
            null,
            'Architecture analysis needs the module graph',
          ),
        ])
      : area(id, label, w, 70, [
          metric(`${id}.a`, 'measured', 70, `Evidence for ${label}`),
          metric(`${id}.b`, 'inferred', 70, 'A file was found'),
        ]),
  ),
  findings: [
    {
      tool: 'ruff',
      rule: 'E501',
      severity: 'low',
      message: 'Line too long',
      path: 'a.py',
      line: 1,
    },
  ],
  findingsTruncated: {},
});
const run = (over: Record<string, unknown> = {}) => ({
  id: 'r1',
  fullName: 'acme/tool',
  sha: SHA,
  status: 'succeeded',
  progress: { step: 'done', percent: 100, message: 'Finished: 72/100' },
  attempt: 1,
  error: null,
  reused: false,
  queuedAt: '2026-03-01T00:00:00.000Z',
  startedAt: null,
  finishedAt: '2026-03-01T00:01:00.000Z',
  score: score(72),
  ...over,
});

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status });
const notFound = json({ error: { code: 'NOT_FOUND', message: 'not analysed' } }, 404);
type Handler = (url: URL, init?: RequestInit) => Response;

function stubApi(routes: Record<string, Handler>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>((input, init) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      );
      const handler = routes[`${init?.method ?? 'GET'} ${url.pathname}`];
      if (handler) return Promise.resolve(handler(url, init));
      if (url.pathname === '/api/v1/me')
        return Promise.resolve(json({ error: { code: 'UNAUTHORIZED', message: 'x' } }, 401));
      if (url.pathname.endsWith('/ingestions/latest'))
        return Promise.resolve(json({ error: { code: 'NOT_FOUND', message: 'x' } }, 404));
      return Promise.reject(new TypeError('failed'));
    }),
  );
}

function renderRepo(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/repo/acme/tool']}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const base = '/api/v1/repos/acme/tool';
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Health dashboard', () => {
  it('shows the score, confidence, weights and per-metric evidence with its status', async () => {
    stubApi({
      [`GET ${base}`]: () => json(repo),
      [`GET ${base}/health`]: () => json(run()),
      [`GET ${base}/health/history`]: () => json({ items: [] }),
    });
    renderRepo();
    expect(await screen.findByLabelText('Score 72 out of 100')).toBeVisible();
    expect(screen.getByText(/80% of the total weight observed/)).toBeVisible();
    expect(screen.getByText(/10 measured, 10 inferred, 1 unavailable/)).toBeVisible();

    await userEvent.click(screen.getByRole('button', { name: /how is it computed/i }));
    expect(screen.getByText(/weight-averaged mean/)).toBeVisible();
    expect(screen.getByText(/codeQuality 15, security 15/)).toBeVisible();

    const architecture = screen.getByText('Architecture').closest('li');
    expect(architecture).not.toBeNull();
    expect(within(architecture as HTMLElement).getByLabelText('No score')).toBeVisible();
    await userEvent.click(
      within(architecture as HTMLElement).getByRole('button', { name: /show evidence/i }),
    );
    expect(within(architecture as HTMLElement).getByText('unavailable')).toBeVisible();
    expect(within(architecture as HTMLElement).getByText(/needs the module graph/)).toBeVisible();

    const security = screen.getByText('Security').closest('li') as HTMLElement;
    await userEvent.click(within(security).getByRole('button', { name: /show evidence/i }));
    expect(within(security).getByText('measured')).toBeVisible();
    expect(within(security).getByText('inferred')).toBeVisible();
    expect(within(security).getByText(/Evidence for Security/)).toBeVisible();
  });

  it('says when there is no overall number and why', async () => {
    stubApi({
      [`GET ${base}`]: () => json(repo),
      [`GET ${base}/health`]: () => json(run({ score: score(null) })),
      [`GET ${base}/health/history`]: () => json({ items: [] }),
    });
    renderRepo();
    expect(await screen.findByText(/not enough could be observed/i)).toBeVisible();
    // The overall badge and the architecture area both show no score.
    expect(screen.getAllByLabelText('No score').length).toBeGreaterThanOrEqual(2);
  });

  it('starts an analysis, shows live progress and the result when it finishes', async () => {
    let polls = 0;
    const states = [
      run({
        status: 'queued',
        progress: { step: 'queued', percent: 0, message: 'Waiting in the queue' },
        score: null,
      }),
      run({
        status: 'running',
        progress: { step: 'scanning', percent: 30, message: 'Scanning with the worker' },
        score: null,
      }),
      run(),
    ];
    let analysed = false;
    stubApi({
      'GET /api/v1/me': () => json({ user }),
      'GET /api/v1/me/analysis-quota': () =>
        json({ dailyLimit: 5, usedToday: analysed ? 1 : 0, running: 0, maxRunning: 1 }),
      [`GET ${base}`]: () => json(repo),
      [`GET ${base}/health`]: () => (analysed ? json(run()) : notFound.clone()),
      [`GET ${base}/health/history`]: () => json({ items: [] }),
      [`POST ${base}/analyze`]: () => json(states[0], 202),
      'GET /api/v1/analyses/r1': () => {
        const state = states[Math.min(polls, states.length - 1)] ?? run();
        polls += 1;
        if (state.status === 'succeeded') analysed = true;
        return json(state);
      },
    });
    renderRepo();
    expect(await screen.findByText(/has not been analysed yet/)).toBeVisible();
    expect(screen.getByText('0/5 analyses used today')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Analyse repository' }));
    expect(await screen.findByText(/Waiting in the queue/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeVisible();
    expect(
      await screen.findByText(/Scanning with the worker/, undefined, { timeout: 5000 }),
    ).toBeVisible();
    expect(
      await screen.findByLabelText('Score 72 out of 100', undefined, { timeout: 5000 }),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  }, 15_000);

  it('runs the simulator and shows the estimated change', async () => {
    stubApi({
      [`GET ${base}`]: () => json(repo),
      [`GET ${base}/health`]: () => json(run()),
      [`GET ${base}/health/history`]: () => json({ items: [] }),
      [`POST ${base}/health/simulate`]: (_url, init) => {
        const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
          addFiles: string[];
        };
        expect(body.addFiles).toEqual(['CONTRIBUTING']);
        return json({
          before: score(72),
          after: score(75),
          delta: {
            overall: 3,
            areas: Object.fromEntries(AREAS.map(([id]) => [id, id === 'documentation' ? 8 : 0])),
          },
          findingsResolved: 0,
          estimate: true,
        });
      },
    });
    renderRepo();
    await screen.findByLabelText('Score 72 out of 100');
    await userEvent.click(screen.getByLabelText(/add a contributing guide/i));
    await userEvent.click(screen.getByRole('button', { name: 'Estimate' }));
    const status = await screen.findByRole('status');
    expect(within(status).getByText('+3 overall')).toBeVisible();
    expect(within(status).getByText('Documentation: +8')).toBeVisible();
    expect(within(status).getByText(/estimate/)).toBeVisible();
  });

  it('draws history once there are two runs', async () => {
    const item = (runId: string, overall: number, day: string) => ({
      runId,
      sha: SHA,
      finishedAt: `2026-03-${day}T00:00:00.000Z`,
      overall,
      confidence: 0.8,
      areas: Object.fromEntries(AREAS.map(([id]) => [id, overall])),
    });
    stubApi({
      [`GET ${base}`]: () => json(repo),
      [`GET ${base}/health`]: () => json(run()),
      [`GET ${base}/health/history`]: () =>
        json({ items: [item('r2', 72, '02'), item('r1', 60, '01')] }),
    });
    renderRepo();
    expect(await screen.findByRole('img', { name: 'Score history: 60, 72' })).toBeVisible();
  });

  it('shows the server message when the analysis cannot start', async () => {
    stubApi({
      'GET /api/v1/me': () => json({ user }),
      'GET /api/v1/me/analysis-quota': () =>
        json({ dailyLimit: 5, usedToday: 5, running: 0, maxRunning: 1 }),
      [`GET ${base}`]: () => json(repo),
      [`GET ${base}/health`]: () => notFound.clone(),
      [`POST ${base}/analyze`]: () =>
        json(
          { error: { code: 'QUOTA_EXCEEDED', message: "You have used today's 5 analyses" } },
          429,
        ),
    });
    renderRepo();
    await userEvent.click(await screen.findByRole('button', { name: 'Analyse repository' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/today's 5 analyses/);
  });
});
