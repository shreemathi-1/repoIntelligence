import { Router, type Response } from 'express';
import {
  MAX_STACK_PROFILES,
  adaptabilityExportQuerySchema,
  checklistUpdateSchema,
  evaluateRequestSchema,
  ownerNameParams,
  parseManifestRequestSchema,
  stackProfileInputSchema,
} from '@repointelligence/shared';
import { z } from 'zod';
import type { AdaptabilityService } from '../adaptability/service.js';
import { authConfigOf, type Config } from '../config.js';
import { AppError } from '../errors.js';
import { loadViewer } from '../github/viewer.js';

const idParams = z.object({ id: z.string().regex(/^[0-9a-f]{24}$/i) });
const userOf = (res: Response): string | undefined =>
  typeof res.locals.userId === 'string' ? res.locals.userId : undefined;

function requireUser(res: Response): string {
  const userId = userOf(res);
  if (!userId) throw AppError.unauthorized();
  return userId;
}

/** Saved stacks. Mounted under /me behind requireAuth. */
export function createStackProfileRouter(adaptability: AdaptabilityService): Router {
  const router = Router();

  router.get('/stack-profiles', async (_req, res) => {
    res.json({ profiles: await adaptability.profiles(requireUser(res)), limit: MAX_STACK_PROFILES });
  }); // prettier-ignore

  router.post('/stack-profiles', async (req, res) => {
    const input = stackProfileInputSchema.parse(req.body);
    res.status(201).json(await adaptability.createProfile(requireUser(res), input));
  });

  router.put('/stack-profiles/:id', async (req, res) => {
    const { id } = idParams.parse(req.params);
    const input = stackProfileInputSchema.parse(req.body);
    res.json(await adaptability.updateProfile(requireUser(res), id, input));
  });

  router.delete('/stack-profiles/:id', async (req, res) => {
    const { id } = idParams.parse(req.params);
    await adaptability.deleteProfile(requireUser(res), id);
    res.status(204).end();
  });

  return router;
}

/** Evaluation of one repository. Mounted under /repos behind optionalAuth. */
export function createAdaptabilityRepoRouter(config: Config, adaptability: AdaptabilityService): Router {
  const router = Router();
  const auth = authConfigOf(config);
  const target = async (params: unknown, res: Response) => {
    const { owner, name } = ownerNameParams.parse(params);
    return { owner, name, userId: userOf(res), viewer: await loadViewer(res.locals.userId, auth) };
  };

  router.post('/:owner/:name/adaptability', async (req, res) => {
    const request = evaluateRequestSchema.parse(req.body);
    res.json(await adaptability.evaluate(await target(req.params, res), request));
  });

  router.post('/:owner/:name/adaptability/alternatives', async (req, res) => {
    const request = evaluateRequestSchema.parse(req.body);
    res.json(await adaptability.alternatives(await target(req.params, res), request));
  });

  return router;
} // prettier-ignore

/** Stored reports and the manifest reader. Mounted under /adaptability behind optionalAuth. */
export function createAdaptabilityRouter(adaptability: AdaptabilityService): Router {
  const router = Router();

  router.post('/parse-manifest', (req, res) => {
    const { filename, content } = parseManifestRequestSchema.parse(req.body);
    res.json(adaptability.parseManifest(filename, content));
  });

  router.get('/:id', async (req, res) => {
    const { id } = idParams.parse(req.params);
    res.json(await adaptability.get(id, requireUser(res)));
  });

  router.put('/:id/checklist', async (req, res) => {
    const { id } = idParams.parse(req.params);
    const { done } = checklistUpdateSchema.parse(req.body);
    res.json(await adaptability.setChecklist(id, requireUser(res), done));
  });

  router.post('/:id/explain', async (req, res) => {
    const { id } = idParams.parse(req.params);
    res.json(await adaptability.explain(id, requireUser(res)));
  });

  router.get('/:id/export', async (req, res) => {
    const { id } = idParams.parse(req.params);
    const { format } = adaptabilityExportQuerySchema.parse(req.query);
    const out = await adaptability.export(id, requireUser(res), format);
    res
      .type(out.type)
      .setHeader('Content-Disposition', `attachment; filename="${out.filename}"`)
      .send(out.body);
  });

  return router;
}
