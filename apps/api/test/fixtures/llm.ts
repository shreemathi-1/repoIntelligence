import {
  ProviderError,
  estimateMessages,
  estimateTokens,
  type CompletionRequest,
  type CompletionResult,
  type LLMProvider,
  type ProviderErrorKind,
  type ProviderId,
} from '../../src/llm/provider.js';

export type Reply =
  | string
  | { error: ProviderErrorKind; retryAfterMs?: number }
  | ((request: CompletionRequest, model: string) => string);

/** A provider that answers from a script, one reply per call, and remembers what it saw. */
export class FakeProvider implements LLMProvider {
  readonly calls: { model: string; request: CompletionRequest }[] = [];

  constructor(
    readonly id: ProviderId,
    private readonly replies: Reply[] = ['ok'],
  ) {}

  complete(model: string, request: CompletionRequest): Promise<CompletionResult> {
    this.calls.push({ model, request });
    const next = this.replies.length > 1 ? this.replies.shift() : this.replies[0];
    if (next === undefined) throw new Error('no reply scripted');
    if (typeof next === 'object') {
      return Promise.reject(
        new ProviderError(this.id, next.error, `scripted ${next.error}`, {
          ...(next.retryAfterMs !== undefined && { retryAfterMs: next.retryAfterMs }),
        }),
      );
    }
    const text = typeof next === 'function' ? next(request, model) : next;
    return Promise.resolve({
      text,
      usage: {
        inputTokens: estimateMessages(request.messages),
        outputTokens: estimateTokens(text),
        estimated: false,
      },
      finishReason: 'stop',
      provider: this.id,
      model,
    });
  }
}

/** Collects usage records in memory. */
export class MemoryUsage {
  readonly entries: unknown[] = [];
  record(entry: unknown): Promise<void> {
    this.entries.push(entry);
    return Promise.resolve();
  }
}
