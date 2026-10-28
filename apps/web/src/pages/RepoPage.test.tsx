import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';

const SHA = 'a'.repeat(40);

const repo = {
  repo: {
    fullName: 'acme/tool',
    description: 'A handy tool',
    private: false,
    defaultBranch: 'main',
    language: 'TypeScript',
    stars: 12,
    htmlUrl: 'https://github.com/acme/tool',
  },
  source: 'network',
};

const stats = {
  filesInTree: 10,
  filesIngested: 7,
  bytesIngested: 1000,
  skipped: {},
  chunks: 14,
  duplicatesRemoved: 2,
  symbols: 5,
  brokenLinks: 1,
  findings: 6,
  durationMs: 900,
  truncated: [] as string[],
};

const run = (over: Record<string, unknown> = {}) => ({
  fullName: 'acme/tool',
  sha: SHA,
  ref: 'main',
  status: 'completed',
  private: false,
  startedAt: '2026-03-01T00:00:00.000Z',
  completedAt: '2026-03-01T00:00:01.000Z',
  stats,
  error: null,
  reused: false,
  ...over,
});

const user = {
  id: 'u1',
  login: 'octocat',
  preferences: { theme: 'system', privateRepoAccess: false },
  privateRepoScope: false,
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status });
const notFound = { error: { code: 'NOT_FOUND', message: 'No ingestion found' } };
const signedOut = { error: { code: 'UNAUTHORIZED', message: 'Authentication required' } };

type Handler = (url: URL, init?: RequestInit) => Response;

function stubApi(routes: Record<string, Handler>): ReturnType<typeof vi.fn<typeof fetch>> {
  const fn = vi.fn<typeof fetch>((input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const handler = routes[`${init?.method ?? 'GET'} ${url.pathname}`];
    if (handler) return Promise.resolve(handler(url, init));
    if (url.pathname === '/api/v1/me') return Promise.resolve(json(signedOut, 401));
    return Promise.reject(new TypeError('failed'));
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

describe('Repository page', () => {
  it('invites a signed-out visitor to sign in before ingesting', async () => {
    stubApi({
      [`GET ${base}`]: () => json(repo),
      [`GET ${base}/ingestions/latest`]: () => json(notFound, 404),
    });
    renderRepo();
    expect(await screen.findByText('A handy tool')).toBeVisible();
    expect(await screen.findByText(/has not been ingested yet/i)).toBeVisible();
    expect(screen.getByRole('link', { name: /sign in to ingest/i })).toBeVisible();
  });

  it('ingests for a signed-in user and shows the result', async () => {
    let ingested = false;
    const fetchMock = stubApi({
      'GET /api/v1/me': () => json({ user }),
      [`GET ${base}`]: () => json(repo),
      [`GET ${base}/ingestions/latest`]: () => (ingested ? json(run()) : json(notFound, 404)),
      [`GET ${base}/freshness`]: () =>
        json({ ingestedSha: SHA, ingestedAt: null, headSha: SHA, fresh: true, commitsBehind: 0 }),
      [`POST ${base}/ingest`]: () => {
        ingested = true;
        return json(run(), 201);
      },
    });
    renderRepo();
    await userEvent.click(await screen.findByRole('button', { name: 'Ingest repository' }));
    expect(await screen.findByText('aaaaaaaaaaaa')).toBeVisible();
    expect(screen.getByText('14 chunks')).toBeVisible();
    expect(screen.getByText('1 broken links')).toBeVisible();
    expect(await screen.findByText(/up to date/i)).toBeVisible();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true);
  });

  it('offers all four downloads pinned to the ingested commit', async () => {
    stubApi({
      'GET /api/v1/me': () => json({ user }),
      [`GET ${base}`]: () => json(repo),
      [`GET ${base}/ingestions/latest`]: () => json(run()),
      [`GET ${base}/freshness`]: () =>
        json({ ingestedSha: SHA, ingestedAt: null, headSha: SHA, fresh: true, commitsBehind: 0 }),
    });
    renderRepo();
    const list = await screen.findByRole('list', { name: '' }).catch(() => null);
    expect(list).toBeNull();
    const bundle = await screen.findByRole('link', { name: 'LLM context bundle' });
    expect(bundle).toHaveAttribute(
      'href',
      expect.stringContaining(`/ingestions/${SHA}/export?format=bundle`),
    );
    for (const label of ['Markdown', 'JSON', 'Plain text']) {
      expect(screen.getByRole('link', { name: label })).toHaveAttribute(
        'href',
        expect.stringContaining(SHA),
      );
    }
    expect(screen.getByText(/data, not instructions/i)).toBeVisible();
  });

  it('tells the user when the repository has moved on and offers the latest commit', async () => {
    stubApi({
      'GET /api/v1/me': () => json({ user }),
      [`GET ${base}`]: () => json(repo),
      [`GET ${base}/ingestions/latest`]: () => json(run()),
      [`GET ${base}/freshness`]: () =>
        json({
          ingestedSha: SHA,
          ingestedAt: null,
          headSha: 'b'.repeat(40),
          fresh: false,
          commitsBehind: 3,
        }),
    });
    renderRepo();
    expect(await screen.findByText('3 commits behind the default branch.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Ingest latest commit' })).toBeVisible();
  });

  it('explains why a result is partial', async () => {
    stubApi({
      'GET /api/v1/me': () => json({ user }),
      [`GET ${base}`]: () => json(repo),
      [`GET ${base}/ingestions/latest`]: () =>
        json(
          run({
            status: 'partial',
            stats: { ...stats, truncated: ['time-limit', 'tree-truncated'] },
          }),
        ),
      [`GET ${base}/freshness`]: () =>
        json({
          ingestedSha: SHA,
          ingestedAt: null,
          headSha: null,
          fresh: null,
          commitsBehind: null,
        }),
    });
    renderRepo();
    const notes = await screen.findAllByRole('note');
    expect(notes).toHaveLength(2);
    const [first] = notes;
    if (!first) throw new Error('expected a note');
    expect(within(first).getByText(/time limit/i)).toBeVisible();
    expect(await screen.findByText(/could not compare with the default branch/i)).toBeVisible();
  });

  it('shows the server message when ingestion fails', async () => {
    stubApi({
      'GET /api/v1/me': () => json({ user }),
      [`GET ${base}`]: () => json(repo),
      [`GET ${base}/ingestions/latest`]: () => json(notFound, 404),
      [`POST ${base}/ingest`]: () =>
        json(
          {
            error: { code: 'RATE_LIMITED', message: 'GitHub rate limit reached, try again later' },
          },
          429,
        ),
    });
    renderRepo();
    await userEvent.click(await screen.findByRole('button', { name: 'Ingest repository' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/rate limit reached/i);
  });

  it('says so when the repository does not exist', async () => {
    stubApi({
      [`GET ${base}`]: () =>
        json({ error: { code: 'NOT_FOUND', message: 'Not found on GitHub' } }, 404),
    });
    renderRepo();
    expect(await screen.findByRole('heading', { name: /repository not found/i })).toBeVisible();
  });
});
