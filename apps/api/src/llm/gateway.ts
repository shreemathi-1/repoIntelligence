import type { Logger } from 'pino';
import { AppError } from '../errors.js';
import type { ProviderMap } from './adapters/index.js';
import { RateLimiter } from './limiter.js';
import { PROVIDERS, RETRY, TASKS, type ModelRef, type TaskId } from './models.config.js';
import {
  ProviderError,
  estimateMessages,
  type ChatMessage,
  type CompletionResult,
  type ProviderId,
} from './provider.js';

export interface CallMeta {
  userId?: string;
  fullName?: string;
}

export interface CompleteOptions extends CallMeta {
  /** Only route to providers that do not train on inputs. */
  privateContent?: boolean;
  /** Narrow the route further, for tests and for a user's explicit choice. */
  allowedProviders?: ProviderId[];
  json?: boolean;
  maxTokens?: number;
  temperature?: number;
  /** Overrides the task's timeout. */
  timeoutMs?: number;
}

export interface UsageRecord extends CallMeta {
  task: TaskId;
  provider: ProviderId;
  model: string;
  inputTokens: number;
  outputTokens: number;
  estimated: boolean;
  costUsd: number;
  latencyMs: number;
  ok: boolean;
  error?: string;
}

export interface UsageSink {
  record(entry: UsageRecord): Promise<void>;
}

export interface GatewayOptions {
  providers: ProviderMap;
  usage?: UsageSink;
  logger?: Logger;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** How long the gateway is willing to wait for a window to free up before failing over. */
  maxWaitMs?: number;
}

export interface Attempt {
  provider: ProviderId;
  model: string;
  outcome: 'ok' | 'skipped' | 'failed';
  reason?: string;
}

export interface GatewayResult extends CompletionResult {
  attempts: Attempt[];
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function costOf(ref: ModelRef, inputTokens: number, outputTokens: number): number {
  return (inputTokens * ref.inputUsdPerMTok + outputTokens * ref.outputUsdPerMTok) / 1_000_000;
}

/**
 * Routes a task to the configured models in order, keeps each provider inside its free-tier
 * budget, retries transient failures with backoff and fails over to the next model. Every
 * call is recorded, so cost and token use can be inspected per user and provider.
 */
export class LlmGateway {
  readonly limiter: RateLimiter;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxWaitMs: number;

  constructor(private readonly options: GatewayOptions) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? realSleep;
    this.limiter = new RateLimiter(this.now);
    this.maxWaitMs = options.maxWaitMs ?? 3_000;
  }

  /** Providers with a key present. */
  configured(): ProviderId[] {
    return Object.keys(this.options.providers) as ProviderId[];
  }

  /** The models a task can reach right now, in order. */
  route(task: TaskId, options: CompleteOptions = {}): ModelRef[] {
    return TASKS[task].route.filter((ref) => {
      if (!this.options.providers[ref.provider]) return false;
      if (options.privateContent && PROVIDERS[ref.provider].trainsOnInputs) return false;
      if (options.allowedProviders && !options.allowedProviders.includes(ref.provider))
        return false;
      return true;
    });
  }

  available(task: TaskId, options: CompleteOptions = {}): boolean {
    return this.route(task, options).length > 0;
  }

  async complete(
    task: TaskId,
    messages: ChatMessage[],
    options: CompleteOptions = {},
  ): Promise<GatewayResult> {
    const route = this.route(task, options);
    if (route.length === 0) {
      throw new AppError(
        503,
        'LLM_NOT_CONFIGURED',
        options.privateContent
          ? 'No configured model provider may receive private repository content'
          : 'No model provider is configured on this server',
      );
    }
    const config = TASKS[task];
    const estimate = estimateMessages(messages) + (options.maxTokens ?? config.maxOutputTokens);
    const attempts: Attempt[] = [];

    for (const ref of route) {
      const key = ref.provider;
      const limits = PROVIDERS[key];
      if (estimate > ref.maxInputTokens) {
        attempts.push({ ...ref, outcome: 'skipped', reason: 'prompt too large for this model' });
        continue;
      }
      const wait = this.limiter.waitFor(key, limits, estimate);
      if (wait > this.maxWaitMs) {
        attempts.push({ ...ref, outcome: 'skipped', reason: 'provider budget exhausted' });
        continue;
      }
      if (wait > 0) await this.sleep(wait);

      for (let attempt = 1; attempt <= RETRY.attempts; attempt += 1) {
        const result = await this.tryOnce(task, ref, messages, options, estimate);
        if ('text' in result) {
          attempts.push({ ...ref, outcome: 'ok' });
          return { ...result, attempts };
        }
        const err = result.error;
        attempts.push({ ...ref, outcome: 'failed', reason: err.kind });
        if (err.kind === 'rate_limited') {
          this.limiter.block(key, err.options.retryAfterMs);
          break; // fail over right away; the provider has told us to go away
        }
        if (!err.transient || attempt === RETRY.attempts) {
          if (err.kind === 'unavailable') this.limiter.block(key);
          break;
        }
        await this.sleep(Math.min(RETRY.maxDelayMs, RETRY.baseDelayMs * 2 ** (attempt - 1)));
      }
    }

    this.options.logger?.warn({ task, attempts }, 'every model in the route failed');
    throw new AppError(503, 'LLM_UNAVAILABLE', 'No model could answer right now', {
      attempts: attempts.map((a) => ({
        provider: a.provider,
        outcome: a.outcome,
        reason: a.reason,
      })),
    });
  }

  private async tryOnce(
    task: TaskId,
    ref: ModelRef,
    messages: ChatMessage[],
    options: CompleteOptions,
    estimate: number,
  ): Promise<CompletionResult | { error: ProviderError }> {
    const provider = this.options.providers[ref.provider];
    if (!provider)
      return { error: new ProviderError(ref.provider, 'unavailable', 'not configured') };
    const config = TASKS[task];
    const started = this.now();
    this.limiter.record(ref.provider, estimate);
    try {
      const result = await provider.complete(ref.model, {
        messages,
        maxTokens: options.maxTokens ?? config.maxOutputTokens,
        temperature: options.temperature ?? config.temperature,
        json: options.json ?? false,
        signal: AbortSignal.timeout(options.timeoutMs ?? config.timeoutMs),
      });
      await this.record({
        task,
        provider: ref.provider,
        model: ref.model,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        estimated: result.usage.estimated,
        costUsd: costOf(ref, result.usage.inputTokens, result.usage.outputTokens),
        latencyMs: this.now() - started,
        ok: true,
        ...(options.userId && { userId: options.userId }),
        ...(options.fullName && { fullName: options.fullName }),
      });
      return result;
    } catch (err) {
      const error =
        err instanceof ProviderError
          ? err
          : new ProviderError(ref.provider, 'unknown', 'The provider call failed');
      await this.record({
        task,
        provider: ref.provider,
        model: ref.model,
        inputTokens: 0,
        outputTokens: 0,
        estimated: true,
        costUsd: 0,
        latencyMs: this.now() - started,
        ok: false,
        error: error.kind,
        ...(options.userId && { userId: options.userId }),
        ...(options.fullName && { fullName: options.fullName }),
      });
      this.options.logger?.info(
        {
          provider: ref.provider,
          model: ref.model,
          kind: error.kind,
          status: error.options.status,
        },
        'model call failed',
      );
      return { error };
    }
  }

  private async record(entry: UsageRecord): Promise<void> {
    try {
      await this.options.usage?.record(entry);
    } catch (err) {
      this.options.logger?.warn({ err }, 'could not record model usage');
    }
  }
}
