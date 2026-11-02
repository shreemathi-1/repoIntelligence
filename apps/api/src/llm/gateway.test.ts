import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { FakeProvider, MemoryUsage } from '../../test/fixtures/llm.js';
import { AppError } from '../errors.js';
import { LlmGateway, type UsageRecord } from './gateway.js';
import { RateLimiter } from './limiter.js';
import { PROVIDERS, TASKS } from './models.config.js';
import { completeStructured, extractJson } from './structured.js';

const messages = [{ role: 'user' as const, content: 'What does this repo do?' }];

function gateway(
  providers: FakeProvider[],
  over: Partial<ConstructorParameters<typeof LlmGateway>[0]> = {},
) {
  const usage = new MemoryUsage();
  const sleeps: number[] = [];
  let clock = 1_700_000_000_000;
  const gw = new LlmGateway({
    providers: Object.fromEntries(providers.map((p) => [p.id, p])),
    usage,
    now: () => clock,
    sleep: (ms) => {
      sleeps.push(ms);
      clock += ms;
      return Promise.resolve();
    },
    ...over,
  });
  return { gw, usage, sleeps, tick: (ms: number) => (clock += ms) };
}

describe('routing', () => {
  it('uses the primary model when it answers', async () => {
    const gemini = new FakeProvider('gemini', ['The repo is a CLI.']);
    const groq = new FakeProvider('groq');
    const { gw, usage } = gateway([gemini, groq]);
    const result = await gw.complete('chat', messages);
    expect(result.provider).toBe('gemini');
    expect(result.model).toBe(TASKS.chat.route[0]?.model);
    expect(result.text).toBe('The repo is a CLI.');
    expect(groq.calls).toHaveLength(0);
    expect(usage.entries).toHaveLength(1);
    expect(usage.entries[0]).toMatchObject({ provider: 'gemini', ok: true, costUsd: 0 });
  });

  it('skips providers without a key', async () => {
    const groq = new FakeProvider('groq', ['from groq']);
    const { gw } = gateway([groq]);
    expect(gw.configured()).toEqual(['groq']);
    expect((await gw.complete('chat', messages)).provider).toBe('groq');
  });

  it('fails clearly when nothing is configured', async () => {
    const { gw } = gateway([]);
    expect(gw.available('chat')).toBe(false);
    await expect(gw.complete('chat', messages)).rejects.toMatchObject({
      code: 'LLM_NOT_CONFIGURED',
      statusCode: 503,
    });
  });

  it('keeps private content away from providers that train on inputs', async () => {
    const gemini = new FakeProvider('gemini');
    const groq = new FakeProvider('groq', ['private ok']);
    const { gw } = gateway([gemini, groq]);
    expect(PROVIDERS.gemini.trainsOnInputs).toBe(true);
    expect(gw.route('chat', { privateContent: true }).map((r) => r.provider)).toEqual(['groq']);
    const result = await gw.complete('chat', messages, { privateContent: true });
    expect(result.provider).toBe('groq');
    expect(gemini.calls).toHaveLength(0);
  });

  it('refuses private content when only training providers are configured', async () => {
    const { gw } = gateway([new FakeProvider('gemini')]);
    await expect(gw.complete('chat', messages, { privateContent: true })).rejects.toMatchObject({
      code: 'LLM_NOT_CONFIGURED',
    });
  });
});

