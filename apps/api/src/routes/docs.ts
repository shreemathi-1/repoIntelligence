import { Router, type Response } from 'express';
import {
  docExportQuerySchema,
  docListSchema,
  docPullRequestRequestSchema,
  generateDocRequestSchema,
  ownerNameParams,
  updateDocRequestSchema,
  type DocList,
} from '@repointelligence/shared';
import { z } from 'zod';
import { authConfigOf, type Config } from '../config.js';
import { AppError } from '../errors.js';
import { loadViewer } from '../github/viewer.js';
import { toDocView, toPullRequestView, type DocsService } from '../docs/service.js';

const idParams = z.object({ id: z.string().regex(/^[0-9a-f]{24}$/i) });

function requireUser(res: Response, message?: string): string {
  const userId = typeof res.locals.userId === 'string' ? res.locals.userId : undefined;
  if (!userId) throw AppError.unauthorized(message);
  return userId;
}

/** Repository-scoped documentation routes. Mounted under /repos behind optionalAuth. */
export function createDocsRepoRouter(config: Config, docs: DocsService): Router {
  const router = Router();
  const auth = authConfigOf(config);
  const viewerOf = (res: Response) => loadViewer(res.locals.userId, auth);

  router.get('/:owner/:name/docs', async (req, res) => {
    const { owner, name } = ownerNameParams.parse(req.params);
    const list = await docs.list(`${owner}/${name}`, requireUser(res));
    const body: DocList = {
      docs: list.map((d) => docListSchema.shape.docs.element.parse(toDocView(d))),
    };
    res.json(body);
  });

  router.post('/:owner/:name/docs', async (req, res) => {
    const { owner, name } = ownerNameParams.parse(req.params);
    const userId = requireUser(res, 'Sign in to generate documentation');
    const body = generateDocRequestSchema.parse(req.body);
    const viewer = await viewerOf(res);
    const { doc, reused } = await docs.generate({
      owner,
      name,
      userId,
      kind: body.kind,
      ...(body.force && { force: true }),
      ...(body.from && { from: body.from }),
      ...(body.to && { to: body.to }),
      ...(viewer && { viewer }),
    });
    res.status(reused ? 200 : 201).json(toDocView(doc));
  });

  router.get('/:owner/:name/docs/missing', async (req, res) => {
    const { owner, name } = ownerNameParams.parse(req.params);
    const userId = typeof res.locals.userId === 'string' ? res.locals.userId : undefined;
    res.json(await docs.missing(`${owner}/${name}`, userId, await viewerOf(res)));
  });

  return router;
}

/** Document routes. Mounted under /docs behind optionalAuth. */
export function createDocsRouter(config: Config, docs: DocsService): Router {
  const router = Router();
  const auth = authConfigOf(config);
  const viewerOf = (res: Response) => loadViewer(res.locals.userId, auth);

  // Before /:id so "pull-requests" is not read as an id.
  router.post('/pull-requests', async (req, res) => {
    const userId = requireUser(res, 'Sign in to propose a pull request');
    const body = docPullRequestRequestSchema.parse(req.body);
    const pr = await docs.propose(body, userId, await viewerOf(res));
    res.status(201).json(toPullRequestView(pr));
  });

  router.get('/:id', async (req, res) => {
    const { id } = idParams.parse(req.params);
    res.json(toDocView(await docs.get(id, requireUser(res))));
  });

  router.patch('/:id', async (req, res) => {
    const { id } = idParams.parse(req.params);
    const { content, title } = updateDocRequestSchema.parse(req.body);
    res.json(toDocView(await docs.update(id, requireUser(res), content, title)));
  });

  router.delete('/:id', async (req, res) => {
    const { id } = idParams.parse(req.params);
    await docs.remove(id, requireUser(res));
    res.status(204).end();
  });

  router.get('/:id/export', async (req, res) => {
    const { id } = idParams.parse(req.params);
    const { format, links } = docExportQuerySchema.parse(req.query);
    const doc = await docs.get(id, requireUser(res));
    const out = docs.render(doc, format, links);
    res
      .type(out.type)
      .setHeader('Content-Disposition', `attachment; filename="${out.filename}"`)
      .setHeader('X-Commit-Sha', doc.sha)
      .send(out.body);
  });

  router.post('/:id/review', async (req, res) => {
    const { id } = idParams.parse(req.params);
    res.json(await docs.review(id, requireUser(res), await viewerOf(res)));
  });

  router.get('/:id/drift', async (req, res) => {
    const { id } = idParams.parse(req.params);
    res.json(await docs.drift(id, requireUser(res), await viewerOf(res)));
  });

  return router;
}

/** Mounted under /me behind requireAuth. */
export function createDocQuotaRouter(docs: DocsService): Router {
  const router = Router();
  router.get('/docs-quota', async (_req, res) => {
    res.json(await docs.quota(requireUser(res)));
  });
  return router;
}
