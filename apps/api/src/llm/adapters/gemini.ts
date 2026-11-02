import { z } from 'zod';
import {
  ProviderError,
  estimateMessages,
  estimateTokens,
  kindOfStatus,
  retryAfterMs,
  type ChatMessage,
  type CompletionRequest,
  type CompletionResult,
  type LLMProvider,
} from '../provider.js';
import { errorMessageOf } from './openai-compatible.js';

export interface GeminiOptions {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
}

const responseSchema = z.object({
  candidates: z
    .array(
      z.object({
        content: z
          .object({ parts: z.array(z.object({ text: z.string().optional() })).optional() })
          .optional(),
        finishReason: z.string().optional(),
      }),
    )
    .optional(),
  usageMetadata: z
    .object({
      promptTokenCount: z.number().optional(),
      candidatesTokenCount: z.number().optional(),
    })
    .optional(),
  promptFeedback: z.object({ blockReason: z.string().optional() }).optional(),
});

const embeddingSchema = z.object({
  embeddings: z.array(z.object({ values: z.array(z.number()) })),
});

/** Gemini keeps the system prompt apart and calls the assistant "model". */
function toContents(messages: ChatMessage[]) {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content);
  const contents = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));
  return {
    contents,
    ...(system.length > 0 && { systemInstruction: { parts: [{ text: system.join('\n\n') }] } }),
  };
}

export class GeminiProvider implements LLMProvider {
  readonly id = 'gemini' as const;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: GeminiOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  private async post(path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.options.baseUrl}${path}`, {
        method: 'POST',
        // The key travels in a header, never in the URL, so it cannot end up in a log line.
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.options.apiKey },
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
      `/models/${encodeURIComponent(model)}:generateContent`,
      {
        ...toContents(request.messages),
        generationConfig: {
          ...(request.maxTokens !== undefined && { maxOutputTokens: request.maxTokens }),
          ...(request.temperature !== undefined && { temperature: request.temperature }),
          ...(request.json && { responseMimeType: 'application/json' }),
        },
      },
      request.signal,
    );
    const parsed = responseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new ProviderError(this.id, 'unknown', 'The provider answered with an unexpected shape');
    }
    if (parsed.data.promptFeedback?.blockReason) {
      throw new ProviderError(
        this.id,
        'invalid_request',
        `The prompt was blocked (${parsed.data.promptFeedback.blockReason})`,
      );
    }
    const candidate = parsed.data.candidates?.[0];
    const text = (candidate?.content?.parts ?? []).map((p) => p.text ?? '').join('');
    const usage = parsed.data.usageMetadata;
    const reason = candidate?.finishReason ?? 'STOP';
    return {
      text,
      usage: {
        inputTokens: usage?.promptTokenCount ?? estimateMessages(request.messages),
        outputTokens: usage?.candidatesTokenCount ?? estimateTokens(text),
        estimated: usage?.promptTokenCount === undefined,
      },
      finishReason: reason === 'STOP' ? 'stop' : reason === 'MAX_TOKENS' ? 'length' : 'other',
      provider: this.id,
      model,
    };
  }

  async embed(model: string, texts: string[]): Promise<number[][]> {
    const payload = await this.post(`/models/${encodeURIComponent(model)}:batchEmbedContents`, {
      requests: texts.map((text) => ({
        model: `models/${model}`,
        content: { parts: [{ text }] },
      })),
    });
    const parsed = embeddingSchema.safeParse(payload);
    if (!parsed.success) {
      throw new ProviderError(this.id, 'unknown', 'The provider answered with an unexpected shape');
    }
    return parsed.data.embeddings.map((e) => e.values);
  }
}
