/** The one interface every model provider implements. Adapters live in ./adapters. */

export const PROVIDER_IDS = [
  'gemini',
  'groq',
  'cerebras',
  'openrouter',
  'mistral',
  'ollama',
] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompletionRequest {
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  /** Ask the provider for a JSON object. Providers without a JSON mode ignore it. */
  json?: boolean;
  signal?: AbortSignal;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** True when the provider did not report usage and the numbers are estimates. */
  estimated: boolean;
}

export interface CompletionResult {
  text: string;
  usage: Usage;
  finishReason: 'stop' | 'length' | 'other';
  provider: ProviderId;
  model: string;
}

export interface LLMProvider {
  readonly id: ProviderId;
  complete(model: string, request: CompletionRequest): Promise<CompletionResult>;
  /** Only some providers embed; the worker is the default embedder. */
  embed?(model: string, texts: string[]): Promise<number[][]>;
}

export type ProviderErrorKind =
  | 'rate_limited'
  | 'timeout'
  | 'unavailable'
  | 'auth'
  | 'invalid_request'
  | 'model_unavailable'
  | 'unknown';

/** Normalised provider failure. The message never contains the request or a key. */
export class ProviderError extends Error {
  constructor(
    public readonly provider: ProviderId,
    public readonly kind: ProviderErrorKind,
    message: string,
    public readonly options: { status?: number; retryAfterMs?: number } = {},
  ) {
    super(message);
    this.name = 'ProviderError';
  }

  /** Rate limits, timeouts and outages may pass on a retry or another provider. */
  get transient(): boolean {
    return this.kind === 'rate_limited' || this.kind === 'timeout' || this.kind === 'unavailable';
  }
}

/** Maps an HTTP status to an error kind. Shared by every HTTP adapter. */
export function kindOfStatus(status: number): ProviderErrorKind {
  if (status === 429) return 'rate_limited';
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'model_unavailable';
  if (status === 408 || status === 504) return 'timeout';
  if (status >= 500) return 'unavailable';
  if (status >= 400) return 'invalid_request';
  return 'unknown';
}

/** Parses a Retry-After header (seconds or an HTTP date) into milliseconds. */
export function retryAfterMs(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/** Rough token count, the same rule the ingestion chunker uses (~4 characters per token). */
export function estimateTokens(text: string): number {
  return Math.ceil((text.length / 4) * 1.1);
}

export function estimateMessages(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content) + 4, 0);
}
