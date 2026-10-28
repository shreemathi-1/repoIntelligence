import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { saveRepoSchema } from '@repointelligence/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';

const license = (spdxId: string | null, category: string, flags: string[] = []) => ({
  spdxId,
  category,
  flags,
});

const card = (over: Record<string, unknown> = {}) => ({
  fullName: 'acme/tool',
  description: 'A handy tool',
  language: 'TypeScript',
  stars: 1234,
  forks: 56,
  openIssues: 7,
  topics: [],
  license: license('MIT', 'permissive'),
  pushedAt: '2026-03-01T00:00:00Z',
  createdAt: '2020-01-01T00:00:00Z',
  sizeKb: 100,
  archived: false,
  htmlUrl: 'https://github.com/acme/tool',
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
function bodyOf(init?: RequestInit): unknown {
  return JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
}

const signedOut = { error: { code: 'UNAUTHORIZED', message: 'Authentication required' } };

type Handler = (url: URL, init?: RequestInit) => Response;

/** Answers by method and path. /me is signed out unless a route says otherwise. */
function stubApi(routes: Record<string, Handler>): ReturnType<typeof vi.fn> {
  const fn = vi.fn((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
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

function renderAt(path: string): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Search page', () => {
  it('asks for a criterion before searching', () => {
    const fetchMock = stubApi({});
    renderAt('/search');
    expect(screen.getByText(/enter a keyword or pick a filter/i)).toBeVisible();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/search'))).toBe(false);
  });

  it('searches with the chosen filters and shows results with license flags', async () => {
    const fetchMock = stubApi({
      'GET /api/v1/search': () =>
        json({
          items: [
            card(),
            card({
              fullName: 'acme/copyleft',
              license: license('AGPL-3.0', 'network-copyleft', ['Also applies to network use']),
            }),
          ],
          totalCount: 2,
          incomplete: false,
          page: 1,
          perPage: 20,
          query: 'cli',
        }),
    });
    renderAt('/search');
    await userEvent.type(screen.getByLabelText('Keywords'), 'cli');
    await userEvent.type(screen.getByLabelText('Language'), 'typescript');
    await userEvent.click(screen.getByRole('button', { name: 'Search' }));

    expect(await screen.findByText('acme/tool')).toBeVisible();
    expect(screen.getByText('2 results')).toBeVisible();
    expect(screen.getByText('AGPL-3.0')).toHaveAttribute(
      'title',
      expect.stringContaining('network'),
    );
    const call = fetchMock.mock.calls.find(([url]) => String(url).includes('/api/v1/search'));
    expect(String(call?.[0])).toContain('q=cli');
    expect(String(call?.[0])).toContain('language=typescript');
  });

  it('shows a friendly message when GitHub is rate limiting', async () => {
    stubApi({
      'GET /api/v1/search': () => json({ error: { code: 'RATE_LIMITED', message: 'x' } }, 429),
    });
    renderAt('/search?q=cli');
    expect(await screen.findByRole('alert')).toHaveTextContent(/limiting searches/i);
  });

  it('finds good first issues', async () => {
    stubApi({
      'GET /api/v1/contribute': () =>
        json({
          totalCount: 1,
          items: [
            {
              repo: 'acme/tool',
              number: 7,
              title: 'Fix the typo',
              htmlUrl: 'https://github.com/acme/tool/issues/7',
              labels: ['good first issue'],
              comments: 2,
              createdAt: '2026-01-01T00:00:00Z',
            },
          ],
        }),
    });
    renderAt('/search');
    await userEvent.click(screen.getByRole('tab', { name: /good first issues/i }));
    await userEvent.click(screen.getByRole('button', { name: /find issues/i }));
    expect(await screen.findByText('Fix the typo')).toBeVisible();
  });

  it('lets a signed-in user save a result', async () => {
    const saved: string[] = [];
    stubApi({
      'GET /api/v1/me': () => json({ user }),
      'GET /api/v1/me/saved': () => json({ items: [] }),
      'POST /api/v1/me/saved': (_url, init) => {
        saved.push(saveRepoSchema.parse(bodyOf(init)).fullName);
        return json({ fullName: 'acme/tool' }, 201);
      },
      'GET /api/v1/search': () =>
        json({
          items: [card()],
          totalCount: 1,
          incomplete: false,
          page: 1,
          perPage: 20,
          query: 'cli',
        }),
    });
    renderAt('/search?q=cli');
    await userEvent.click(await screen.findByRole('button', { name: 'Save acme/tool' }));
    expect(saved).toEqual(['acme/tool']);
  });
});

describe('Trending page', () => {
  const topics = {
    technologies: [{ id: 'react', label: 'React' }],
    useCases: [{ id: 'rag', label: 'RAG' }],
  };

  it('says when a list has not been computed, rather than showing nothing', async () => {
    stubApi({
      'GET /api/v1/trending/topics': () => json(topics),
      'GET /api/v1/trending': () =>
        json({ period: 'weekly', topic: null, computedAt: null, estimate: true, items: [] }),
    });
    renderAt('/trending');
    expect(await screen.findByText(/has not been computed yet/i)).toBeVisible();
  });

  it('shows the list and reloads when the period and topic change', async () => {
    const fetchMock = stubApi({
      'GET /api/v1/trending/topics': () => json(topics),
      'GET /api/v1/trending': () =>
        json({
          period: 'weekly',
          topic: null,
          computedAt: '2026-03-01T03:00:00.000Z',
          estimate: true,
          items: [{ repo: card(), score: 12 }],
        }),
    });
    renderAt('/trending');
    expect(await screen.findByText('acme/tool')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'daily' }));
    await userEvent.selectOptions(screen.getByLabelText('Topic'), 'rag');
    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls.some((u) => u.includes('period=daily'))).toBe(true);
    expect(urls.some((u) => u.includes('topic=rag'))).toBe(true);
  });
});

