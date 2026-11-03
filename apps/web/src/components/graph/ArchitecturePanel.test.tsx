import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ViewNode } from '@repointelligence/shared';
import { App } from '../../App';

// React Flow needs a real layout engine and Monaco loads from a CDN; neither belongs in jsdom.
vi.mock('./GraphCanvas', () => ({
  default: ({ nodes, onSelect }: { nodes: ViewNode[]; onSelect: (n: ViewNode) => void }) => (
    <ul data-testid="graph-canvas">
      {nodes.map((n) => (
        <li key={n.id}>
          <button
            type="button"
            onClick={() => {
              onSelect(n);
            }}
          >
            {n.label}
          </button>
        </li>
      ))}
    </ul>
  ),
}));
vi.mock('@monaco-editor/react', () => ({
  default: ({ value }: { value: string }) => <pre data-testid="monaco">{value}</pre>,
}));

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
    language: 'TypeScript',
    stars: 3,
    htmlUrl: 'https://github.com/acme/tool',
  },
  source: 'network',
};
const stats = {
  filesParsed: 6,
  filesSkipped: 0,
  parseErrors: 0,
  truncated: false,
  callEdgesTruncated: false,
  durationMs: 10,
};
const summary = {
  fullName: 'acme/tool',
  sha: SHA,
  computedAt: '2026-03-01T00:00:00.000Z',
  stats,
  stack: [{ name: 'Express', category: 'framework', version: '5.0.0', evidence: 'package.json' }],
  entryPoints: [
    {
      kind: 'entry',
      path: 'src/index.ts',
      line: 1,
      label: 'index.ts',
      evidence: 'conventional entry file name',
    },
  ],
  routes: [
    {
      method: 'GET',
      route: '/orders',
      path: 'src/routes/orders.ts',
      line: 5,
      framework: 'express',
      handler: 'src/routes/orders.ts#listOrders',
      middleware: ['requireAuth'],
    },
  ],
  models: [{ name: 'Order', path: 'src/models/order.ts', line: 4, orm: 'mongoose', kind: 'model' }],
  auth: [
    {
      kind: 'jwt',
      path: 'src/middleware/auth.ts',
      line: 1,
      label: 'jsonwebtoken',
      evidence: 'imports jsonwebtoken',
    },
  ],
  cycles: [['src/models/order.ts', 'src/services/orders.ts']],
  layerViolations: [
    {
      from: 'src/models/order.ts',
      to: 'src/services/orders.ts',
      fromLayer: 'data',
      toLayer: 'service',
      line: 2,
    },
  ],
  layers: { presentation: 1, service: 2, data: 1, integration: 1, config: 0, test: 0, other: 1 },
  folders: {
    path: '',
    name: '(root)',
    files: 6,
    lines: 100,
    layer: null,
    purpose: null,
    children: [
      {
        path: 'src',
        name: 'src',
        files: 6,
        lines: 100,
        layer: 'service',
        purpose: null,
        children: [
          {
            path: 'src/routes',
            name: 'routes',
            files: 1,
            lines: 40,
            layer: 'presentation',
            purpose: 'HTTP routes and request handlers',
            children: [],
          },
        ],
      },
    ],
  },
  detected: true,
};
const modulesView = {
  fullName: 'acme/tool',
  sha: SHA,
  view: 'modules',
  truncated: false,
  nodes: [
    {
      id: 'routes',
      label: 'routes',
      kind: 'module',
      layer: 'presentation',
      size: 1,
      path: 'src/routes',
      line: null,
      inCycle: false,
      detail: '1 file',
    },
  ],
  edges: [],
};
const filesView = {
  ...modulesView,
  view: 'files',
  nodes: [
    {
      id: 'src/routes/orders.ts',
      label: 'orders.ts',
      kind: 'file',
      layer: 'presentation',
      size: 40,
      path: 'src/routes/orders.ts',
      line: 1,
      inCycle: false,
      detail: '40 lines',
    },
  ],
};
const trace = {
  route: summary.routes[0],
  truncated: false,
  approximate: true,
  models: [summary.models[0]],
  steps: [
    {
      id: 'route',
      label: 'GET /orders',
      path: 'src/routes/orders.ts',
      line: 5,
      layer: 'presentation',
      kind: 'route',
      depth: 0,
    },
    {
      id: 'h',
      label: 'listOrders',
      path: 'src/routes/orders.ts',
      line: 5,
      layer: 'presentation',
      kind: 'call',
      depth: 1,
    },
    {
      id: 's',
      label: 'findAll',
      path: 'src/services/orders.ts',
      line: 3,
      layer: 'service',
      kind: 'call',
      depth: 2,
    },
  ],
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status });
const notFound = () => json({ error: { code: 'NOT_FOUND', message: 'x' } }, 404);
type Handler = (url: URL, init?: RequestInit) => Response;

