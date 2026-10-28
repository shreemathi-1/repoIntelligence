import type { RequestHandler } from 'express';
import { readCookie } from '../auth/cookies.js';
import { SESSION_COOKIE, verifySession } from '../auth/session.js';
import { AppError } from '../errors.js';
import { User } from '../models/user.js';

/** Resolves the session cookie to a user and puts the user id on `res.locals`. */
export function requireAuth(jwtSecret: string | undefined): RequestHandler {
  return async (req, res, next) => {
    const token = readCookie(req, SESSION_COOKIE);
    const userId = token && jwtSecret ? await verifySession(token, jwtSecret) : undefined;
    if (!userId || !(await User.exists({ _id: userId }).catch(() => null))) {
      next(AppError.unauthorized());
      return;
    }
    res.locals.userId = userId;
    next();
  };
}

/** Like requireAuth, but anonymous requests continue without a user id. */
export function optionalAuth(jwtSecret: string | undefined): RequestHandler {
  return async (req, res, next) => {
    const token = readCookie(req, SESSION_COOKIE);
    const userId = token && jwtSecret ? await verifySession(token, jwtSecret) : undefined;
    if (userId && (await User.exists({ _id: userId }).catch(() => null))) {
      res.locals.userId = userId;
    }
    next();
  };
}
