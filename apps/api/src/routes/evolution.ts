import { Router, type Response } from 'express';
import {
  evolutionQuerySchema,
  ownerNameParams,
  refCompareQuerySchema,
  releaseSummaryRequestSchema,
  snapshotCompareQuerySchema,
  timelineQuerySchema,
} from '@repointelligence/shared';
import { authConfigOf, type Config } from '../config.js';
import { AppError } from '../errors.js';
import type { EvolutionService } from '../evolution/service.js';
import { loadViewer } from '../github/viewer.js';

/**
 * Repository history routes. Mounted under /repos behind optionalAuth: anonymous visitors read
 * public repositories with the server token; a signed-in user's own token covers private ones.
 */
export function createEvolutionRouter(config: Config, evolution: EvolutionService): Router {
  const router = Router();
  const auth = authConfigOf(config);
  const target = async (params: unknown, res: Response) => {
    const { owner, name } = ownerNameParams.parse(params);
    return { owner, name, viewer: await loadViewer(res.locals.userId, auth) };
  };

  router.get('/:owner/:name/evolution/timeline', async (req, res) => {
    const query = timelineQuerySchema.parse(req.query);
    res.json(await evolution.timeline(await target(req.params, res), query));
  });

  router.get('/:owner/:name/evolution/activity', async (req, res) => {
    const { weeks } = evolutionQuerySchema.parse(req.query);
    res.json(await evolution.activity(await target(req.params, res), weeks));
  });

  router.get('/:owner/:name/evolution/releases', async (req, res) => {
    const { weeks } = evolutionQuerySchema.parse(req.query);
    res.json(await evolution.releases(await target(req.params, res), weeks));
  });

  router.get('/:owner/:name/evolution/compare', async (req, res) => {
    const { base, head } = refCompareQuerySchema.parse(req.query);
    res.json(await evolution.compare(await target(req.params, res), base, head));
  });

  router.get('/:owner/:name/evolution/dependencies', async (req, res) => {
    const { base, head } = refCompareQuerySchema.parse(req.query);
    res.json(await evolution.dependencies(await target(req.params, res), base, head));
  });

  router.get('/:owner/:name/evolution/languages', async (req, res) => {
    res.json(await evolution.languages(await target(req.params, res)));
  });

  router.get('/:owner/:name/evolution/quality', async (req, res) => {
    res.json(await evolution.quality(await target(req.params, res)));
  });

  router.get('/:owner/:name/evolution/snapshots/compare', async (req, res) => {
    const { a, b } = snapshotCompareQuerySchema.parse(req.query);
    res.json(await evolution.snapshotCompare(await target(req.params, res), a, b));
  });

  router.get('/:owner/:name/evolution/architecture', async (req, res) => {
    res.json(await evolution.architecture(await target(req.params, res)));
  });

  router.post('/:owner/:name/evolution/release-summary', async (req, res) => {
    const userId = typeof res.locals.userId === 'string' ? res.locals.userId : undefined;
    if (!userId) throw AppError.unauthorized('Sign in to summarise a release');
    const request = releaseSummaryRequestSchema.parse(req.body ?? {});
    const summary = await evolution.releaseSummary(await target(req.params, res), request, userId);
    res.status(summary.reused ? 200 : 201).json(summary);
  });

  return router;
}