describe('failover', () => {
  it('moves to the fallback when the primary is rate limited and cools it down', async () => {
    const gemini = new FakeProvider('gemini', [{ error: 'rate_limited', retryAfterMs: 20_000 }]);
    const groq = new FakeProvider('groq', ['fallback answer']);
    const { gw, usage } = gateway([gemini, groq]);
    const result = await gw.complete('chat', messages);
    expect(result.provider).toBe('groq');
    expect(result.attempts.map((a) => `${a.provider}:${a.outcome}`)).toEqual([
      'gemini:failed',
      'groq:ok',
    ]);
    expect(gw.limiter.snapshot().gemini?.cooldownMs).toBe(20_000);
    expect((usage.entries as UsageRecord[]).map((e) => [e.provider, e.ok, e.error])).toEqual([
      ['gemini', false, 'rate_limited'],
      ['groq', true, undefined],
    ]);

    // While gemini cools down, the next call goes straight to groq.
    gemini.calls.length = 0;
    await gw.complete('chat', messages);
    expect(gemini.calls).toHaveLength(0);
  });

  it('retries transient outages with backoff before failing over', async () => {
    const gemini = new FakeProvider('gemini', [{ error: 'unavailable' }, { error: 'timeout' }]);
    const groq = new FakeProvider('groq', ['eventually']);
    const { gw, sleeps } = gateway([gemini, groq]);
    const result = await gw.complete('chat', messages);
    expect(result.provider).toBe('groq');
    expect(gemini.calls).toHaveLength(2);
    expect(sleeps).toEqual([800]);
  });

  it('does not retry a bad request on the same provider', async () => {
    const gemini = new FakeProvider('gemini', [{ error: 'invalid_request' }]);
    const groq = new FakeProvider('groq', ['ok']);
    const { gw, sleeps } = gateway([gemini, groq]);
    await gw.complete('chat', messages);
    expect(gemini.calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it('reports every attempt when the whole route fails', async () => {
    const gemini = new FakeProvider('gemini', [{ error: 'auth' }]);
    const groq = new FakeProvider('groq', [{ error: 'model_unavailable' }]);
    const { gw } = gateway([gemini, groq]);
    const err = await gw.complete('chat', messages).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ code: 'LLM_UNAVAILABLE', statusCode: 503 });
    expect((err as AppError).details).toEqual({
      attempts: [
        { provider: 'gemini', outcome: 'failed', reason: 'auth' },
        { provider: 'groq', outcome: 'failed', reason: 'model_unavailable' },
      ],
    });
  });
});

describe('budgets', () => {
  it('skips a model whose context is too small for the prompt', async () => {
    const groq = new FakeProvider('groq');
    const cerebras = new FakeProvider('cerebras', ['big prompt ok']);
    const { gw } = gateway([groq, cerebras]);
    const huge = [{ role: 'user' as const, content: 'x'.repeat(40_000) }];
    const result = await gw.complete('chat', huge);
    expect(result.provider).toBe('cerebras');
    expect(groq.calls).toHaveLength(0);
    expect(result.attempts[0]).toMatchObject({ provider: 'groq', outcome: 'skipped' });
  });

  it('holds a provider back once its requests per minute are used', async () => {
    const gemini = new FakeProvider('gemini', ['a']);
    const groq = new FakeProvider('groq', ['b']);
    const { gw, tick } = gateway([gemini, groq]);
    for (let i = 0; i < PROVIDERS.gemini.rpm; i += 1) await gw.complete('chat', messages);
    expect(gemini.calls).toHaveLength(PROVIDERS.gemini.rpm);
    expect((await gw.complete('chat', messages)).provider).toBe('groq');
    tick(61_000);
    expect((await gw.complete('chat', messages)).provider).toBe('gemini');
  });

  it('waits briefly for a window that is about to free up', () => {
    let clock = 0;
    const limiter = new RateLimiter(() => clock);
    const limits = { rpm: 2, tpm: 1000 };
    limiter.record('p', 100);
    clock = 1000;
    limiter.record('p', 100);
    expect(limiter.waitFor('p', limits, 100)).toBe(59_000);
    expect(limiter.waitFor('p', limits, 5000)).toBe(Number.POSITIVE_INFINITY);
    clock = 61_000;
    expect(limiter.waitFor('p', limits, 100)).toBe(0);
  });
});

describe('structured output', () => {
  const schema = z.object({ questions: z.array(z.string()).min(1) });

  it('parses JSON out of a fenced reply', () => {
    expect(extractJson('Sure:\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('{"a":[1,2]} trailing')).toEqual({ a: [1, 2] });
    expect(extractJson('no json here')).toBeUndefined();
  });

  it('asks the model to repair an invalid reply once', async () => {
    const groq = new FakeProvider('groq', ['{"questions": []}', '{"questions": ["Why?"]}']);
    const { gw } = gateway([groq]);
    const out = await completeStructured(gw, 'structured', messages, schema);
    expect(out.data.questions).toEqual(['Why?']);
    expect(out.repaired).toBe(true);
    const repairPrompt = groq.calls[1]?.request.messages.at(-1)?.content ?? '';
    expect(repairPrompt).toContain('questions');
    expect(groq.calls[0]?.request.json).toBe(true);
  });

  it('gives up after a second invalid reply', async () => {
    const groq = new FakeProvider('groq', ['nope', 'still nope']);
    const { gw } = gateway([groq]);
    await expect(completeStructured(gw, 'structured', messages, schema)).rejects.toMatchObject({
      code: 'LLM_INVALID_OUTPUT',
    });
  });
});
