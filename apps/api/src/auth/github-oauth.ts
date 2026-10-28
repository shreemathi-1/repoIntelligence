import { z } from 'zod';
import type { AuthConfig } from '../config.js';
import { AppError } from '../errors.js';

const profileSchema = z.object({
  id: z.number().int(),
  login: z.string().min(1),
  avatar_url: z.string().optional(),
});

const tokenSchema = z.object({
  access_token: z.string().min(1),
  scope: z.string().default(''),
});

export interface GithubProfile {
  githubId: number;
  login: string;
  avatarUrl?: string;
}

export function authorizeUrl(auth: AuthConfig, state: string, privateRepos: boolean): string {
  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', auth.clientId);
  url.searchParams.set('redirect_uri', auth.callbackUrl);
  url.searchParams.set('scope', privateRepos ? 'read:user repo' : 'read:user');
  url.searchParams.set('state', state);
  return url.toString();
}

export async function exchangeCode(
  auth: AuthConfig,
  code: string,
  fetchImpl: typeof fetch,
): Promise<{ accessToken: string; scopes: string[] }> {
  const response = await fetchImpl('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: auth.clientId,
      client_secret: auth.clientSecret,
      code,
      redirect_uri: auth.callbackUrl,
    }),
  }).catch(() => {
    throw AppError.upstream('Could not reach GitHub to finish login');
  });

  const payload: unknown = await response.json().catch(() => undefined);
  const parsed = tokenSchema.safeParse(payload);
  if (!response.ok || !parsed.success) {
    throw AppError.badRequest('GitHub rejected the login code');
  }
  const scopes = parsed.data.scope.split(/[\s,]+/).filter(Boolean);
  return { accessToken: parsed.data.access_token, scopes };
}

export async function fetchProfile(token: string, fetchImpl: typeof fetch): Promise<GithubProfile> {
  const response = await fetchImpl('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'repointelligence',
    },
  }).catch(() => {
    throw AppError.upstream('Could not reach GitHub to load your profile');
  });
  const parsed = profileSchema.safeParse(await response.json().catch(() => undefined));
  if (!response.ok || !parsed.success) {
    throw AppError.upstream('GitHub returned an unexpected profile');
  }
  return {
    githubId: parsed.data.id,
    login: parsed.data.login,
    ...(parsed.data.avatar_url !== undefined && { avatarUrl: parsed.data.avatar_url }),
  };
}
