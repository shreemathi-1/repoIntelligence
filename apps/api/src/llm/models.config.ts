/**
 * Every model identifier and routing decision lives here and nowhere else. Free-tier
 * model names rotate; when one disappears, change it in this file only.
 *
 * Limits are conservative readings of each provider's published free tier. The gateway
 * treats them as a budget per process, and backs off further when a provider says 429.
 */
import type { ProviderId } from './provider.js';

export interface ProviderConfig {
  /** Which environment variable holds the key, or the base URL for a local server. */
  env: string;
  baseUrl: string;
  /** Free tiers that may train on inputs never see private repository content. */
  trainsOnInputs: boolean;
  /** Requests and tokens per minute the gateway will send before holding back. */
  rpm: number;
  tpm: number;
  /** Whether the chat API honours `response_format: json_object`. */
  jsonMode: boolean;
}

export const PROVIDERS: Record<ProviderId, ProviderConfig> = {
  gemini: {
    env: 'GEMINI_API_KEY',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    trainsOnInputs: true,
    rpm: 10,
    tpm: 250_000,
    jsonMode: true,
  },
  groq: {
    env: 'GROQ_API_KEY',
    baseUrl: 'https://api.groq.com/openai/v1',
    trainsOnInputs: false,
    rpm: 30,
    tpm: 8_000,
    jsonMode: true,
  },
  cerebras: {
    env: 'CEREBRAS_API_KEY',
    baseUrl: 'https://api.cerebras.ai/v1',
    trainsOnInputs: false,
    rpm: 30,
    tpm: 60_000,
    jsonMode: true,
  },
  openrouter: {
    env: 'OPENROUTER_API_KEY',
    baseUrl: 'https://openrouter.ai/api/v1',
    trainsOnInputs: true,
    rpm: 20,
    tpm: 100_000,
    jsonMode: false,
  },
  mistral: {
    env: 'MISTRAL_API_KEY',
    baseUrl: 'https://api.mistral.ai/v1',
    trainsOnInputs: true,
    rpm: 60,
    tpm: 500_000,
    jsonMode: true,
  },
  ollama: {
    env: 'OLLAMA_URL',
    baseUrl: 'http://localhost:11434/v1',
    trainsOnInputs: false,
    rpm: 1_000,
    tpm: 10_000_000,
    jsonMode: true,
  },
};

export interface ModelRef {
  provider: ProviderId;
  model: string;
  /** Largest prompt this model should receive, in estimated tokens. */
  maxInputTokens: number;
  /** Free tiers cost nothing; the fields exist so a paid key can be accounted for later. */
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
}

const ref = (
  provider: ProviderId,
  model: string,
  maxInputTokens: number,
  prices: [number, number] = [0, 0],
): ModelRef => ({
  provider,
  model,
  maxInputTokens,
  inputUsdPerMTok: prices[0],
  outputUsdPerMTok: prices[1],
});

export const MODELS = {
  geminiFlash: ref('gemini', 'gemini-2.5-flash', 200_000),
  geminiFlashLite: ref('gemini', 'gemini-2.5-flash-lite', 200_000),
  groqGptOss120b: ref('groq', 'openai/gpt-oss-120b', 7_000),
  groqGptOss20b: ref('groq', 'openai/gpt-oss-20b', 7_000),
  groqLlama8b: ref('groq', 'llama-3.1-8b-instant', 5_000),
  cerebrasLlama70b: ref('cerebras', 'llama-3.3-70b', 32_000),
  cerebrasLlama8b: ref('cerebras', 'llama3.1-8b', 16_000),
  openrouterFree: ref('openrouter', 'openrouter/free', 32_000),
  mistralSmall: ref('mistral', 'mistral-small-latest', 60_000),
  codestral: ref('mistral', 'codestral-latest', 60_000),
  ollamaQwenCoder: ref('ollama', 'qwen2.5-coder:7b', 24_000),
} as const;

export const TASK_IDS = ['chat', 'structured', 'explain', 'plan', 'security', 'light'] as const;
export type TaskId = (typeof TASK_IDS)[number];

export interface TaskConfig {
  /** Tried in order; a model is skipped when its provider is not configured or is cooling down. */
  route: ModelRef[];
  maxOutputTokens: number;
  temperature: number;
  timeoutMs: number;
}

export const TASKS: Record<TaskId, TaskConfig> = {
  // Repository chat and cross-file questions.
  chat: {
    route: [
      MODELS.geminiFlash,
      MODELS.groqGptOss120b,
      MODELS.cerebrasLlama70b,
      MODELS.mistralSmall,
      MODELS.openrouterFree,
      MODELS.ollamaQwenCoder,
    ],
    maxOutputTokens: 1_200,
    temperature: 0.2,
    timeoutMs: 45_000,
  },
  // Structured JSON that is validated against a schema.
  structured: {
    route: [
      MODELS.geminiFlashLite,
      MODELS.groqGptOss20b,
      MODELS.cerebrasLlama8b,
      MODELS.mistralSmall,
      MODELS.ollamaQwenCoder,
    ],
    maxOutputTokens: 1_000,
    temperature: 0,
    timeoutMs: 30_000,
  },
  // Code explanation and documentation.
  explain: {
    route: [
      MODELS.groqGptOss120b,
      MODELS.cerebrasLlama70b,
      MODELS.geminiFlash,
      MODELS.codestral,
      MODELS.openrouterFree,
      MODELS.ollamaQwenCoder,
    ],
    maxOutputTokens: 1_500,
    temperature: 0.2,
    timeoutMs: 45_000,
  },
  // Refactoring and planning.
  plan: {
    route: [
      MODELS.groqGptOss120b,
      MODELS.geminiFlash,
      MODELS.cerebrasLlama70b,
      MODELS.openrouterFree,
    ],
    maxOutputTokens: 1_500,
    temperature: 0.3,
    timeoutMs: 45_000,
  },
  // Security explanations.
  security: {
    route: [
      MODELS.groqGptOss120b,
      MODELS.openrouterFree,
      MODELS.geminiFlash,
      MODELS.cerebrasLlama70b,
    ],
    maxOutputTokens: 1_200,
    temperature: 0.1,
    timeoutMs: 45_000,
  },
  // Suggested questions, tagging and other small jobs.
  light: {
    route: [
      MODELS.groqLlama8b,
      MODELS.cerebrasLlama8b,
      MODELS.geminiFlashLite,
      MODELS.mistralSmall,
      MODELS.ollamaQwenCoder,
    ],
    maxOutputTokens: 400,
    temperature: 0.4,
    timeoutMs: 20_000,
  },
};

/** Embeddings run locally in the worker. The identifier is recorded with each vector. */
export const EMBEDDING = { model: 'BAAI/bge-small-en-v1.5', dimensions: 384 } as const;

export const RETRY = { attempts: 2, baseDelayMs: 800, maxDelayMs: 8_000 } as const;
