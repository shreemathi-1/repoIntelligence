import { Router, type Response } from 'express';
import {
  analyzeRequestSchema,
  graphDiffQuerySchema,
  graphQuerySchema,
  mermaidQuerySchema,
  ownerNameParams,
  traceQuerySchema,
} from '@repointelligence/shared';
import { z } from 'zod';
import { authConfigOf, type Config } from '../config.js';
import { AppError } from '../errors.js';
import { loadViewer } from '../github/viewer.js';
import { diffGraphs } from '../graph/diff.js';
import { DIAGRAMS } from '../graph/mermaid.js';
import { toGraphRun, type GraphService } from '../graph/service.js';
import { traceRoute } from '../graph/trace.js';
import { buildView } from '../graph/views.js';

const shaParams = ownerNameParams.extend({
  sha: z.union([z.literal('latest'), z.string().regex(/^[0-9a-f]{40}$/i)]),
});
const idParams = z.object({ id: z.string().regex(/^[0-9a-f]{24}$/i) });

function userIdOf(locals: Record<string, unknown>): string | undefined {
  return typeof locals.userId === 'string' ? locals.userId : undefined;
}

/** Repository-scoped graph routes. Mounted under /repos behind optionalAuth. */
export function createGraphRepoRouter(config: Config, graphs: GraphService): Router {
  const router = Router();
  const auth = authConfigOf(config);
  const viewerOf = (res: Response) => loadViewer(res.locals.userId, auth);

  router.post('/:owner/:name/graph', async (req, res) => {
    const { owner, name } = ownerNameParams.parse(req.params);
    const userId = userIdOf(res.locals);
    if (!userId) throw AppError.unauthorized('Sign in to map a repository');
    const body = analyzeRequestSchema.parse(req.body ?? {});
    const viewer = await viewerOf(res);
    const { run, reused } = await graphs.start({
      owner,
      name,
      userId,
      ...(body.ref && { ref: body.ref }),
      ...(body.force && { force: body.force }),
      ...(viewer && { viewer }),
    });
    res.status(reused ? 200 : 202).json(toGraphRun(run, reused, null));
  });

  router.get('/:owner/:name/graph/diff', async (req, res) => {
    const { owner, name } = ownerNameParams.parse(req.params);
    const { from, to } = graphDiffQuerySchema.parse(req.query);
    const fullName = `${owner}/${name}`;
    const [before, after] = await Promise.all([
      graphs.load(fullName, from),
      graphs.load(fullName, to),
    ]);
    res.json(diffGraphs(before.graph, after.graph, { from: before.doc.sha, to: after.doc.sha }));
  });

  router.get('/:owner/:name/graph/:sha', async (req, res) => {
    const { owner, name, sha } = shaParams.parse(req.params);
    const { graph, doc } = await graphs.load(`${owner}/${name}`, sha);
    res.json(graphs.summary(graph, doc));
  });

  router.get('/:owner/:name/graph/:sha/view', async (req, res) => {
    const { owner, name, sha } = shaParams.parse(req.params);
    const query = graphQuerySchema.parse(req.query);
    const { graph, doc } = await graphs.load(`${owner}/${name}`, sha);
    res.json(buildView(graph, query, { fullName: doc.fullName, sha: doc.sha }));
  });

  router.get('/:owner/:name/graph/:sha/mermaid', async (req, res) => {
    const { owner, name, sha } = shaParams.parse(req.params);
    const { diagram } = mermaidQuerySchema.parse(req.query);
    const { graph, doc } = await graphs.load(`${owner}/${name}`, sha);
    const text = DIAGRAMS[diagram](graph);
    res
      .type('text/plain; charset=utf-8')
      .setHeader(
        'Content-Disposition',
        `attachment; filename="${owner}-${name}-${doc.sha.slice(0, 12)}-${diagram}.mmd"`,
      )
      .setHeader('X-Commit-Sha', doc.sha)
      .send(
        `%% ${doc.fullName} @ ${doc.sha} (${diagram}, detected from source, not verified)\n${text}\n`,
      );
  });

  router.get('/:owner/:name/graph/:sha/trace', async (req, res) => {
    const { owner, name, sha } = shaParams.parse(req.params);
    const { route, depth } = traceQuerySchema.parse(req.query);
    const { graph } = await graphs.load(`${owner}/${name}`, sha);
    res.json(traceRoute(graph, route, depth));
  });

  router.get('/:owner/:name/source/:sha/*path', async (req, res) => {
    const { owner, name } = ownerNameParams.parse(req.params);
    const sha = z
      .string()
      .regex(/^[0-9a-f]{40}$/i)
      .parse(req.params.sha);
    const raw = req.params.path;
    const path = (Array.isArray(raw) ? raw.join('/') : String(raw)).replace(/^\/+/, '');
    res.json(await graphs.source(owner, name, sha, path, await viewerOf(res)));
  });

  return router;
}

/** Run-scoped routes. Mounted under /graph-builds behind optionalAuth. */
export function createGraphRunRouter(graphs: GraphService): Router {
  const router = Router();

  router.get('/:id', async (req, res) => {
    const { id } = idParams.parse(req.params);
    const run = await graphs.get(id);
    let summary = null;
    if (run.status === 'succeeded' && run.sha) {
      const { graph, doc } = await graphs.load(run.fullName, run.sha);
      summary = graphs.summary(graph, doc);
    }
    res.json(toGraphRun(run, false, summary));
  });

  router.post('/:id/cancel', async (req, res) => {
    const { id } = idParams.parse(req.params);
    const userId = userIdOf(res.locals);
    if (!userId) throw AppError.unauthorized();
    res.json(toGraphRun(await graphs.cancel(id, userId), false, null));
  });

  return router;
}
