import { z } from 'zod';
import type {
  ActivityResponse,
  BeginnerScore,
  CompareResponse,
  ContributeResponse,
  DeveloperProfile,
  RepoCard,
  SearchParams,
  SearchResponse,
  SimilarResponse,
} from '@repointelligence/shared';
import { AppError } from '../errors.js';
import { GithubPendingError, type GithubService, type Viewer } from '../github/service.js';
import { classifyLicense } from './license.js';
import { buildSearchQuery, hasSearchCriteria, searchSort } from './query-builder.js';
import { beginnerScore, inspectRootListing, similarity, type SignalStatus } from './ranking.js';

const DAY_MS = 86_400_000;
const SEARCH_FRESH_MS = 10 * 60_000;
const SLOW_FRESH_MS = 30 * 60_000;

const rawRepo = z.object({
  full_name: z.string(),
  description: z.string().nullable(),
  language: z.string().nullable(),
  stargazers_count: z.number().int().nonnegative(),
  forks_count: z.number().int().nonnegative(),
  open_issues_count: z.number().int().nonnegative(),
  topics: z.array(z.string()).nullish(),
  license: z.object({ spdx_id: z.string().nullable() }).nullish(),
  pushed_at: z.string().nullable(),
  created_at: z.string().nullable().optional(),
  size: z.number().int().nonnegative().nullish(),
  archived: z.boolean().nullish(),
  html_url: z.url(),
});

export const repoCardParser = rawRepo.transform((raw): RepoCard => ({
  fullName: raw.full_name,
  description: raw.description,
  language: raw.language,
  stars: raw.stargazers_count,
  forks: raw.forks_count,
  // GitHub counts open pull requests in this number as well.
  openIssues: raw.open_issues_count,
  topics: raw.topics ?? [],
  // No license object: none found. An object without an id: GitHub could not tell which.
  license: classifyLicense(raw.license ? (raw.license.spdx_id ?? 'NOASSERTION') : null),
  pushedAt: raw.pushed_at,
  createdAt: raw.created_at ?? null,
  sizeKb: raw.size ?? null,
  archived: raw.archived ?? false,
  htmlUrl: raw.html_url,
}));

const searchSchema = z.object({
  total_count: z.number().int().nonnegative(),
  incomplete_results: z.boolean(),
  items: z.array(repoCardParser),
});

const rootListing = z.array(z.object({ name: z.string(), type: z.string() }));

const commitActivity = z
  .array(z.object({ total: z.number().int().nonnegative() }))
  .or(z.literal(''))
  .transform((rows) => (Array.isArray(rows) ? rows.map((r) => r.total) : []));

// Only the number of contributors is kept; the full payload is large.
const contributorCount = z
  .array(z.unknown())
  .or(z.literal(''))
  .transform((rows) => (Array.isArray(rows) ? rows.length : 0));

const issueSearch = z.object({
  total_count: z.number().int().nonnegative(),
  items: z.array(
    z.object({
      number: z.number().int(),
      title: z.string(),
      html_url: z.url(),
      comments: z.number().int().nonnegative(),
      created_at: z.string(),
      repository_url: z.string(),
      labels: z.array(z.object({ name: z.string() })),
    }),
  ),
});

const userSchema = z.object({
  login: z.string(),
  name: z.string().nullable(),
  avatar_url: z.string().nullable(),
  bio: z.string().nullable(),
  public_repos: z.number().int().nonnegative(),
  followers: z.number().int().nonnegative(),
  created_at: z.string(),
});

export interface DiscoveryOptions {
  now?: () => number;
}

/** Observed state of a repository, as the watchlist compares it. */
export interface Observation {
  release: string | null;
  commitSha: string | null;
  commitAt: string | null;
  openIssues: number;
}

const releaseSchema = z.object({ tag_name: z.string() });
const commitsSchema = z.array(
  z.object({
    sha: z.string(),
    commit: z.object({ committer: z.object({ date: z.string() }).nullable() }),
  }),
);

export class DiscoveryService {
  private readonly now: () => number;

