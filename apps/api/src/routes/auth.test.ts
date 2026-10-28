import mongoose from 'mongoose';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  errorResponseSchema,
  meResponseSchema,
  repoResponseSchema,
} from '@repointelligence/shared';
import { useMemoryDb } from '../../test/db.js';
import { authTestConfig, testConfig } from '../../test/env.js';
import { jsonResponse, repoJson } from '../../test/github-fixtures.js';
import { createApp } from '../app.js';
import { decryptToken } from '../auth/token-crypto.js';
import { createLogger } from '../logger.js';
import { User } from '../models/user.js';

useMemoryDb();

const logger = createLogger(authTestConfig);
const TOKEN = 'gho_plain_token';

function locationOf(res: { headers: Record<string, unknown> }): string {
  const location = res.headers.location;
  if (typeof location !== 'string') throw new Error('expected a redirect');
  return location;
}

function urlOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

function githubFetch(scope = 'read:user'): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>((input) => {
    const url = urlOf(input);
    if (url.includes('login/oauth/access_token')) {
      return Promise.resolve(jsonResponse({ access_token: TOKEN, scope }));
    }
    if (url === 'https://api.github.com/user') {
      return Promise.resolve(
        jsonResponse({ id: 99, login: 'octocat', avatar_url: 'https://a/b.png' }),
      );
    }
    if (url.includes('/repos/acme/private-one')) {
      return Promise.resolve(jsonResponse({ message: 'Not Found' }, 404));
    }
    return Promise.resolve(jsonResponse(repoJson));
  });
}

/** Runs the whole login flow and returns an agent holding the session cookie. */
async function signIn(fetchMock = githubFetch()) {
  const app = createApp(authTestConfig, logger, { fetch: fetchMock });
  const agent = request.agent(app);
  const login = await agent.get('/api/v1/auth/github/login');
  const state = new URL(locationOf(login)).searchParams.get('state');
  const callback = await agent.get(`/api/v1/auth/github/callback?code=abc&state=${state}`);
  return { app, agent, login, callback, fetchMock };
}

beforeEach(async () => {
  await mongoose.connection.collection('users').deleteMany({});
  await mongoose.connection.collection('githubcaches').deleteMany({});
});

describe('auth not configured', () => {
  it('returns 503 AUTH_NOT_CONFIGURED for auth routes', async () => {
    const app = createApp(testConfig, createLogger(testConfig));
    const res = await request(app).get('/api/v1/auth/github/login');
    expect(res.status).toBe(503);
    expect(errorResponseSchema.parse(res.body).error.code).toBe('AUTH_NOT_CONFIGURED');
  });

  it('keeps protected routes closed', async () => {
    const app = createApp(testConfig, createLogger(testConfig));
    expect((await request(app).get('/api/v1/me')).status).toBe(401);
  });
});

describe('GitHub login', () => {
  it('redirects to GitHub with a state, minimal scope and an httpOnly state cookie', async () => {
    const { login } = await signIn();
    const url = new URL(locationOf(login));
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(url.searchParams.get('scope')).toBe('read:user');
    expect(url.searchParams.get('state')).toBeTruthy();
    expect(String(login.headers['set-cookie'])).toMatch(/ri_oauth_state=.*HttpOnly/);
  });

  it('asks for the repo scope only on opt-in', async () => {
    const app = createApp(authTestConfig, logger, { fetch: githubFetch() });
    const res = await request(app).get('/api/v1/auth/github/login?privateRepos=1');
    expect(new URL(locationOf(res)).searchParams.get('scope')).toBe('read:user repo');
  });

  it('creates the user, encrypts the token and sets a session cookie', async () => {
    const { callback } = await signIn();
    expect(callback.status).toBe(302);
    expect(callback.headers.location).toBe(authTestConfig.CLIENT_URL);
    expect(String(callback.headers['set-cookie'])).toMatch(/ri_session=.*HttpOnly/);

    const user = await User.findOne({ githubId: 99 }).select('+encryptedAccessToken');
    expect(user?.encryptedAccessToken).toBeTruthy();
    expect(user?.encryptedAccessToken).not.toContain(TOKEN);
    const key = Buffer.alloc(32, 7);
    expect(decryptToken(user?.encryptedAccessToken ?? '', key)).toBe(TOKEN);
  });

  it('rejects a callback whose state does not match', async () => {
    const app = createApp(authTestConfig, logger, { fetch: githubFetch() });
    const agent = request.agent(app);
    await agent.get('/api/v1/auth/github/login');
    const res = await agent.get('/api/v1/auth/github/callback?code=abc&state=forged');
    expect(res.status).toBe(400);
    expect(await User.countDocuments()).toBe(0);
  });

  it('rejects a callback with no state cookie', async () => {
    const app = createApp(authTestConfig, logger, { fetch: githubFetch() });
    const res = await request(app).get('/api/v1/auth/github/callback?code=abc&state=x');
    expect(res.status).toBe(400);
  });
});

