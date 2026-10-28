import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { signSession, verifySession } from './session.js';

const secret = 's'.repeat(40);

describe('session tokens', () => {
  it('round-trips the user id', async () => {
    expect(await verifySession(await signSession('user-1', secret), secret)).toBe('user-1');
  });

  it('rejects a token signed with another secret or garbage', async () => {
    const token = await signSession('user-1', secret);
    expect(await verifySession(token, 'x'.repeat(40))).toBeUndefined();
    expect(await verifySession('not-a-jwt', secret)).toBeUndefined();
  });

  it('rejects an expired token', async () => {
    const expired = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('user-1')
      .setIssuer('repointelligence')
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(new TextEncoder().encode(secret));
    expect(await verifySession(expired, secret)).toBeUndefined();
  });
});