  constructor(
    private readonly github: GithubService,
    options: DiscoveryOptions = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  async repoCard(owner: string, name: string, viewer?: Viewer): Promise<RepoCard> {
    const { data } = await this.github.getJson(
      { route: 'GET /repos/{owner}/{repo}', params: { owner, repo: name }, schema: repoCardParser },
      viewer,
    );
    return data;
  }

  async search(params: SearchParams, viewer?: Viewer): Promise<SearchResponse> {
    if (!hasSearchCriteria(params)) {
      throw AppError.badRequest('Provide a search term or at least one filter');
    }
    const query = buildSearchQuery(params, this.now());
    const { data } = await this.github.getJson(
      {
        route: 'GET /search/repositories',
        params: {
          q: query,
          ...searchSort(params),
          per_page: params.perPage,
          page: params.page,
        },
        schema: searchSchema,
        freshMs: SEARCH_FRESH_MS,
      },
      viewer,
    );
    return {
      items: data.items,
      totalCount: data.total_count,
      incomplete: data.incomplete_results,
      page: params.page,
      perPage: params.perPage,
      query,
    };
  }

  async similar(owner: string, name: string, viewer?: Viewer): Promise<SimilarResponse> {
    const base = await this.repoCard(owner, name, viewer);
    const basis = { language: base.language, topics: base.topics };
    const topic = base.topics[0];
    if (!topic && !base.language) return { basis, items: [] };

    const q = [
      topic ? `topic:${topic}` : '',
      base.language
        ? `language:${/[\s+#]/.test(base.language) ? `"${base.language}"` : base.language}`
        : '',
      'archived:false',
    ]
      .filter(Boolean)
      .join(' ');
    const { data } = await this.github.getJson(
      {
        route: 'GET /search/repositories',
        params: { q, sort: 'stars', order: 'desc', per_page: 30 },
        schema: searchSchema,
        freshMs: SLOW_FRESH_MS,
      },
      viewer,
    );
    const items = data.items
      .filter((card) => card.fullName.toLowerCase() !== base.fullName.toLowerCase())
      .map((repo) => ({ repo, similarity: similarity(base, repo) }))
      .sort((a, b) => b.similarity - a.similarity || b.repo.stars - a.repo.stars)
      .slice(0, 10);
    return { basis, items };
  }

  async beginner(
    owner: string,
    name: string,
    viewer?: Viewer,
    card?: RepoCard,
  ): Promise<BeginnerScore> {
    const repo = card ?? (await this.repoCard(owner, name, viewer));
    const [listing, issues] = await Promise.all([
      this.softly(
        this.github.getJson(
          {
            route: 'GET /repos/{owner}/{repo}/contents/',
            params: { owner, repo: name },
            schema: rootListing,
            freshMs: SLOW_FRESH_MS,
          },
          viewer,
        ),
      ),
      this.softly(
        this.github.getJson(
          {
            route: 'GET /search/issues',
            params: {
              q: `repo:${owner}/${name} label:"good first issue" state:open is:issue`,
              per_page: 1,
            },
            schema: issueSearch,
            freshMs: SLOW_FRESH_MS,
          },
          viewer,
        ),
      ),
    ]);

    const unseen: {
      hasReadme: SignalStatus;
      hasContributing: SignalStatus;
      hasTests: SignalStatus;
    } = {
      hasReadme: 'unavailable',
      hasContributing: 'unavailable',
      hasTests: 'unavailable',
    };
    return beginnerScore({
      ...(listing ? inspectRootListing(listing.data) : unseen),
      goodFirstIssues: issues ? issues.data.total_count : null,
      hasLicense: repo.license.category !== 'none',
      pushedAt: repo.pushedAt,
      sizeKb: repo.sizeKb,
      now: this.now(),
    });
  }

  async activity(owner: string, name: string, viewer?: Viewer): Promise<ActivityResponse> {
    const card = await this.repoCard(owner, name, viewer);
    const base = { stars: card.stars, forks: card.forks };
    try {
      const [weeks, people] = await Promise.all([
        this.github.getJson(
          {
            route: 'GET /repos/{owner}/{repo}/stats/commit_activity',
            params: { owner, repo: name },
            schema: commitActivity,
            freshMs: SLOW_FRESH_MS,
          },
          viewer,
        ),
        this.github.getJson(
          {
            route: 'GET /repos/{owner}/{repo}/stats/contributors',
            params: { owner, repo: name },
            schema: contributorCount,
            freshMs: SLOW_FRESH_MS,
          },
          viewer,
        ),
      ]);
      return { status: 'ready', ...base, commitsByWeek: weeks.data, contributors: people.data };
    } catch (err) {
      // 202 means GitHub is building the statistics; asking again shortly will work.
      if (err instanceof GithubPendingError) {
        return { status: 'pending', ...base, commitsByWeek: null, contributors: null };
      }
      throw err;
    }
  }

  async compare(fullNames: string[], viewer?: Viewer): Promise<CompareResponse> {
    const items = await Promise.all(
      fullNames.map(async (fullName): Promise<CompareResponse['items'][number]> => {
        const [owner = '', name = ''] = fullName.split('/');
        try {
          const repo = await this.repoCard(owner, name, viewer);
          const [beginner, weeks] = await Promise.all([
            this.beginner(owner, name, viewer, repo),
            this.softly(
              this.github.getJson(
                {
                  route: 'GET /repos/{owner}/{repo}/stats/commit_activity',
                  params: { owner, repo: name },
                  schema: commitActivity,
                  freshMs: SLOW_FRESH_MS,
                },
                viewer,
              ),
            ),
          ]);
          const recent = weeks?.data.slice(-4);
          return {
            fullName: repo.fullName,
            status: 'ok',
            repo,
            beginner,
            commitsLast4Weeks: recent ? recent.reduce((a, b) => a + b, 0) : null,
          };
        } catch (err) {
          if (err instanceof AppError && err.code === 'RATE_LIMITED') throw err;
          const missing = err instanceof AppError && err.code === 'NOT_FOUND';
          return {
            fullName,
            status: missing ? 'not_found' : 'unavailable',
            repo: null,
            beginner: null,
            commitsLast4Weeks: null,
          };
        }
      }),
    );
    return { items };
  }

  async contribute(
    options: { language?: string; repo?: string; page: number },
    viewer?: Viewer,
  ): Promise<ContributeResponse> {
    const q = [
      'label:"good first issue"',
      'state:open',
      'is:issue',
      'archived:false',
      options.repo ? `repo:${options.repo}` : '',
      options.language
        ? `language:${/[\s+#]/.test(options.language) ? `"${options.language}"` : options.language}`
        : '',
    ]
      .filter(Boolean)
      .join(' ');
    const { data } = await this.github.getJson(
      {
        route: 'GET /search/issues',
        params: { q, sort: 'updated', order: 'desc', per_page: 20, page: options.page },
        schema: issueSearch,
        freshMs: SEARCH_FRESH_MS,
      },
      viewer,
    );
    return {
      totalCount: data.total_count,
      items: data.items.map((issue) => ({
        repo: issue.repository_url.replace('https://api.github.com/repos/', ''),
        number: issue.number,
        title: issue.title,
        htmlUrl: issue.html_url,
        labels: issue.labels.map((l) => l.name),
        comments: issue.comments,
        createdAt: issue.created_at,
      })),
    };
  }

  async developer(login: string, viewer?: Viewer): Promise<DeveloperProfile> {
    const [user, repos] = await Promise.all([
      this.github.getJson(
        {
          route: 'GET /users/{username}',
          params: { username: login },
          schema: userSchema,
          freshMs: SLOW_FRESH_MS,
        },
        viewer,
      ),
      this.github.getJson(
        {
          route: 'GET /users/{username}/repos',
          params: { username: login, sort: 'pushed', per_page: 100, type: 'owner' },
          schema: z.array(repoCardParser),
          freshMs: SLOW_FRESH_MS,
        },
        viewer,
      ),
    ]);

    // Archived repositories no longer reflect what this person is working on.
    const own = repos.data.filter((r) => !r.archived);
    const languages = new Map<string, { repos: number; stars: number }>();
    for (const repo of own) {
      if (!repo.language) continue;
      const entry = languages.get(repo.language) ?? { repos: 0, stars: 0 };
      entry.repos += 1;
      entry.stars += repo.stars;
      languages.set(repo.language, entry);
    }
    const cutoff = this.now() - 90 * DAY_MS;
    return {
      login: user.data.login,
      name: user.data.name,
      avatarUrl: user.data.avatar_url,
      bio: user.data.bio,
      publicRepos: user.data.public_repos,
      followers: user.data.followers,
      memberSince: user.data.created_at,
      totalStars: own.reduce((sum, r) => sum + r.stars, 0),
      activeRepos90d: own.filter((r) => r.pushedAt !== null && Date.parse(r.pushedAt) >= cutoff)
        .length,
      topLanguages: [...languages.entries()]
        .map(([language, v]) => ({ language, ...v }))
        .sort((a, b) => b.repos - a.repos || b.stars - a.stars)
        .slice(0, 6),
      topRepos: [...own].sort((a, b) => b.stars - a.stars).slice(0, 5),
      sampledRepos: repos.data.length,
    };
  }

  async observe(owner: string, name: string, viewer?: Viewer): Promise<Observation> {
    const [card, release, commits] = await Promise.all([
      this.repoCard(owner, name, viewer),
      this.softly(
        this.github.getJson(
          {
            route: 'GET /repos/{owner}/{repo}/releases/latest',
            params: { owner, repo: name },
            schema: releaseSchema,
            freshMs: 5 * 60_000,
          },
          viewer,
        ),
      ),
      this.softly(
        this.github.getJson(
          {
            route: 'GET /repos/{owner}/{repo}/commits',
            params: { owner, repo: name, per_page: 1 },
            schema: commitsSchema,
            freshMs: 5 * 60_000,
          },
          viewer,
        ),
      ),
    ]);
    const latest = commits?.data[0];
    return {
      release: release?.data.tag_name ?? null,
      commitSha: latest?.sha ?? null,
      commitAt: latest?.commit.committer?.date ?? null,
      openIssues: card.openIssues,
    };
  }

  /** Turns a failed optional lookup into undefined, except rate limits, which must surface. */
  private async softly<T>(promise: Promise<T>): Promise<T | undefined> {
    try {
      return await promise;
    } catch (err) {
      if (err instanceof AppError && err.code === 'RATE_LIMITED') throw err;
      return undefined;
    }
  }
}
