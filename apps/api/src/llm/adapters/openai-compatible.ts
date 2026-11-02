import { z } from 'zod';
import {
  ProviderError,
  estimateMessages,
  estimateTokens,
  kindOfStatus,
  retryAfterMs,
  type CompletionRequest,
  type CompletionResult,
  type LLMProvider,
  type ProviderId,
} from '../provider.js';

/** Groq, Cerebras, OpenRouter, Mistral and Ollama all serve the OpenAI chat shape. */
export interface OpenAICompatibleOptions {
  id: ProviderId;
  baseUrl: string;
  apiKey?: string;
  jsonMode: boolean;
  fetch?: typeof fetch;
  /** Extra headers some providers want (OpenRouter asks for a referer and title). */
  headers?: Record<string, string>;
}

const responseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string().nullable() }),
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .min(1),
  usage: z
    .object({ prompt_tokens: z.number().optional(), completion_tokens: z.number().optional() })
    .optional(),
});

const embeddingSchema = z.object({
  data: z.array(z.object({ index: z.number(), embedding: z.array(z.number()) })),
});

const errorSchema = z.object({
  error: z.union([z.object({ message: z.string() }), z.string()]).optional(),
});

/** Pulls a short, key-free message out of an error body. */
export function errorMessageOf(body: unknown, status: number): string {
  const parsed = errorSchema.safeParse(body);
  const inner = parsed.success ? parsed.data.error : undefined;
  const text = typeof inner === 'string' ? inner : inner?.message;
  return (text ?? `HTTP ${status}`).slice(0, 200);
}

export class OpenAICompatibleProvider implements LLMProvider {
  readonly id: ProviderId;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OpenAICompatibleOptions) {
    this.id = options.id;
    this.fetchImpl = options.fetch ?? fetch;
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      ...(this.options.apiKey && { Authorization: `Bearer ${this.options.apiKey}` }),
      ...this.options.headers,
    };
  }

  private async post(path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.options.baseUrl}${path}`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      const timeout =
        err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      throw new ProviderError(
        this.id,
        timeout ? 'timeout' : 'unavailable',
        timeout ? 'The provider took too long' : 'Could not reach the provider',
      );
    }
    const payload: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      throw new ProviderError(
        this.id,
        kindOfStatus(response.status),
        errorMessageOf(payload, response.status),
        {
          status: response.status,
          retryAfterMs: retryAfterMs(response.headers.get('retry-after')),
        },
      );
    }
    return payload;
  }

  async complete(model: string, request: CompletionRequest): Promise<CompletionResult> {
    const payload = await this.post(
      '/chat/completions',
      {
        model,
        messages: request.messages,
        ...(request.maxTokens !== undefined && { max_tokens: request.maxTokens }),
        ...(request.temperature !== undefined && { temperature: request.temperature }),
        ...(request.json && this.options.jsonMode && { response_format: { type: 'json_object' } }),
        stream: false,
      },
      request.signal,
    );
    const parsed = responseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new ProviderError(this.id, 'unknown', 'The provider answered with an unexpected shape');
    }
    const choice = parsed.data.choices[0];
    const text = choice?.message.content ?? '';
    const usage = parsed.data.usage;
    const reason = choice?.finish_reason ?? 'stop';
    return {
      text,
      usage: {
        inputTokens: usage?.prompt_tokens ?? estimateMessages(request.messages),
        outputTokens: usage?.completion_tokens ?? estimateTokens(text),
        estimated: usage?.prompt_tokens === undefined,
      },
      finishReason: reason === 'stop' ? 'stop' : reason === 'length' ? 'length' : 'other',
      provider: this.id,
      model,
    };
  }

  async embed(model: string, texts: string[]): Promise<number[][]> {
    const payload = await this.post('/embeddings', { model, input: texts });
    const parsed = embeddingSchema.safeParse(payload);
    if (!parsed.success) {
      throw new ProviderError(this.id, 'unknown', 'The provider answered with an unexpected shape');
    }
    return [...parsed.data.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }
}
