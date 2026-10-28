import { Router, type Response } from 'express';
import mongoose from 'mongoose';
import { exportQuerySchema, ingestRequestSchema, ownerNameParams } from '@repointelligence/shared';
import { z } from 'zod';
import { authConfigOf, type Config } from '../config.js';
import { AppError } from '../errors.js';
import { loadViewer } from '../github/viewer.js';
import { exportBundle, exportJson, exportMarkdown, exportText } from '../ingest/exporters.js';
import { toIngestion, type IngestionService } from '../ingest/service.js';
import { IngestionRun } from '../models/ingestion-run.js';

const runParams = ownerNameParams.extend({
  sha: z.union([z.literal('latest'), z.string().regex(/^[0-9a-f]{40}$/i)]),
});

const CONTENT_TYPE = {
  markdown: 'text/markdown; charset=utf-8',
  json: 'application/json; charset=utf-8',
  text: 'text/plain; charset=utf-8',
  bundle: 'text/markdown; charset=utf-8',
} as const;
const EXTENSION = { markdown: 'md', json: 'json', text: 'txt', bundle: 'context.md' } as const;

/**
 * Ingestion and exports. Starting an ingestion needs a session (it uses that user's GitHub
 * quota); reading a public repository's results does not.
 */
export function createIngestRouter(config: Config, ingestion: IngestionService): Router {
  const router = Router();
  const auth = authConfigOf(config);
  const viewerOf = (res: Response) => loadViewer(res.locals.userId, auth);

  /** A run the caller may read. Private runs are invisible to everyone but their owner. */
  async function findReadable(owner: string, name: string, sha: string, res: Response) {
    const fullName = `${owner}/${name}`.toLowerCase();
    const run =
      sha === 'latest'
        ? await IngestionRun.findOne({ fullName, status: { $in: ['completed', 'partial'] } }).sort({
            completedAt: -1,
          })
        : await IngestionRun.findOne({ fullName, sha: sha.toLowerCase() });
    const userId = typeof res.locals.userId === 'string' ? res.locals.userId : undefined;
    const owns = Boolean(
      userId && mongoose.isValidObjectId(userId) && run?.requestedBy.equals(userId),
    );
    if (!run || (run.private && !owns))
      throw AppError.notFound('No ingestion found for this repository and commit');
    return run;
  }

  router.post('/:owner/:name/ingest', async (req, res) => {
    const { owner, name } = ownerNameParams.parse(req.params);
    const userId: unknown = res.locals.userId;
    if (typeof userId !== 'string') throw AppError.unauthorized('Sign in to ingest a repository');
    const body = ingestRequestSchema.parse(req.body ?? {});
    const viewer = await viewerOf(res);
    const { run, reused } = await ingestion.ingest({
      owner,
      name,
      userId,
      ...(body.ref && { ref: body.ref }),
      ...(body.force && { force: body.force }),
      ...(viewer && { viewer }),
    });
    res.status(reused ? 200 : 201).json(toIngestion(run, reused));
  });

  router.get('/:owner/:name/freshness', async (req, res) => {
    const { owner, name } = ownerNameParams.parse(req.params);
    res.json(await ingestion.freshness(owner, name, await viewerOf(res)));
  });

  router.get('/:owner/:name/ingestions/:sha', async (req, res) => {
    const { owner, name, sha } = runParams.parse(req.params);
    res.json(toIngestion(await findReadable(owner, name, sha, res), false));
  });

  router.get('/:owner/:name/ingestions/:sha/export', async (req, res) => {
    const { owner, name, sha } = runParams.parse(req.params);
    const { format, tokens } = exportQuerySchema.parse(req.query);
    const run = await findReadable(owner, name, sha, res);
    if (run.status === 'running' || run.status === 'failed') {
      throw AppError.conflict(`This ingestion is ${run.status}, so there is nothing to export yet`);
    }

    const data = await ingestion.loadExportData(run);
    const body =
      format === 'json'
        ? exportJson(data)
        : format === 'text'
          ? exportText(data)
          : format === 'bundle'
            ? exportBundle(data, tokens).content
            : exportMarkdown(data);

    const filename = `${owner}-${name}-${run.sha.slice(0, 12)}.${EXTENSION[format]}`;
    res
      .type(CONTENT_TYPE[format])
      .setHeader('Content-Disposition', `attachment; filename="${filename}"`)
      .setHeader('X-Commit-Sha', run.sha)
      .send(body);
  });

  return router;
}
