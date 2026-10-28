import { describe, expect, it } from 'vitest';
import { ConfigError, authConfigOf, loadConfig } from './config.js';

const base = { CLIENT_URL: 'http://localhost:5173', MONGODB_URI: 'mongodb://localhost/x' };

describe('loadConfig', () => {
  it('applies defaults', () => {
    const config = loadConfig(base);
    expect(config.PORT).toBe(4000);
    expect(config.NODE_ENV).toBe('development');
    expect(config.TRUST_PROXY).toBe(false);
  });

  it('treats blank optional values as unset', () => {
    const config = loadConfig({ ...base, WORKER_URL: '', WORKER_SHARED_SECRET: '' });
    expect(config.WORKER_URL).toBeUndefined();
    expect(config.WORKER_SHARED_SECRET).toBeUndefined();
  });

  it('fails fast when required variables are missing', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
  });

  it('rejects a short worker secret without echoing it', () => {
    const secret = 'short-secret';
    try {
      loadConfig({ ...base, WORKER_SHARED_SECRET: secret });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).message).toContain('WORKER_SHARED_SECRET');
      expect((err as ConfigError).message).not.toContain(secret);
    }
  });

  describe('auth settings', () => {
    const auth = {
      GITHUB_CLIENT_ID: 'id',
      GITHUB_CLIENT_SECRET: 'secret',
      GITHUB_CALLBACK_URL: 'http://localhost:4000/api/v1/auth/github/callback',
      JWT_SECRET: 'j'.repeat(32),
      TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
    };

    it('is optional when none of it is set', () => {
      expect(authConfigOf(loadConfig(base))).toBeUndefined();
    });

    it('loads when everything is set', () => {
      expect(authConfigOf(loadConfig({ ...base, ...auth }))?.tokenKey).toHaveLength(32);
    });

    it('rejects a partial setup', () => {
      expect(() => loadConfig({ ...base, GITHUB_CLIENT_ID: 'id' })).toThrow(/JWT_SECRET/);
    });

    it('rejects a weak JWT secret and a wrong-size key', () => {
      expect(() => loadConfig({ ...base, ...auth, JWT_SECRET: 'short' })).toThrow(ConfigError);
      expect(() => loadConfig({ ...base, ...auth, TOKEN_ENCRYPTION_KEY: 'AAAA' })).toThrow(
        ConfigError,
      );
    });
  });
});