describe('Compare page', () => {
  it('compares repositories side by side and marks missing data as unavailable', async () => {
    stubApi({
      'GET /api/v1/compare': () =>
        json({
          items: [
            {
              fullName: 'acme/tool',
              status: 'ok',
              repo: card(),
              beginner: { score: 80, confidence: 0.9, signals: [] },
              commitsLast4Weeks: 12,
            },
            {
              fullName: 'acme/gone',
              status: 'not_found',
              repo: null,
              beginner: null,
              commitsLast4Weeks: null,
            },
          ],
        }),
    });
    renderAt('/compare?repos=acme/tool,acme/gone');
    const table = await screen.findByRole('table');
    expect(within(table).getByText('80/100')).toBeVisible();
    expect(within(table).getByText('not found')).toBeVisible();
    expect(within(table).getAllByText('unavailable').length).toBeGreaterThan(0);
  });

  it('asks for a second repository', () => {
    stubApi({});
    renderAt('/compare?repos=acme/tool');
    expect(screen.getByText(/add at least one more/i)).toBeVisible();
  });
});

describe('Saved page', () => {
  it('requires sign in', async () => {
    stubApi({});
    renderAt('/saved');
    expect(await screen.findByRole('heading', { name: /sign in required/i })).toBeVisible();
  });

  it('shows saved repos, collections, watch changes and history', async () => {
    stubApi({
      'GET /api/v1/me': () => json({ user }),
      'GET /api/v1/me/saved': () =>
        json({
          items: [
            {
              fullName: 'acme/tool',
              description: 'A handy tool',
              language: 'TypeScript',
              stars: 5,
              note: null,
              savedAt: '2026-03-01T00:00:00Z',
              collections: ['CLI'],
            },
          ],
        }),
      'GET /api/v1/me/collections': () =>
        json({
          items: [{ id: 'c1', name: 'CLI', description: null, repositories: ['acme/tool'] }],
        }),
      'GET /api/v1/me/watchlist': () =>
        json({ items: [{ fullName: 'acme/tool', addedAt: '2026-03-01T00:00:00Z' }] }),
      'GET /api/v1/me/watchlist/changes': () =>
        json({
          items: [
            {
              fullName: 'acme/tool',
              status: 'ok',
              latestRelease: 'v2',
              latestCommitSha: 'abc',
              latestCommitAt: null,
              openIssues: 9,
              newRelease: true,
              newCommits: null,
              openIssuesDelta: 2,
            },
          ],
        }),
      'GET /api/v1/me/history': () =>
        json({
          items: [
            { id: 'h1', kind: 'search', query: 'cli', fullName: null, at: '2026-03-01T00:00:00Z' },
          ],
        }),
    });
    renderAt('/saved');
    expect(await screen.findByText('Saved repositories')).toBeVisible();
    expect(await screen.findByText('In: CLI')).toBeVisible();
    expect(await screen.findByText('CLI', { selector: 'span' })).toBeVisible();

    await userEvent.click(screen.getByRole('button', { name: /check for changes/i }));
    expect(await screen.findByText(/new release/i)).toBeVisible();
    expect(screen.getByText(/Commits: nothing to compare yet/i)).toBeVisible();
    expect(screen.getByText(/\(\+2\)/)).toBeVisible();
    expect(screen.getByText('cli')).toBeVisible();
  });

  it('creates a collection', async () => {
    const created: unknown[] = [];
    stubApi({
      'GET /api/v1/me': () => json({ user }),
      'GET /api/v1/me/saved': () => json({ items: [] }),
      'GET /api/v1/me/collections': () => json({ items: [] }),
      'GET /api/v1/me/watchlist': () => json({ items: [] }),
      'GET /api/v1/me/history': () => json({ items: [] }),
      'POST /api/v1/me/collections': (_url, init) => {
        created.push(bodyOf(init));
        return json({ id: 'c2' }, 201);
      },
    });
    renderAt('/saved');
    await userEvent.type(await screen.findByLabelText('New collection name'), 'Weekend');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(created).toEqual([{ name: 'Weekend' }]);
  });
});
