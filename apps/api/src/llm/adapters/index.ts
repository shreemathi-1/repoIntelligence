import { PROVIDERS } from '../models.config.js';
import { PROVIDER_IDS, type LLMProvider, type ProviderId } from '../provider.js';
import { GeminiProvider } from './gemini.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';

export type ProviderMap = Partial<Record<ProviderId, LLMProvider>>;

/**
 * Builds one adapter per provider whose key (or, for Ollama, URL) is present. Keys are read
 * here and handed to the adapter; nothing else in the process sees them.
 */
export function providersFromEnv(
  env: Readonly<Record<string, unknown>>,
  fetchImpl?: typeof fetch,
): ProviderMap {
  const out: ProviderMap = {};
  for (const id of PROVIDER_IDS) {
    const config = PROVIDERS[id];
    const raw = env[config.env];
    const value = typeof raw === 'string' ? raw.trim() : undefined;
    if (!value) continue;
    if (id === 'gemini') {
      out.gemini = new GeminiProvider({ baseUrl: config.baseUrl, apiKey: value, fetch: fetchImpl });
      continue;
    }
    const isUrl = id === 'ollama';
    out[id] = new OpenAICompatibleProvider({
      id,
      baseUrl: isUrl ? value.replace(/\/+$/, '') : config.baseUrl,
      ...(!isUrl && { apiKey: value }),
      jsonMode: config.jsonMode,
      fetch: fetchImpl,
      ...(id === 'openrouter' && {
        headers: { 'X-Title': 'RepoIntelligence' },
      }),
    });
  }
  return out;
}

export { GeminiProvider } from './gemini.js';
export { OpenAICompatibleProvider } from './openai-compatible.js';
