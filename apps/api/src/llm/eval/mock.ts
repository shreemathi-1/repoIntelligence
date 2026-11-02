import type { CompletionRequest, CompletionResult, LLMProvider } from '../provider.js';

/**
 * A stand-in model for running the harness without keys: it cites the first data block it is
 * shown and never repeats anything from inside the blocks. It checks the plumbing, not quality.
 */
export class MockProvider implements LLMProvider {
  readonly id = 'ollama' as const;

  complete(model: string, request: CompletionRequest): Promise<CompletionResult> {
    const prompt = request.messages.at(-1)?.content ?? '';
    const block = /<data path="([^"]+)" lines="(\d+)-(\d+)"/.exec(prompt);
    const text = block
      ? `The answer is in ${block[1]} [[${block[1]}:${block[2]}-${block[3]}]].`
      : 'NO_EVIDENCE';
    return Promise.resolve({
      text,
      usage: { inputTokens: Math.ceil(prompt.length / 4), outputTokens: 20, estimated: true },
      finishReason: 'stop',
      provider: this.id,
      model,
    });
  }
}