function stubApi(routes: Record<string, Handler>): ReturnType<typeof vi.fn<typeof fetch>> {
  const fn = vi.fn<typeof fetch>((input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const handler = routes[`${init?.method ?? 'GET'} ${url.pathname}`];
    if (handler) return Promise.resolve(handler(url, init));
    if (url.pathname === '/api/v1/me')
      return Promise.resolve(json({ error: { code: 'UNAUTHORIZED', message: 'x' } }, 401));
    if (/\/(ingestions\/latest|health)$/.test(url.pathname)) return Promise.resolve(notFound());
    return Promise.reject(new TypeError(`unhandled ${url.pathname}`));
  });
  vi.stubGlobal('fetch', fn);
  return fn;
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

describe('Architecture panel', () => {
  it('shows the overview with stack, layers, entry points and cycles, and Mermaid export links', async () => {
    stubApi({
      [`GET ${base}`]: () => json(repo),
      [`GET ${base}/graph/latest`]: () => json(summary),
    });
    renderRepo();
    expect(await screen.findByText(/6 files parsed/)).toBeVisible();
    expect(screen.getByText('Express 5.0.0')).toBeVisible();
    expect(screen.getByText('service: 2 files')).toBeVisible();
    expect(screen.getByText(/src\/models\/order\.ts ↔ src\/services\/orders\.ts/)).toBeVisible();
    expect(screen.getByText(/1 import against the layer direction/)).toBeVisible();
    expect(screen.getByRole('link', { name: 'routes' })).toHaveAttribute(
      'href',
      expect.stringContaining(`/graph/${SHA}/mermaid?diagram=routes`),
    );
    expect(screen.getByText(/nothing here is verified by running the code/)).toBeVisible();
  });

  it('drills from modules to files and opens the source of a clicked file', async () => {
    stubApi({
      [`GET ${base}`]: () => json(repo),
      [`GET ${base}/graph/latest`]: () => json(summary),
      [`GET ${base}/graph/${SHA}/view`]: (url) =>
        json(url.searchParams.get('view') === 'files' ? filesView : modulesView),
      [`GET ${base}/source/${SHA}/src/routes/orders.ts`]: () =>
        json({
          path: 'src/routes/orders.ts',
          sha: SHA,
          content: 'router.get("/orders")',
          language: 'typescript',
          truncated: false,
          bytes: 21,
        }),
    });
    renderRepo();
    await userEvent.click(await screen.findByRole('tab', { name: 'Graph' }));
    const canvas = await screen.findByTestId('graph-canvas');
    await userEvent.click(within(canvas).getByRole('button', { name: 'routes' }));
    expect(await screen.findByText('src/routes')).toBeVisible();
    await userEvent.click(
      await within(await screen.findByTestId('graph-canvas')).findByRole('button', {
        name: 'orders.ts',
      }),
    );
    const viewer = await screen.findByLabelText('Source of src/routes/orders.ts');
    expect(await within(viewer).findByText('router.get("/orders")')).toBeVisible();
  });

  it('lists routes and traces one through the code to the model it reaches', async () => {
    stubApi({
      [`GET ${base}`]: () => json(repo),
      [`GET ${base}/graph/latest`]: () => json(summary),
      [`GET ${base}/graph/${SHA}/trace`]: (url) => {
        expect(url.searchParams.get('route')).toBe('GET /orders');
        return json(trace);
      },
    });
    renderRepo();
    await userEvent.click(await screen.findByRole('tab', { name: 'Routes' }));
    expect(screen.getByText('/orders')).toBeVisible();
    expect(screen.getByText('requireAuth')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Trace' }));
    const section = await screen.findByLabelText('Request trace');
    expect(within(section).getByText('findAll')).toBeVisible();
    expect(within(section).getByText(/Reaches Order\./)).toBeVisible();
    expect(within(section).getByText(/name-resolved calls only/)).toBeVisible();
  });

  it('shows the folder explorer with purposes', async () => {
    stubApi({
      [`GET ${base}`]: () => json(repo),
      [`GET ${base}/graph/latest`]: () => json(summary),
    });
    renderRepo();
    await userEvent.click(await screen.findByRole('tab', { name: 'Folders' }));
    await userEvent.click(screen.getByRole('button', { name: 'Expand src' }));
    expect(screen.getByText('HTTP routes and request handlers')).toBeVisible();
  });

  it('starts a build for a signed-in user and shows progress until it finishes', async () => {
    let polls = 0;
    let mapped = false;
    const runView = (status: string, percent: number, message: string) => ({
      id: 'g1',
      fullName: 'acme/tool',
      sha: SHA,
      status,
      progress: { step: status, percent, message },
      error: null,
      reused: false,
      summary: null,
    });
    stubApi({
      'GET /api/v1/me': () => json({ user }),
      [`GET ${base}`]: () => json(repo),
      [`GET ${base}/graph/latest`]: () => (mapped ? json(summary) : notFound()),
      [`POST ${base}/graph`]: () => json(runView('queued', 0, 'Waiting in the queue'), 202),
      'GET /api/v1/graph-builds/g1': () => {
        polls += 1;
        if (polls >= 2) mapped = true;
        return json(
          polls < 2
            ? runView('running', 30, 'Parsing with the worker')
            : runView('succeeded', 100, 'Finished: 6 files, 8 symbols'),
        );
      },
    });
    renderRepo();
    expect(await screen.findByText(/has not been mapped yet/)).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Map architecture' }));
    expect(
      await screen.findByText(/Parsing with the worker/, undefined, { timeout: 5000 }),
    ).toBeVisible();
    expect(await screen.findByText(/6 files parsed/, undefined, { timeout: 5000 })).toBeVisible();
  }, 15_000);

  it('compares with an earlier commit', async () => {
    const other = 'b'.repeat(40);
    stubApi({
      [`GET ${base}`]: () => json(repo),
      [`GET ${base}/graph/latest`]: () => json(summary),
      [`GET ${base}/graph/diff`]: (url) => {
        expect(url.searchParams.get('from')).toBe(other);
        expect(url.searchParams.get('to')).toBe(SHA);
        return json({
          from: other,
          to: SHA,
          files: { added: ['src/new.ts'], removed: [] },
          modules: { added: [], removed: [] },
          imports: { added: [{ from: 'a', to: 'b' }], removed: [] },
          externals: { added: [], removed: [] },
          routes: { added: ['GET /orders'], removed: [] },
          models: { added: [], removed: [] },
          cycles: { introduced: [summary.cycles[0]], resolved: [] },
          layerChanges: [],
          violations: { before: 0, after: 1 },
          stats: { filesBefore: 5, filesAfter: 6 },
        });
      },
    });
    renderRepo();
    await userEvent.click(await screen.findByRole('tab', { name: 'Compare' }));
    await userEvent.type(screen.getByLabelText(/compare with an earlier mapped commit/i), other);
    const changes = await screen.findByLabelText('Architecture changes');
    expect(within(changes).getAllByText('+1 / −0').length).toBe(2);
    expect(within(changes).getByText('1 introduced, 0 resolved')).toBeVisible();
    expect(within(changes).getByText('0 → 1')).toBeVisible();
  });
});
