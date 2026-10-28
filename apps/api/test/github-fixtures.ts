import { vi } from 'vitest';

export const repoJson = {
  full_name: 'acme/tool',
  description: 'A tool',
  private: false,
  default_branch: 'main',
  language: 'TypeScript',
  stargazers_count: 42,
  html_url: 'https://github.com/acme/tool',
};

export function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(status === 304 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** A repository as GitHub's REST API returns it. */
export function rawRepo(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    full_name: 'acme/tool',
    description: 'A tool',
    private: false,
    default_branch: 'main',
    language: 'TypeScript',
    stargazers_count: 42,
    forks_count: 3,
    open_issues_count: 5,
    topics: ['cli', 'devtools'],
    license: { spdx_id: 'MIT' },
    pushed_at: new Date().toISOString(),
    created_at: '2020-01-01T00:00:00Z',
    size: 1200,
    archived: false,
    html_url: 'https://github.com/acme/tool',
    ...over,
  };
}

type Route = [RegExp, (url: string) => Response];

/** A fetch that answers by URL pattern; anything unmatched is a 404 like GitHub's. */
export function routedFetch(routes: Route[]): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>((input) => {
    const url = decodeURIComponent(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const match = routes.find(([pattern]) => pattern.test(url));
    return Promise.resolve(match ? match[1](url) : jsonResponse({ message: 'Not Found' }, 404));
  });
}
