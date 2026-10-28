import { Octokit, RequestError } from 'octokit';
import { z } from 'zod';
import type { RepoResponse, RepoSummary } from '@repointelligence/shared';
import { AppError } from '../errors.js';
import { GithubCache } from '../models/github-cache.js';

export interface Viewer {
  userId: string;
  token: string;
}

export interface GithubServiceOptions {
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Token for anonymous requests, so public discovery is not stuck on the 60/hour limit. */
  serverToken?: string;
  /** How long a cached response is served without asking GitHub again. */
  freshMs?: number;
  /** How long an entry is kept at all, so it can still be revalidated by ETag. */
  keepMs?: number;
}

export type CacheSource = 'network' | 'cache' | 'revalidated';

export type ParamValue = string | number | boolean | undefined;

export interface JsonRequest<T> {
  route: string;
  params?: Record<string, ParamValue>;
  /** Parses the raw GitHub body into the shape we keep and cache. */
  schema: z.ZodType<T>;
  freshMs?: number;
  /** Set false for large, immutable bodies the caller stores itself (for example blobs). */
  cache?: boolean;
}

/** GitHub answered 202: it is still computing statistics. Nothing is cached. */
export class GithubPendingError extends Error {
  constructor() {
    super('GitHub is still computing this data');
    this.name = 'GithubPendingError';
  }
}

const MAX_RETRIES = 3;
const MAX_RESET_WAIT_MS = 60_000;

const repoSchema = z.object({
  full_name: z.string(),
  description: z.string().nullable(),
  private: z.boolean(),
  default_branch: z.string(),
  language: z.string().nullable(),
  stargazers_count: z.number().int().nonnegative(),
  html_url: z.url(),
});

const repoSummarySchema = repoSchema.transform((raw): RepoSummary => ({
  fullName: raw.full_name,
  description: raw.description,
  private: raw.private,
  defaultBranch: raw.default_branch,
  language: raw.language,
  stars: raw.stargazers_count,
  htmlUrl: raw.html_url,
}));

function stableParams(params: Record<string, ParamValue>): string {
  return Object.keys(params)
    .sort()
    .filter((key) => params[key] !== undefined)
    .map((key) => `${key}=${String(params[key])}`)
    .join('&');
}

export class GithubService {
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly serverToken: string | undefined;
  private readonly freshMs: number;
  private readonly keepMs: number;

  constructor(options: GithubServiceOptions = {}) {
    this.fetchImpl = options.fetch;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.serverToken = options.serverToken;
    this.freshMs = options.freshMs ?? 5 * 60_000;
    this.keepMs = options.keepMs ?? 24 * 60 * 60_000;
  }

  async getRepo(owner: string, name: string, viewer?: Viewer): Promise<RepoResponse> {
    const { data, source } = await this.getJson(
      {
        route: 'GET /repos/{owner}/{repo}',
        params: { owner, repo: name },
        schema: repoSummarySchema,
      },
      viewer,
    );
    return { repo: data, source };
  }

  /**
   * One cached, conditional, retrying GitHub GET. Entries are scoped per viewer so one user's
   * private data is never served to another.
   */
  async getJson<T>(
    request: JsonRequest<T>,
    viewer?: Viewer,
  ): Promise<{ data: T; source: CacheSource }> {
    const params = request.params ?? {};
    const scope = viewer ? `user:${viewer.userId}` : 'public';
    const key = `${scope}|${request.route}|${stableParams(params)}`.toLowerCase();
    const freshMs = request.freshMs ?? this.freshMs;
    const useCache = request.cache !== false;
    const cached = useCache ? await GithubCache.findOne({ key }).lean() : null;
    const now = this.now();

    if (cached?.staleAt && cached.staleAt.getTime() > now) {
      return { data: cached.body as T, source: 'cache' };
    }

    const token = viewer?.token ?? this.serverToken;
    const octokit = new Octokit({
      userAgent: 'repointelligence',
      ...(token && { auth: token }),
      ...(this.fetchImpl && { request: { fetch: this.fetchImpl } }),
      // Retries and rate-limit waits are handled here, where they are visible and testable.
      retry: { enabled: false },
      throttle: { enabled: false },
    });

    for (let attempt = 0; ; attempt++) {
      try {
        const response = await octokit.request(request.route, {
          ...params,
          headers: cached?.etag ? { 'if-none-match': cached.etag } : {},
        });
        if (response.status === 202) throw new GithubPendingError();
        const raw: unknown = response.data;
        const data = request.schema.parse(raw);
        if (useCache) await this.store(key, data, response.headers.etag, freshMs);
        return { data, source: 'network' };
      } catch (err) {
        if (err instanceof GithubPendingError) throw err;
        if (!(err instanceof RequestError)) {
          if (err instanceof z.ZodError) {
            throw AppError.upstream('GitHub returned an unexpected shape');
          }
          throw AppError.upstream();
        }

        if (err.status === 304 && cached) {
          await this.store(key, cached.body, cached.etag ?? undefined, freshMs);
          return { data: cached.body as T, source: 'revalidated' };
        }

        const headers = err.response?.headers ?? {};
        const limited =
          err.status === 429 || (err.status === 403 && headers['x-ratelimit-remaining'] === '0');

        if (!limited && (err.status === 404 || err.status === 403 || err.status === 401)) {
          await GithubCache.deleteOne({ key });
          // 404 also covers "exists but you cannot see it", so existence is not leaked.
          if (err.status === 401 && viewer) {
            throw AppError.unauthorized('GitHub session expired, sign in again');
          }
          throw AppError.notFound('Not found on GitHub');
        }
        if (limited) {
          const waitMs = this.rateLimitWaitMs(headers);
          if (waitMs > MAX_RESET_WAIT_MS || attempt >= MAX_RETRIES) {
            throw AppError.rateLimited(new Date(now + waitMs));
          }
          await this.sleep(waitMs);
          continue;
        }
        if (err.status === 422) {
          // GitHub rejects a query it cannot run, for example an unsupported search qualifier.
          throw AppError.badRequest('GitHub could not run this request');
        }
        if (err.status >= 500 && attempt < MAX_RETRIES) {
          await this.sleep(Math.min(2 ** attempt * 250 + Math.random() * 100, 5_000));
          continue;
        }
        throw AppError.upstream();
      }
    }
  }

  private rateLimitWaitMs(headers: Record<string, unknown>): number {
    const retryAfter = Number(headers['retry-after']);
    if (Number.isFinite(retryAfter) && retryAfter >= 0) return retryAfter * 1000;
    const reset = Number(headers['x-ratelimit-reset']);
    if (Number.isFinite(reset)) return Math.max(0, reset * 1000 - this.now()) + 1000;
    // No hint from GitHub: treat it as a long wait so the caller fails fast.
    return MAX_RESET_WAIT_MS + 1;
  }

  private async store(
    key: string,
    body: unknown,
    etag: string | undefined,
    freshMs: number,
  ): Promise<void> {
    const now = this.now();
    await GithubCache.updateOne(
      { key },
      {
        $set: {
          body,
          etag,
          fetchedAt: new Date(now),
          staleAt: new Date(now + freshMs),
          expiresAt: new Date(now + this.keepMs),
        },
      },
      { upsert: true },
    );
  }
}
