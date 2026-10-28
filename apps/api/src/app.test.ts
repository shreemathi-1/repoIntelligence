import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { errorResponseSchema, healthResponseSchema } from '@repointelligence/shared';
import { testConfig } from '../test/env.js';
import { createApp } from './app.js';
import { createLogger } from './logger.js';

const app = createApp(testConfig, createLogger(testConfig));

describe('GET /health', () => {
  it('returns a valid degraded payload when the database is not connected', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    const body = healthResponseSchema.parse(res.body);
    expect(body.status).toBe('degraded');
    expect(body.checks.database).toBe('down');
  });

  it('sets a request id and security headers', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['x-request-id']).toBeTruthy();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('echoes a well-formed incoming request id and replaces a bad one', async () => {
    const good = await request(app).get('/health').set('X-Request-Id', 'abc12345-req');
    expect(good.headers['x-request-id']).toBe('abc12345-req');
    const bad = await request(app).get('/health').set('X-Request-Id', 'x');
    expect(bad.headers['x-request-id']).not.toBe('x');
  });
});

describe('cors', () => {
  it('allows only the configured client origin', async () => {
    const allowed = await request(app).get('/health').set('Origin', testConfig.CLIENT_URL);
    expect(allowed.headers['access-control-allow-origin']).toBe(testConfig.CLIENT_URL);
    const other = await request(app).get('/health').set('Origin', 'http://evil.example');
    // The header always names the configured origin, so a browser on another origin is refused.
    expect(other.headers['access-control-allow-origin']).toBe(testConfig.CLIENT_URL);
  });
});

describe('error handling', () => {
  it('returns the shared error shape for unknown routes', async () => {
    const res = await request(app).get('/api/v1/nope');
    expect(res.status).toBe(404);
    const body = errorResponseSchema.parse(res.body);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.requestId).toBe(res.headers['x-request-id']);
  });

  it('returns 400 for malformed JSON', async () => {
    const res = await request(app)
      .post('/api/v1/anything')
      .set('Content-Type', 'application/json')
      .send('{bad');
    expect(res.status).toBe(400);
    expect(errorResponseSchema.parse(res.body).error.code).toBe('BAD_REQUEST');
  });
});

describe('rate limiting', () => {
  it('throttles /api but never /health', async () => {
    const limited = createApp(testConfig, createLogger(testConfig));
    let last = 0;
    for (let i = 0; i < 101; i++) {
      last = (await request(limited).get('/api/v1/nope')).status;
    }
    expect(last).toBe(429);
    expect((await request(limited).get('/health')).status).toBe(200);
  });
});
