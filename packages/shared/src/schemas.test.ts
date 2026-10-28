import { describe, expect, it } from 'vitest';
import { errorResponseSchema, healthResponseSchema, preferencesUpdateSchema } from './index.js';

const validHealth = {
  status: 'ok',
  service: 'api',
  version: '0.1.0',
  uptimeSeconds: 12.5,
  timestamp: '2026-01-01T00:00:00.000Z',
  checks: { database: 'up' },
};

describe('healthResponseSchema', () => {
  it('accepts a valid payload', () => {
    expect(healthResponseSchema.parse(validHealth)).toEqual(validHealth);
  });

  it('rejects an unknown status', () => {
    expect(healthResponseSchema.safeParse({ ...validHealth, status: 'fine' }).success).toBe(false);
  });

  it('rejects a negative uptime', () => {
    expect(healthResponseSchema.safeParse({ ...validHealth, uptimeSeconds: -1 }).success).toBe(
      false,
    );
  });
});

describe('errorResponseSchema', () => {
  it('accepts an error with a request id', () => {
    const body = { error: { code: 'NOT_FOUND', message: 'No such route', requestId: 'abc' } };
    expect(errorResponseSchema.parse(body)).toEqual(body);
  });

  it('requires a message', () => {
    expect(errorResponseSchema.safeParse({ error: { code: 'X' } }).success).toBe(false);
  });
});

describe('preferencesUpdateSchema', () => {
  it('accepts a partial update', () => {
    expect(preferencesUpdateSchema.parse({ theme: 'dark' })).toEqual({ theme: 'dark' });
  });

  it('rejects an empty update and unknown keys', () => {
    expect(preferencesUpdateSchema.safeParse({}).success).toBe(false);
    expect(preferencesUpdateSchema.safeParse({ role: 'admin' }).success).toBe(false);
  });
});
