import { z } from 'zod';
import { AppError } from '../errors.js';
import { GithubPendingError, type GithubService, type Viewer } from '../github/service.js';

const HOUR_MS = 3_600_000;
/** GitHub's statistics are recomputed at most daily; six hours keeps them reasonably current. */
const STATS_FRESH_MS = 6 * HOUR_MS;
const LIST_FRESH_MS = HOUR_MS;
const IMMUTABLE_FRESH_MS = 7 * 24 * HOUR_MS;
/** Listings of pull requests and issues stop after this many pages of 100. */
export const MAX_LIST_PAGES = 5;
/** Star history reads at most this many pages of stargazers, spread across the whole history. */
export const MAX_STAR_SAMPLES = 12;
/** GitHub stops paginating stargazers here. */
export const STARGAZER_PAGE_LIMIT = 400;

export type Section<T> =
  { status: 'ok'; data: T } | { status: 'pending' | 'unavailable'; reason: string };

/** Statistics endpoints answer 204 with no body for an empty repository. */
const listOrEmpty = <T extends z.ZodType>(item: T) =>
  z
    .union([z.array(item), z.undefined(), z.literal(''), z.null()])
    .transform((v): z.infer<T>[] => (Array.isArray(v) ? v : []));

const commitActivitySchema = listOrEmpty(
  z.object({ week: z.number(), total: z.number().int(), days: z.array(z.number().int()) }),
);
const codeFrequencySchema = listOrEmpty(z.tuple([z.number(), z.number(), z.number()]));
const contributorStatsSchema = listOrEmpty(
  z.object({
    author: z.object({ login: z.string() }).nullable(),
    total: z.number().int(),
    weeks: z.array(z.object({ w: z.number(), a: z.number(), d: z.number(), c: z.number() })),
  }),
);

export const rawCommitSchema = z
  .object({
    sha: z.string(),
    html_url: z.string().optional(),
    commit: z.object({
      message: z.string(),
      author: z.object({ name: z.string().optional(), date: z.string().optional() }).nullable(),
    }),
    author: z.object({ login: z.string() }).nullable().optional(),
  })
  .transform((c) => ({
    sha: c.sha,
    url: c.html_url ?? null,
    message: c.commit.message,
    name: c.commit.author?.name ?? null,
    date: c.commit.author?.date ?? null,
    login: c.author?.login ?? null,
  }));
export type RawCommit = z.output<typeof rawCommitSchema>;
const commitListSchema = z.array(rawCommitSchema);

const releasesSchema = z.array(
  z.object({
    tag_name: z.string(),
    name: z.string().nullable(),
    published_at: z.string().nullable(),
    created_at: z.string(),
    prerelease: z.boolean(),
    draft: z.boolean(),
    html_url: z.string(),
  }),
);
export type RawRelease = z.infer<typeof releasesSchema>[number];
const tagsSchema = z.array(z.object({ name: z.string() }));

const pullsSchema = z.array(
  z.object({
    created_at: z.string(),
    updated_at: z.string(),
    closed_at: z.string().nullable(),
    merged_at: z.string().nullable(),
  }),
);
export type RawPull = z.infer<typeof pullsSchema>[number];
const issuesSchema = z.array(
  z
    .object({
      created_at: z.string(),
      updated_at: z.string(),
      closed_at: z.string().nullable(),
      pull_request: z.unknown().optional(),
    })
    .transform(({ pull_request, ...issue }) => ({ ...issue, isPull: pull_request !== undefined })),
);
export type RawIssue = z.output<typeof issuesSchema>[number];

const stargazersSchema = z.array(z.object({ starred_at: z.string() }));
const repoSchema = z.object({
  stargazers_count: z.number().int(),
  forks_count: z.number().int(),
  open_issues_count: z.number().int(),
  default_branch: z.string(),
  private: z.boolean(),
});
export type RawRepo = z.infer<typeof repoSchema>;
const languagesSchema = z.record(z.string(), z.number());

