import { healthResponseSchema } from '@repointelligence/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiGet } from './api-client';

const health = {
  status: 'ok',
  service: 'api',
  version: '0.1.0',
  uptimeSeconds: 1,
  timestamp: '2026-01-01T00:00:00.000Z',
  checks: { database: 'up' },
};

function mockFetch(body: unknown, status = 200): void {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status })));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('apiGet', () => {
  it('returns a validated body', async () => {
    mockFetch(health);
    await expect(apiGet('/health', healthResponseSchema)).resolves.toEqual(health);
  });

  it('sends cookies with every request', async () => {
    mockFetch(health);
    await apiGet('/health', healthResponseSchema);
    expect(vi.mocked(fetch).mock.calls[0]?.[1]).toMatchObject({ credentials: 'include' });
  });

  it('turns an error body into an ApiError', async () => {
    mockFetch({ error: { code: 'NOT_FOUND', message: 'Route not found', requestId: 'r1' } }, 404);
    await expect(apiGet('/nope', healthResponseSchema)).rejects.toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
      requestId: 'r1',
    });
  });

  it('rejects a body that does not match the schema', async () => {
    mockFetch({ status: 'ok' });
    await expect(apiGet('/health', healthResponseSchema)).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
  });

  it('reports network failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('failed')));
    const error = await apiGet('/health', healthResponseSchema).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: 'NETWORK_ERROR' });
  });
});
