import { SignJWT, jwtVerify } from 'jose';

export const SESSION_COOKIE = 'ri_session';
export const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const ISSUER = 'repointelligence';

const encode = (secret: string): Uint8Array => new TextEncoder().encode(secret);

/** The token carries only the user id. */
export async function signSession(userId: string, secret: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(Math.floor((Date.now() + SESSION_MAX_AGE_MS) / 1000))
    .sign(encode(secret));
}

/** Returns the user id, or undefined for a missing, expired or tampered token. */
export async function verifySession(token: string, secret: string): Promise<string | undefined> {
  try {
    const { payload } = await jwtVerify(token, encode(secret), {
      issuer: ISSUER,
      algorithms: ['HS256'],
    });
    return payload.sub;
  } catch {
    return undefined;
  }
}