const compareSchema = z.object({
  status: z.enum(['ahead', 'behind', 'identical', 'diverged']),
  ahead_by: z.number().int(),
  behind_by: z.number().int(),
  total_commits: z.number().int(),
  commits: z.array(rawCommitSchema).default([]),
  files: z
    .array(
      z.object({
        filename: z.string(),
        previous_filename: z.string().optional(),
        status: z.string(),
        additions: z.number().int(),
        deletions: z.number().int(),
      }),
    )
    .default([]),
});
export type RawCompare = z.output<typeof compareSchema>;

const contentsSchema = z.object({ content: z.string(), encoding: z.string() });

/** Commit SHAs never change, so anything addressed by one can be kept for a long time. */
const isSha = (ref: string): boolean => /^[0-9a-f]{40}$/i.test(ref);

export interface HistoryOptions {
  sleep?: (ms: number) => Promise<void>;
  /** How long to wait before asking again while GitHub computes statistics. */
  pendingWaitMs?: number;
}

/** Read-only access to the parts of GitHub that describe a repository's history. */
export class GithubHistory {
  private readonly params: { owner: string; repo: string };
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pendingWaitMs: number;

  constructor(
    private readonly github: GithubService,
    owner: string,
    name: string,
    private readonly viewer: Viewer | undefined,
    options: HistoryOptions = {},
  ) {
    this.params = { owner, repo: name };
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.pendingWaitMs = options.pendingWaitMs ?? 1500;
  }

  private async get<T>(
    route: string,
    schema: z.ZodType<T>,
    params: Record<string, string | number | undefined> = {},
    extra: { freshMs?: number; accept?: string } = {},
  ): Promise<T> {
    const { data } = await this.github.getJson(
      {
        route,
        params: { ...this.params, ...params },
        schema,
        freshMs: extra.freshMs ?? LIST_FRESH_MS,
        ...(extra.accept && { accept: extra.accept }),
      },
      this.viewer,
    );
    return data;
  }

  /**
   * Wraps one optional part of a response. GitHub's 202 is retried twice, then reported as
   * pending; other failures become unavailable. A rate limit still stops the whole request.
   */
  async section<T>(load: () => Promise<T>, unavailable = 'GitHub did not return this data'): Promise<Section<T>> {
    for (let attempt = 0; ; attempt++) {
      try {
        return { status: 'ok', data: await load() };
      } catch (err) {
        if (err instanceof GithubPendingError) {
          if (attempt >= 2) return { status: 'pending', reason: 'GitHub is still computing these statistics; try again in a minute' };
          await this.sleep(this.pendingWaitMs);
          continue;
        }
        if (err instanceof AppError && err.code === 'RATE_LIMITED') throw err;
        if (err instanceof AppError && err.code === 'BAD_REQUEST') {
          return { status: 'unavailable', reason: 'GitHub does not compute this for very large repositories' };
        }
        return { status: 'unavailable', reason: unavailable };
      }
    }
  } // prettier-ignore

  repo(): Promise<RawRepo> {
    return this.get('GET /repos/{owner}/{repo}', repoSchema);
  }

  commitActivity() {
    return this.get('GET /repos/{owner}/{repo}/stats/commit_activity', commitActivitySchema, {}, { freshMs: STATS_FRESH_MS });
  } // prettier-ignore

  codeFrequency() {
    return this.get('GET /repos/{owner}/{repo}/stats/code_frequency', codeFrequencySchema, {}, { freshMs: STATS_FRESH_MS });
  } // prettier-ignore

  contributorStats() {
    return this.get('GET /repos/{owner}/{repo}/stats/contributors', contributorStatsSchema, {}, { freshMs: STATS_FRESH_MS });
  } // prettier-ignore

  commits(ref: string | undefined, page: number): Promise<RawCommit[]> {
    return this.get('GET /repos/{owner}/{repo}/commits', commitListSchema, {
      sha: ref,
      page,
      per_page: 100,
    });
  }

  releases(): Promise<RawRelease[]> {
    return this.get('GET /repos/{owner}/{repo}/releases', releasesSchema, { per_page: 50 });
  }

  tags(): Promise<{ name: string }[]> {
    return this.get('GET /repos/{owner}/{repo}/tags', tagsSchema, { per_page: 50 });
  }

  languages(): Promise<Record<string, number>> {
    return this.get('GET /repos/{owner}/{repo}/languages', languagesSchema);
  }

