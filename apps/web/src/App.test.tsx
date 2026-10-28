import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

const health = {
  status: 'ok',
  service: 'repointelligence-api',
  version: '0.1.0',
  uptimeSeconds: 5,
  timestamp: '2026-01-01T00:00:00.000Z',
  checks: { database: 'up' },
};

const signedOut = { error: { code: 'UNAUTHORIZED', message: 'Authentication required' } };

const user = {
  id: 'u1',
  login: 'octocat',
  preferences: { theme: 'system', privateRepoAccess: false },
  privateRepoScope: false,
};

/** Routes fetch by path so the layout's /me call never hits the health mock. */
function stubApi(routes: Record<string, () => Response>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      );
      const key = `${init?.method ?? 'GET'} ${url.pathname}`;
      const handler = routes[key];
      if (handler) return Promise.resolve(handler());
      if (url.pathname === '/api/v1/me') return Promise.resolve(json(signedOut, 401));
      return Promise.reject(new TypeError('failed'));
    }),
  );
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
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

describe('App', () => {
  it('renders the home page inside the layout', () => {
    stubApi({});
    renderAt('/');
    expect(
      screen.getByRole('heading', { name: /understand any github repository/i }),
    ).toBeVisible();
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeVisible();
  });

  it('shows the API status on the health page', async () => {
    stubApi({ 'GET /health': () => json(health) });
    renderAt('/health');
    expect(await screen.findByText('repointelligence-api')).toBeVisible();
    expect(screen.getByText('ok')).toBeVisible();
  });

  it('shows an alert when the API is unreachable', async () => {
    stubApi({});
    renderAt('/health');
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not reach the api/i);
  });

  it('shows a not found page for unknown routes', () => {
    stubApi({});
    renderAt('/nowhere');
    expect(screen.getByRole('heading', { name: /page not found/i })).toBeVisible();
  });

  it('offers sign in when signed out and protects the settings page', async () => {
    stubApi({});
    renderAt('/settings');
    expect(await screen.findByRole('heading', { name: /sign in required/i })).toBeVisible();
    const links = screen.getAllByRole('link', { name: /sign in with github/i });
    expect(links[0]).toHaveAttribute('href', expect.stringContaining('/api/v1/auth/github/login'));
  });

  it('shows the signed-in user and signs out', async () => {
    let signedIn = true;
    stubApi({
      'GET /api/v1/me': () => (signedIn ? json({ user }) : json(signedOut, 401)),
      'POST /api/v1/auth/logout': () => {
        signedIn = false;
        return new Response(null, { status: 204 });
      },
    });
    renderAt('/');
    expect(await screen.findByText('octocat')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: /sign out/i }));
    expect(await screen.findByRole('link', { name: /sign in with github/i })).toBeVisible();
  });

  it('saves a preference from the settings page', async () => {
    const patch = vi.fn(() => json({ ...user.preferences, theme: 'dark' }));
    stubApi({ 'GET /api/v1/me': () => json({ user }), 'PATCH /api/v1/me/preferences': patch });
    renderAt('/settings');
    await userEvent.click(await screen.findByRole('button', { name: 'dark' }));
    expect(patch).toHaveBeenCalledOnce();
    const call = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === 'PATCH');
    expect(call?.[1]?.body).toBe(JSON.stringify({ theme: 'dark' }));
    expect(call?.[1]?.credentials).toBe('include');
  });
});
