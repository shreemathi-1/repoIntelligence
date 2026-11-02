import { z } from 'zod';
import { AppError } from '../errors.js';
import type { GithubService, Viewer } from '../github/service.js';
import type { GithubSignals } from './inputs.js';

const DAY_MS = 86_400_000;
const FRESH_MS = 30 * 60_000;

const repoSchema = z.object({ archived: z.boolean(), pushed_at: z.string().nullable() });
const countSchema = z.array(z.unknown()).transform((rows) => rows.length);
const releasesSchema = z.array(
  z.object({ published_at: z.string().nullable(), draft: z.boolean() }),
);
const contributorsSchema = z.array(z.object({ contributions: z.number().int().nonnegative() }));
const issuesSchema = z.array(
  z.object({
    number: z.number().int(),
    created_at: z.string(),
    comments: z.number().int(),
    pull_request: z.unknown().optional(),
  }),
);
const commentsSchema = z.array(z.object({ issue_url: z.string(), created_at: z.string() }));
const checkRunsSchema = z.object({
  check_runs: z.array(z.object({ conclusion: z.string().nullable(), status: z.string() })),
});

/** A failed optional lookup becomes null, except a rate limit, which must stop the run. */
async function softly<T>(promise: Promise<{ data: T }>): Promise<T | null> {
  try {
    return (await promise).data;
  } catch (err) {
    if (err instanceof AppError && err.code === 'RATE_LIMITED') throw err;
    return null;
  }
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[mid] ?? null)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/** Collects the repository facts that live in GitHub rather than in the files. */
export async function collectSignals(
  github: GithubService,
  owner: string,
  name: string,
  sha: string,
  viewer: Viewer | undefined,
  now: number = Date.now(),
): Promise<GithubSignals> {
  const params = { owner, repo: name };
  const since = new Date(now - 90 * DAY_MS).toISOString();
  const yearAgo = now - 365 * DAY_MS;

  const [repo, commits, releases, contributors, issues, comments, checks] = await Promise.all([
    softly(
      github.getJson(
        { route: 'GET /repos/{owner}/{repo}', params, schema: repoSchema, freshMs: FRESH_MS },
        viewer,
      ),
    ),
    softly(
      github.getJson(
        {
          route: 'GET /repos/{owner}/{repo}/commits',
          params: { ...params, since, per_page: 100 },
          schema: countSchema,
          freshMs: FRESH_MS,
        },
        viewer,
      ),
    ),
    softly(
      github.getJson(
        {
          route: 'GET /repos/{owner}/{repo}/releases',
          params: { ...params, per_page: 50 },
          schema: releasesSchema,
          freshMs: FRESH_MS,
        },
        viewer,
      ),
    ),
    softly(
      github.getJson(
        {
          route: 'GET /repos/{owner}/{repo}/contributors',
          params: { ...params, per_page: 100, anon: 'false' },
          schema: contributorsSchema,
          freshMs: FRESH_MS,
        },
        viewer,
      ),
    ),
    softly(
      github.getJson(
        {
          route: 'GET /repos/{owner}/{repo}/issues',
          params: { ...params, state: 'all', sort: 'created', direction: 'desc', per_page: 30 },
          schema: issuesSchema,
          freshMs: FRESH_MS,
        },
        viewer,
      ),
    ),
    softly(
      github.getJson(
        {
          route: 'GET /repos/{owner}/{repo}/issues/comments',
          params: { ...params, sort: 'created', direction: 'desc', per_page: 100 },
          schema: commentsSchema,
          freshMs: FRESH_MS,
        },
        viewer,
      ),
    ),
    softly(
      github.getJson(
        {
          route: 'GET /repos/{owner}/{repo}/commits/{ref}/check-runs',
          params: { ...params, ref: sha, per_page: 100 },
          schema: checkRunsSchema,
          freshMs: FRESH_MS,
        },
        viewer,
      ),
    ),
  ]);

  // Issue response: for each real issue (not a PR), the earliest comment after it was opened.
  const realIssues = (issues ?? []).filter((i) => i.pull_request === undefined);
  const firstComment = new Map<number, number>();
  for (const comment of comments ?? []) {
    const number = Number(comment.issue_url.split('/').pop());
    const at = Date.parse(comment.created_at);
    const seen = firstComment.get(number);
    if (seen === undefined || at < seen) firstComment.set(number, at);
  }
  const responseHours: number[] = [];
  for (const issue of realIssues) {
    const first = firstComment.get(issue.number);
    if (first !== undefined)
      responseHours.push(Math.max(0, (first - Date.parse(issue.created_at)) / 3_600_000));
  }

  let topShare: number | null = null;
  let core: number | null = null;
  if (contributors && contributors.length > 0) {
    const total = contributors.reduce((sum, c) => sum + c.contributions, 0);
    if (total > 0) {
      topShare = Math.max(...contributors.map((c) => c.contributions)) / total;
      core = contributors.filter((c) => c.contributions / total > 0.1).length;
    }
  }

  return {
    archived: repo?.archived ?? false,
    pushedAt: repo?.pushed_at ?? null,
    commitsLast90Days: commits,
    releasesLastYear: releases
      ? releases.filter(
          (r) => !r.draft && r.published_at !== null && Date.parse(r.published_at) >= yearAgo,
        ).length
      : null,
    contributors: contributors ? contributors.length : null,
    topContributorShare: topShare === null ? null : Math.round(topShare * 1000) / 1000,
    maintainersOver10Percent: core,
    medianFirstResponseHours: comments === null ? null : median(responseHours),
    issuesSampled: comments === null ? 0 : realIssues.length,
    checkRuns: checks
      ? checks.check_runs
          .filter((c) => c.status === 'completed')
          .map((c) => c.conclusion ?? 'unknown')
      : null,
  };
}