describe('session and preferences', () => {
  it('returns the signed-in user without any token material', async () => {
    const { agent } = await signIn();
    const res = await agent.get('/api/v1/me');
    expect(res.status).toBe(200);
    const body = meResponseSchema.parse(res.body);
    expect(body.user.login).toBe('octocat');
    expect(body.user.privateRepoScope).toBe(false);
    expect(JSON.stringify(res.body)).not.toMatch(/token/i);
  });

  it('rejects requests without a valid session', async () => {
    const app = createApp(authTestConfig, logger);
    expect((await request(app).get('/api/v1/me')).status).toBe(401);
    const forged = await request(app).get('/api/v1/me').set('Cookie', 'ri_session=nope');
    expect(forged.status).toBe(401);
  });

  it('updates preferences and validates input', async () => {
    const { agent } = await signIn();
    const ok = await agent
      .patch('/api/v1/me/preferences')
      .send({ theme: 'dark', privateRepoAccess: true });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ theme: 'dark', privateRepoAccess: true });
    expect((await agent.get('/api/v1/me/preferences')).body).toMatchObject({ theme: 'dark' });

    expect((await agent.patch('/api/v1/me/preferences').send({ theme: 'neon' })).status).toBe(400);
    expect((await agent.patch('/api/v1/me/preferences').send({ role: 'admin' })).status).toBe(400);
  });

  it('logs out by clearing the cookie', async () => {
    const { agent } = await signIn();
    const out = await agent.post('/api/v1/auth/logout');
    expect(out.status).toBe(204);
    expect((await agent.get('/api/v1/me')).status).toBe(401);
  });
});

describe('GET /repos/:owner/:name', () => {
  it('serves public repositories to anonymous visitors without a session', async () => {
    const app = createApp(authTestConfig, logger, { fetch: githubFetch() });
    const res = await request(app).get('/api/v1/repos/acme/tool');
    expect(res.status).toBe(200);
    expect(repoResponseSchema.parse(res.body).repo.fullName).toBe('acme/tool');
  });

  it('fetches with the user token, then serves repeats from the cache', async () => {
    const { agent, fetchMock } = await signIn();
    const first = await agent.get('/api/v1/repos/acme/tool');
    expect(repoResponseSchema.parse(first.body).source).toBe('network');
    const second = await agent.get('/api/v1/repos/acme/tool');
    expect(repoResponseSchema.parse(second.body).source).toBe('cache');

    const repoCalls = fetchMock.mock.calls.filter(([input]) =>
      urlOf(input).includes('/repos/acme/tool'),
    );
    expect(repoCalls).toHaveLength(1);
    expect(new Headers(repoCalls[0]?.[1]?.headers).get('authorization')).toBe(`token ${TOKEN}`);
  });

  it('blocks repositories the user cannot access with a 404', async () => {
    const { agent } = await signIn();
    const res = await agent.get('/api/v1/repos/acme/private-one');
    expect(res.status).toBe(404);
    expect(errorResponseSchema.parse(res.body).error.code).toBe('NOT_FOUND');
  });

  it('validates owner and name', async () => {
    const { agent } = await signIn();
    expect((await agent.get('/api/v1/repos/acme/bad%20name')).status).toBe(400);
  });
});
