import { describe, expect, it, vi } from 'vitest';
import { ProviderError } from '../provider.js';
import { GeminiProvider } from './gemini.js';
import { providersFromEnv } from './index.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

function fetchOf(reply: Response | ((url: string, init?: RequestInit) => Response)) {
  return vi.fn<typeof fetch>((input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return Promise.resolve(typeof reply === 'function' ? reply(url, init) : reply);
  });
}

const bodyOf = (init?: RequestInit): unknown =>
  JSON.parse(typeof init?.body === 'string' ? init.body : '{}');

const messages = [
  { role: 'system' as const, content: 'Be brief.' },
  { role: 'user' as const, content: 'Hi' },
];

describe('OpenAI-compatible adapter', () => {
  it('sends the bearer key, JSON mode and reads usage', async () => {
    const fetchMock = fetchOf(
      json({
        choices: [{ message: { content: 'Hello' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 3 },
      }),
    );
    const groq = new OpenAICompatibleProvider({
      id: 'groq',
      baseUrl: 'https://groq.test/v1',
      apiKey: 'gsk_secret',
      jsonMode: true,
      fetch: fetchMock,
    });
    const result = await groq.complete('m', { messages, json: true, maxTokens: 50 });
    expect(result).toMatchObject({
      text: 'Hello',
      usage: { inputTokens: 12, outputTokens: 3, estimated: false },
      finishReason: 'stop',
      provider: 'groq',
      model: 'm',
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://groq.test/v1/chat/completions');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer gsk_secret');
    expect(bodyOf(init)).toMatchObject({
      model: 'm',
      max_tokens: 50,
      response_format: { type: 'json_object' },
    });
  });

  it('maps a 429 with Retry-After to a rate limit error without leaking the body', async () => {
    const provider = new OpenAICompatibleProvider({
      id: 'cerebras',
      baseUrl: 'https://c.test',
      apiKey: 'k',
      jsonMode: false,
      fetch: fetchOf(json({ error: { message: 'slow down' } }, 429, { 'retry-after': '7' })),
    });
    const err = await provider.complete('m', { messages }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({
      kind: 'rate_limited',
      message: 'slow down',
      options: { status: 429, retryAfterMs: 7000 },
    });
  });

  it('turns a timeout into a timeout error', async () => {
    const provider = new OpenAICompatibleProvider({
      id: 'mistral',
      baseUrl: 'https://m.test',
      jsonMode: false,
      fetch: vi.fn<typeof fetch>(() => {
        const err = new Error('aborted');
        err.name = 'TimeoutError';
        return Promise.reject(err);
      }),
    });
    await expect(provider.complete('m', { messages })).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('estimates usage when the provider omits it', async () => {
    const provider = new OpenAICompatibleProvider({
      id: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
      jsonMode: true,
      fetch: fetchOf(json({ choices: [{ message: { content: 'x'.repeat(40) } }] })),
    });
    const result = await provider.complete('m', { messages });
    expect(result.usage.estimated).toBe(true);
    expect(result.usage.outputTokens).toBeGreaterThan(0);
  });
});

describe('Gemini adapter', () => {
  it('splits the system prompt out and reads usage metadata', async () => {
    const fetchMock = fetchOf(
      json({
        candidates: [
          { content: { parts: [{ text: 'Hi ' }, { text: 'there' }] }, finishReason: 'STOP' },
        ],
        usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 2 },
      }),
    );
    const gemini = new GeminiProvider({
      baseUrl: 'https://g.test',
      apiKey: 'AIza',
      fetch: fetchMock,
    });
    const result = await gemini.complete('gemini-x', { messages, json: true });
    expect(result.text).toBe('Hi there');
    expect(result.usage).toEqual({ inputTokens: 8, outputTokens: 2, estimated: false });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://g.test/models/gemini-x:generateContent');
    expect(url).not.toContain('AIza');
    expect(new Headers(init?.headers).get('x-goog-api-key')).toBe('AIza');
    expect(bodyOf(init)).toEqual({
      contents: [{ role: 'user', parts: [{ text: 'Hi' }] }],
      systemInstruction: { parts: [{ text: 'Be brief.' }] },
      generationConfig: { responseMimeType: 'application/json' },
    });
  });

  it('reports a blocked prompt as an invalid request', async () => {
    const gemini = new GeminiProvider({
      baseUrl: 'https://g.test',
      apiKey: 'k',
      fetch: fetchOf(json({ promptFeedback: { blockReason: 'SAFETY' } })),
    });
    await expect(gemini.complete('m', { messages })).rejects.toMatchObject({
      kind: 'invalid_request',
    });
  });

  it('treats an unknown model as unavailable', async () => {
    const gemini = new GeminiProvider({
      baseUrl: 'https://g.test',
      apiKey: 'k',
      fetch: fetchOf(json({ error: { message: 'not found' } }, 404)),
    });
    await expect(gemini.complete('gone', { messages })).rejects.toMatchObject({
      kind: 'model_unavailable',
    });
  });
});

describe('providersFromEnv', () => {
  it('builds an adapter for each key that is present', () => {
    const providers = providersFromEnv({
      GEMINI_API_KEY: 'a',
      GROQ_API_KEY: ' ',
      OLLAMA_URL: 'http://ollama:11434/v1/',
      MISTRAL_API_KEY: 'm',
    });
    expect(Object.keys(providers).sort()).toEqual(['gemini', 'mistral', 'ollama']);
    expect(providers.ollama).toBeInstanceOf(OpenAICompatibleProvider);
  });
});
