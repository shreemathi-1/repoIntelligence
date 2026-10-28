import { Router, type Request, type Response } from 'express';
import {
  compareQuerySchema,
  contributeQuerySchema,
  ownerNameParams,
  searchParamsSchema,
  trendingQuerySchema,
  type TrendingResponse,
} from '@repointelligence/shared';
import { z } from 'zod';
import { authConfigOf, type Config } from '../config.js';
import { recordHistory } from '../discovery/history.js';
import type { DiscoveryService } from '../discovery/service.js';
import { ALL_TOPICS, OVERALL, TECHNOLOGIES, USE_CASES } from '../discovery/trending-config.js';
import { AppError } from '../errors.js';
import { loadViewer } from '../github/viewer.js';
import { TrendingSnapshot } from '../models/trending-snapshot.js';

const login = z.object({ login: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/) });

/** Public discovery. A signed-in visitor's own token is used when there is one. */
export function createDiscoveryRouter(config: Config, discovery: DiscoveryService): Router {
  const router = Router();
  const auth = authConfigOf(config);
  const viewerOf = (res: Response) => loadViewer(res.locals.userId, auth);
  const userIdOf = (res: Response): string | undefined =>
    typeof res.locals.userId === 'string' ? res.locals.userId : undefined;
  const repoParams = (req: Request) => ownerNameParams.parse(req.params);

  router.get('/search', async (req, res) => {
    const params = searchParamsSchema.parse(req.query);
    const result = await discovery.search(params, await viewerOf(res));
    const userId = userIdOf(res);
    if (userId) {
      await recordHistory(userId, { kind: 'search', query: result.query, filters: params });
    }
    res.json(result);
  });

  router.get('/trending/topics', (_req, res) => {
    const pick = (list: typeof TECHNOLOGIES) => list.map(({ id, label }) => ({ id, label }));
    res.json({ technologies: pick(TECHNOLOGIES), useCases: pick(USE_CASES) });
  });

  router.get('/trending', async (req, res) => {
    const { period, topic } = trendingQuerySchema.parse(req.query);
    if (topic && !ALL_TOPICS.some((t) => t.id === topic)) {
      throw AppError.badRequest('Unknown trending topic');
    }
    const snapshot = await TrendingSnapshot.findOne({
      key: `${period}|${topic ?? OVERALL}`,
    }).lean();
    const body: TrendingResponse = {
      period,
      topic: topic ?? null,
      computedAt: snapshot?.computedAt.toISOString() ?? null,
      estimate: true,
      items: snapshot ? (snapshot.items as TrendingResponse['items']) : [],
    };
    res.json(body);
  });

  router.get('/compare', async (req, res) => {
    const { repos } = compareQuerySchema.parse(req.query);
    res.json(await discovery.compare(repos, await viewerOf(res)));
  });

  router.get('/contribute', async (req, res) => {
    const query = contributeQuerySchema.parse(req.query);
    res.json(await discovery.contribute(query, await viewerOf(res)));
  });

  router.get('/developers/:login', async (req, res) => {
    const { login: name } = login.parse(req.params);
    res.json(await discovery.developer(name, await viewerOf(res)));
  });

  router.get('/repos/:owner/:name/similar', async (req, res) => {
    const { owner, name } = repoParams(req);
    res.json(await discovery.similar(owner, name, await viewerOf(res)));
  });

  router.get('/repos/:owner/:name/beginner', async (req, res) => {
    const { owner, name } = repoParams(req);
    res.json(await discovery.beginner(owner, name, await viewerOf(res)));
  });

  router.get('/repos/:owner/:name/activity', async (req, res) => {
    const { owner, name } = repoParams(req);
    res.json(await discovery.activity(owner, name, await viewerOf(res)));
  });

  return router;
}