  /**
   * Pull requests with any activity since `since`, newest activity first. Anything opened, merged
   * or closed after `since` was also updated after it, so the listing is complete back to the
   * oldest update it reached. Returns that point when the page cap cut the listing short.
   */
  async pullsSince(since: number): Promise<{ items: RawPull[]; coveredFrom: string | null }> {
    const items: RawPull[] = [];
    for (let page = 1; page <= MAX_LIST_PAGES; page++) {
      const batch = await this.get('GET /repos/{owner}/{repo}/pulls', pullsSchema, {
        state: 'all',
        sort: 'updated',
        direction: 'desc',
        per_page: 100,
        page,
      });
      items.push(...batch);
      const oldest = batch.at(-1);
      if (batch.length < 100 || !oldest || Date.parse(oldest.updated_at) < since) {
        return { items, coveredFrom: null };
      }
    }
    return { items, coveredFrom: items.at(-1)?.updated_at ?? null };
  }

  /** Issues (not pull requests) with activity since `since`; see `pullsSince`. */
  async issuesSince(since: number): Promise<{ items: RawIssue[]; coveredFrom: string | null }> {
    const items: RawIssue[] = [];
    for (let page = 1; page <= MAX_LIST_PAGES; page++) {
      const batch = await this.get('GET /repos/{owner}/{repo}/issues', issuesSchema, {
        state: 'all',
        sort: 'updated',
        direction: 'desc',
        since: new Date(since).toISOString(),
        per_page: 100,
        page,
      });
      items.push(...batch.filter((i) => !i.isPull));
      if (batch.length < 100) return { items, coveredFrom: null };
    }
    return { items, coveredFrom: items.at(-1)?.updated_at ?? null };
  }

  /**
   * Star counts over time, from the first stargazer on evenly spread pages. Page `p` starts with
   * star number `(p - 1) * 100 + 1`, so each sample is an exact point on the curve.
   */
  async starHistory(stars: number): Promise<{ points: { at: string; stars: number }[]; sampled: boolean }> {
    const pages = Math.min(Math.ceil(stars / 100), STARGAZER_PAGE_LIMIT);
    if (pages === 0) return { points: [], sampled: false };
    const picks = pages <= MAX_STAR_SAMPLES
      ? Array.from({ length: pages }, (_, i) => i + 1)
      : [...new Set(Array.from({ length: MAX_STAR_SAMPLES }, (_, i) => Math.round(1 + (i * (pages - 1)) / (MAX_STAR_SAMPLES - 1))))];
    const samples = await Promise.all(
      picks.map(async (page) => {
        const batch = await this.get('GET /repos/{owner}/{repo}/stargazers', stargazersSchema, { per_page: 100, page }, { freshMs: 24 * HOUR_MS, accept: 'application/vnd.github.star+json' });
        const first = batch[0];
        return first ? { at: first.starred_at, stars: (page - 1) * 100 + 1 } : null;
      }),
    );
    return { points: samples.filter((s) => s !== null), sampled: picks.length < Math.ceil(stars / 100) };
  } // prettier-ignore

  compare(base: string, head: string): Promise<RawCompare> {
    return this.get(
      'GET /repos/{owner}/{repo}/compare/{basehead}',
      compareSchema,
      { basehead: `${base}...${head}`, per_page: 250 },
      { freshMs: isSha(base) && isSha(head) ? IMMUTABLE_FRESH_MS : 10 * 60_000 },
    );
  }

  /** A text file at a ref, or null when it does not exist there or is too large to inline. */
  async file(path: string, ref: string): Promise<string | null> {
    try {
      const data = await this.get(
        'GET /repos/{owner}/{repo}/contents/{path}',
        contentsSchema,
        { path, ref },
        { freshMs: isSha(ref) ? IMMUTABLE_FRESH_MS : 10 * 60_000 },
      );
      if (data.encoding !== 'base64') return null;
      return Buffer.from(data.content, 'base64').toString('utf8');
    } catch (err) {
      if (err instanceof AppError && err.code === 'NOT_FOUND') return null;
      throw err;
    }
  }
}
