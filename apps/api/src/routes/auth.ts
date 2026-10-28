import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { cookieOptions, readCookie } from '../auth/cookies.js';
import { authorizeUrl, exchangeCode, fetchProfile } from '../auth/github-oauth.js';
import { SESSION_COOKIE, SESSION_MAX_AGE_MS, signSession } from '../auth/session.js';
import { encryptToken } from '../auth/token-crypto.js';
import { authConfigOf, type Config } from '../config.js';
import { AppError } from '../errors.js';
import { User } from '../models/user.js';

const STATE_COOKIE = 'ri_oauth_state';
const STATE_MAX_AGE_MS = 10 * 60 * 1000;

const callbackQuery = z.object({ code: z.string().min(1), state: z.string().min(1) });
const loginQuery = z.object({ privateRepos: z.enum(['1', 'true']).optional() });

function sameValue(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function createAuthRouter(config: Config, fetchImpl: typeof fetch): Router {
  const router = Router();
  const auth = authConfigOf(config);
  const isProduction = config.NODE_ENV === 'production';

  router.use((_req, _res, next) => {
    next(auth ? undefined : AppError.authNotConfigured());
  });

  router.get('/github/login', (req, res) => {
    if (!auth) return;
    const { privateRepos } = loginQuery.parse(req.query);
    const state = randomBytes(24).toString('base64url');
    res.cookie(STATE_COOKIE, state, cookieOptions(isProduction, STATE_MAX_AGE_MS));
    res.redirect(authorizeUrl(auth, state, privateRepos !== undefined));
  });

  router.get('/github/callback', async (req, res) => {
    if (!auth) return;
    const { code, state } = callbackQuery.parse(req.query);
    const expected = readCookie(req, STATE_COOKIE);
    res.clearCookie(STATE_COOKIE, { path: '/' });
    if (!expected || !sameValue(state, expected)) {
      throw AppError.badRequest('Login state did not match, please try again');
    }

    const { accessToken, scopes } = await exchangeCode(auth, code, fetchImpl);
    const profile = await fetchProfile(accessToken, fetchImpl);
    const user = await User.findOneAndUpdate(
      { githubId: profile.githubId },
      {
        $set: {
          login: profile.login,
          avatarUrl: profile.avatarUrl,
          encryptedAccessToken: encryptToken(accessToken, auth.tokenKey),
          tokenScopes: scopes,
        },
      },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
    );

    const session = await signSession(user.id, auth.jwtSecret);
    res.cookie(SESSION_COOKIE, session, cookieOptions(isProduction, SESSION_MAX_AGE_MS));
    res.redirect(config.CLIENT_URL);
  });

  router.post('/logout', (_req, res) => {
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.status(204).end();
  });

  return router;
}
