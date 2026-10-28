import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptToken, encryptToken } from './token-crypto.js';

const key = randomBytes(32);

describe('token crypto', () => {
  it('round-trips a token', () => {
    expect(decryptToken(encryptToken('gho_secret', key), key)).toBe('gho_secret');
  });

  it('uses a fresh IV each time and never contains the plaintext', () => {
    const a = encryptToken('gho_secret', key);
    const b = encryptToken('gho_secret', key);
    expect(a).not.toBe(b);
    expect(a.startsWith('v1:')).toBe(true);
    expect(a).not.toContain('gho_secret');
  });

  it('rejects a tampered payload', () => {
    const [version, iv, tag, data] = encryptToken('gho_secret', key).split(':');
    const flipped = Buffer.from(data ?? '', 'base64');
    flipped[0] = (flipped[0] ?? 0) ^ 1;
    expect(() =>
      decryptToken([version, iv, tag, flipped.toString('base64')].join(':'), key),
    ).toThrow();
  });

  it('rejects the wrong key and unknown formats', () => {
    const payload = encryptToken('gho_secret', key);
    expect(() => decryptToken(payload, randomBytes(32))).toThrow();
    expect(() => decryptToken('v2:a:b:c', key)).toThrow(/Unsupported/);
  });
});
