import { Router, type Response } from 'express';
import {
  onboardingQuerySchema,
  ownerNameParams,
  planExportQuerySchema,
  planRequestSchema,
  progressUpdateSchema,
} from '@repointelligence/shared';
import { z } from 'zod';
import { authConfigOf, type Config } from '../config.js';
import { AppError } from '../errors.js';
import { loadViewer } from '../github/viewer.js';
import type { PlannerService } from '../planner/service.js';

const idParams = z.object({ id: z.string().regex(/^[0-9a-f]{24}$/i) });
const userOf = (res: Response): string | undefined =>
  typeof res.locals.userId === 'string' ? res.locals.userId : undefined;

function requireUser(res: Response, message?: string): string {
  const userId = userOf(res);
  if (!userId) throw AppError.unauthorized(message);
  return userId;
}

/** Onboarding, starter issues and plans for one repository. Mounted under /repos behind optionalAuth. */
export function createPlannerRepoRouter(config: Config, planner: PlannerService): Router {
  const router = Router();
  const auth = authConfigOf(config);
  const target = async (params: unknown, res: Response) => {
    const { owner, name } = ownerNameParams.parse(params);
    return { owner, name, userId: userOf(res), viewer: await loadViewer(res.locals.userId, auth) };
  };

  router.get('/:owner/:name/onboarding', async (req, res) => {
    const { mode } = onboardingQuerySchema.parse(req.query);
    res.json(await planner.onboarding(await target(req.params, res), mode));
  });

  router.put('/:owner/:name/onboarding/progress', async (req, res) => {
    const userId = requireUser(res, 'Sign in to keep your progress');
    const { done } = progressUpdateSchema.parse(req.body);
    await planner.setOnboardingProgress(await target(req.params, res), userId, done);
    res.status(204).end();
  });

  router.get('/:owner/:name/starter-issues', async (req, res) => {
    res.json(await planner.starterIssues(await target(req.params, res)));
  });

  router.get('/:owner/:name/plans', async (req, res) => {
    res.json(await planner.plans(await target(req.params, res), requireUser(res)));
  });

  router.post('/:owner/:name/plans', async (req, res) => {
    const userId = requireUser(res, 'Sign in to plan a feature');
    const { goal } = planRequestSchema.parse(req.body);
    res.status(201).json(await planner.createPlan(await target(req.params, res), userId, goal));
  });

  return router;
}

/** Stored plans. Mounted under /plans behind requireAuth. */
export function createPlanRouter(planner: PlannerService): Router {
  const router = Router();

  router.get('/:id', async (req, res) => {
    const { id } = idParams.parse(req.params);
    res.json(await planner.plan(id, requireUser(res)));
  });

  router.delete('/:id', async (req, res) => {
    const { id } = idParams.parse(req.params);
    await planner.deletePlan(id, requireUser(res));
    res.status(204).end();
  });

  router.put('/:id/progress', async (req, res) => {
    const { id } = idParams.parse(req.params);
    const { done } = progressUpdateSchema.parse(req.body);
    res.json(await planner.setPlanProgress(id, requireUser(res), done));
  });

  router.get('/:id/export', async (req, res) => {
    const { id } = idParams.parse(req.params);
    const { format } = planExportQuerySchema.parse(req.query);
    const out = await planner.exportPlan(id, requireUser(res), format);
    res
      .type('text/markdown')
      .setHeader('Content-Disposition', `attachment; filename="${out.filename}"`)
      .send(out.body);
  });

  return router;
}
