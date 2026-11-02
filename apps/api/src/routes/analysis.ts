import { Router } from 'express';
import {
  analyzeRequestSchema,
  ownerNameParams,
  simulateRequestSchema,
} from '@repointelligence/shared';
import { z } from 'zod';
import { authConfigOf, type Config } from '../config.js';
import { toAnalysisRun, type AnalysisService } from '../analysis/service.js';
import { AppError } from '../errors.js';
import { loadViewer } from '../github/viewer.js';

const idParams = z.object({ id: z.string().regex(/^[0-9a-f]{24}$/i) });

function userIdOf(locals: Record<string, unknown>): string | undefined {
  return typeof locals.userId === 'string' ? locals.userId : undefined;
}

/** Repository-scoped analysis routes. Mounted under /repos behind optionalAuth. */
export function createAnalysisRepoRouter(config: Config, analysis: AnalysisService): Router {
  const router = Router();
  const auth = authConfigOf(config);

  router.post('/:owner/:name/analyze', async (req, res) => {
    const { owner, name } = ownerNameParams.parse(req.params);
    const userId = userIdOf(res.locals);
    if (!userId) throw AppError.unauthorized('Sign in to analyse a repository');
    const body = analyzeRequestSchema.parse(req.body ?? {});
    const viewer = await loadViewer(userId, auth);
    const { run, reused } = await analysis.start({
      owner,
      name,
      userId,
      ...(body.ref && { ref: body.ref }),
      ...(body.force && { force: body.force }),
      ...(viewer && { viewer }),
    });
    res.status(reused ? 200 : 202).json(toAnalysisRun(run, reused));
  });

  router.get('/:owner/:name/health', async (req, res) => {
    const { owner, name } = ownerNameParams.parse(req.params);
    const run = await analysis.latest(`${owner}/${name}`);
    if (!run) throw AppError.notFound('This repository has not been analysed yet');
    res.json(toAnalysisRun(run, false));
  });

  router.get('/:owner/:name/health/history', async (req, res) => {
    const { owner, name } = ownerNameParams.parse(req.params);
    res.json({ items: await analysis.history(`${owner}/${name}`) });
  });

  router.post('/:owner/:name/health/simulate', async (req, res) => {
    const { owner, name } = ownerNameParams.parse(req.params);
    const request = simulateRequestSchema.parse(req.body ?? {});
    res.json(await analysis.simulate(`${owner}/${name}`, request));
  });

  return router;
}

/** Run-scoped routes. Mounted under /analyses behind optionalAuth. */
export function createAnalysisRunRouter(analysis: AnalysisService): Router {
  const router = Router();

  router.get('/:id', async (req, res) => {
    const { id } = idParams.parse(req.params);
    res.json(toAnalysisRun(await analysis.get(id), false));
  });

  router.post('/:id/cancel', async (req, res) => {
    const { id } = idParams.parse(req.params);
    const userId = userIdOf(res.locals);
    if (!userId) throw AppError.unauthorized();
    res.json(toAnalysisRun(await analysis.cancel(id, userId), false));
  });

  return router;
}

/** Mounted under /me behind requireAuth. */
export function createQuotaRouter(analysis: AnalysisService): Router {
  const router = Router();
  router.get('/analysis-quota', async (_req, res) => {
    const userId = userIdOf(res.locals);
    if (!userId) throw AppError.unauthorized();
    res.json(await analysis.quota(userId));
  });
  return router;
}
