import type { CookieOptions, Request } from 'express';

export function readCookie(req: Request, name: string): string | undefined {
  const cookies: unknown = req.cookies;
  if (typeof cookies !== 'object' || cookies === null) return undefined;
  const value = (cookies as Record<string, unknown>)[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export function cookieOptions(isProduction: boolean, maxAgeMs: number): CookieOptions {
  return { httpOnly: true, sameSite: 'lax', secure: isProduction, path: '/', maxAge: maxAgeMs };
}
