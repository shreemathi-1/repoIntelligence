import request from 'supertest';
import { vi } from 'vitest';
import type { Config } from '../src/config.js';
import { createApp } from '../src/app.js';
import type { GithubService } from '../src/github/service.js';
import { createLogger } from '../src/logger.js';
import { authTestConfig } from './env.js';
import { jsonResponse } from './github-fixtures.js';

export const TOKEN = 'gho_plain_token';

function urlOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

/**
 * Fetch for the OAuth hops plus whatever API answers the test supplies. The OAuth answers
 * come first so a test route cannot shadow them.
 */
export function oauthFetch(
  githubId: number,
  api: (url: string) => Response | undefined,
): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>((input) => {
    const url = urlOf(input);
    if (url.includes('login/oauth/access_token')) {
      return Promise.resolve(jsonResponse({ access_token: TOKEN, scope: 'read:user' }));
    }
    if (url === 'https://api.github.com/user') {
      return Promise.resolve(jsonResponse({ id: githubId, login: `user${githubId}` }));
    }
    return Promise.resolve(
      api(decodeURIComponent(url)) ?? jsonResponse({ message: 'Not Found' }, 404),
    );
  });
}

export async function signInWith(options: {
  githubId?: number;
  api: (url: string) => Response | undefined;
  /** Builds the GitHub service around the same fetch the OAuth hops use. */
  makeGithub?: (fetchImpl: typeof fetch) => GithubService;
  config?: Config;
}) {
  const fetchMock = oauthFetch(options.githubId ?? 1, options.api);
  const config = options.config ?? authTestConfig;
  const app = createApp(config, createLogger(config), {
    fetch: fetchMock,
    ...(options.makeGithub && { github: options.makeGithub(fetchMock) }),
  });
  const agent = request.agent(app);
  const login = await agent.get('/api/v1/auth/github/login');
  const location = login.headers.location;
  if (typeof location !== 'string') throw new Error('expected a redirect');
  const state = new URL(location).searchParams.get('state');
  await agent.get(`/api/v1/auth/github/callback?code=abc&state=${state}`);
  return { app, agent, fetchMock };
}
