import type { Logger } from 'pino';
import type { RepoCard, TrendingResponse } from '@repointelligence/shared';
import { AppError } from '../errors.js';
import type { GithubService } from '../github/service.js';
import { JobRecord } from '../models/job-record.js';
import { TrendingSnapshot } from '../models/trending-snapshot.js';
import { repoCardParser } from './service.js';
import { ALL_TOPICS, OVERALL } from './trending-config.js';
import { PERIOD_DAYS, trendingScore } from './ranking.js';
import { z } from 'zod';

const PERIODS = ['daily', 'weekly', 'monthly'] as const;
const NEW_MIN_STARS = { daily: 5, weekly: 20, monthly: 50 } as const;
const ACTIVE_MIN_STARS = 1000;
const LIST_SIZE = 30;

const searchSchema = z.object({ items: z.array(repoCardParser) });

export interface TrendingJobOptions {
  github: GithubService;
  logger: Logger;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Gap between search calls. GitHub allows 30/min with a token and 10/min without. */
  paceMs?: number;
}

export interface TrendingJobResult {
  lists: number;
  failed: string[];
}

const isoDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * Rebuilds every trending list. Each list mixes repositories created inside the window with
 * older ones that were pushed to inside it, then ranks them with trendingScore.
 */
export async function runTrendingJob(options: TrendingJobOptions): Promise<TrendingJobResult> {
  const { github, logger } = options;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const paceMs = options.paceMs ?? 2200;

  const job = await JobRecord.create({ type: 'trending', status: 'active', attempts: 1 });
  const failed: string[] = [];
  let lists = 0;
  let calls = 0;

  const search = async (qualifier: string, base: string): Promise<RepoCard[]> => {
    if (calls++ > 0) await sleep(paceMs);
    const { data } = await github.getJson({
      route: 'GET /search/repositories',
      params: {
        q: [base, qualifier, 'archived:false'].filter(Boolean).join(' '),
        sort: 'stars',
        order: 'desc',
        per_page: LIST_SIZE,
      },
      schema: searchSchema,
      freshMs: 1000,
    });
    return data.items;
  };

  try {
    for (const topic of [{ id: OVERALL, qualifier: '' }, ...ALL_TOPICS]) {
      for (const period of PERIODS) {
        const windowDays = PERIOD_DAYS[period];
        const since = isoDate(now() - windowDays * 86_400_000);
        const label = `${period}|${topic.id}`;
        try {
          const fresh = await search(
            `created:>=${since} stars:>=${NEW_MIN_STARS[period]}`,
            topic.qualifier,
          );
          const active = await search(
            `pushed:>=${since} stars:>=${ACTIVE_MIN_STARS}`,
            topic.qualifier,
          );

          const unique = new Map<string, RepoCard>();
          for (const card of [...fresh, ...active]) unique.set(card.fullName.toLowerCase(), card);
          const items: TrendingResponse['items'] = [...unique.values()]
            .map((repo) => ({ repo, score: trendingScore(repo, windowDays, now()) }))
            .filter((item) => item.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, LIST_SIZE);

          await TrendingSnapshot.updateOne(
            { key: label },
            { $set: { period, topic: topic.id, items, computedAt: new Date(now()) } },
            { upsert: true },
          );
          lists += 1;
        } catch (err) {
          // A rate limit means every later call would fail too, so stop instead of grinding on.
          if (err instanceof AppError && err.code === 'RATE_LIMITED') throw err;
          logger.warn({ err, list: label }, 'trending list failed, keeping the previous one');
          failed.push(label);
        }
      }
    }
    await JobRecord.updateOne(
      { _id: job._id },
      {
        $set: {
          status: failed.length ? 'failed' : 'completed',
          completedAt: new Date(now()),
          lastError: failed.length ? `failed: ${failed.join(', ')}` : undefined,
        },
      },
    );
    logger.info({ lists, failed: failed.length }, 'trending job finished');
    return { lists, failed };
  } catch (err) {
    await JobRecord.updateOne(
      { _id: job._id },
      {
        $set: { status: 'failed', lastError: err instanceof Error ? err.message : 'unknown error' },
      },
    );
    throw err;
  }
}
