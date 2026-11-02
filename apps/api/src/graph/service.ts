import type { Logger } from 'pino';
import { z } from 'zod';
import {
  architectureGraphSchema,
  type ArchitectureGraph,
  type GraphRun as GraphRunView,
  type GraphSummary,
  type Layer,
  type SourceFile,
} from '@repointelligence/shared';
import { fetchArchive } from '../analysis/fetch-archive.js';
import { MAX_ATTEMPTS, type RunQueue } from '../analysis/queue.js';
import { QUOTA } from '../analysis/service.js';
import type { WorkerClient } from '../analysis/worker-client.js';
import { AppError } from '../errors.js';
import type { GithubService, Viewer } from '../github/service.js';
import { ArchitectureGraphModel } from '../models/architecture-graph.js';
import { GraphRun } from '../models/graph-run.js';
import { treeDigestOf, resolveCommitSha } from './tree.js';
import { buildFolders } from './views.js';

const MAX_SOURCE_BYTES = 512 * 1024;
const LANGUAGE_BY_EXT: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript', js: 'javascript', jsx: 'javascript',
  mjs: 'javascript', cjs: 'javascript', py: 'python', java: 'java', json: 'json', md: 'markdown', yml: 'yaml',
  yaml: 'yaml', toml: 'toml', xml: 'xml', sql: 'sql', html: 'html', css: 'css', sh: 'shell', go: 'go', rs: 'rust',
}; // prettier-ignore

const contentsSchema = z.object({
  type: z.literal('file'),
  size: z.number().int().nonnegative(),
  encoding: z.string(),
  content: z.string(),
});

export interface GraphServiceOptions {
  github: GithubService;
  queue: RunQueue;
  worker?: WorkerClient;
  fetch?: typeof fetch;
  serverToken?: string;
  now?: () => number;
  logger?: Logger;
}

export interface StartGraphInput {
  owner: string;
  name: string;
  ref?: string;
  force?: boolean;
  userId: string;
  viewer?: Viewer;
}

type RunDoc = InstanceType<typeof GraphRun>;
type GraphDoc = InstanceType<typeof ArchitectureGraphModel>;

class CancelledError extends Error {}

export class GraphService {
  private readonly now: () => number;

  constructor(private readonly options: GraphServiceOptions) {
    this.now = options.now ?? Date.now;
  }

  async start(input: StartGraphInput): Promise<{ run: RunDoc; reused: boolean }> {
    const { owner, name, viewer } = input;
    const { repo } = await this.options.github.getRepo(owner, name, viewer);
    if (repo.private) throw AppError.badRequest('Private repositories cannot be mapped yet');
    const fullName = repo.fullName.toLowerCase();
    const sha = await resolveCommitSha(
      this.options.github,
      owner,
      name,
      input.ref ?? repo.defaultBranch,
      viewer,
    );

    const active = await GraphRun.findOne({
      fullName,
      sha,
      status: { $in: ['queued', 'running'] },
    });
    if (active) return { run: active, reused: true };
    if (!input.force) {
      const done = await GraphRun.findOne({ fullName, sha, status: 'succeeded' }).sort({
        finishedAt: -1,
      });
      if (done && (await ArchitectureGraphModel.exists({ fullName, sha })))
        return { run: done, reused: true };
    }
    if (!this.options.worker) {
      throw new AppError(
        503,
        'WORKER_UNAVAILABLE',
        'Architecture mapping needs the analysis worker, which is not configured',
      );
    }

    const running = await GraphRun.countDocuments({
      requestedBy: input.userId,
      status: { $in: ['queued', 'running'] },
    });
    if (running >= QUOTA.maxRunning) {
      throw AppError.quotaExceeded('You already have a graph build running; wait for it to finish');
    }
    const dayStart = new Date(this.now());
    dayStart.setUTCHours(0, 0, 0, 0);
    const today = await GraphRun.countDocuments({
      requestedBy: input.userId,
      queuedAt: { $gte: dayStart },
    });
    if (today >= QUOTA.dailyLimit) {
      throw AppError.quotaExceeded(`You have used today's ${QUOTA.dailyLimit} graph builds`);
    }

    const run = await GraphRun.create({
      fullName,
      sha,
      ref: input.ref ?? repo.defaultBranch,
      requestedBy: input.userId,
      queuedAt: new Date(this.now()),
    });
    try {
      await this.options.queue.enqueue(run.id, 'graph');
    } catch (err) {
      await GraphRun.deleteOne({ _id: run._id });
      throw err;
    }
    return { run, reused: false };
  }

  async get(runId: string): Promise<RunDoc> {
    const run = /^[0-9a-f]{24}$/i.test(runId) ? await GraphRun.findById(runId) : null;
    if (!run) throw AppError.notFound('Graph build not found');
    return run;
  }

  async cancel(runId: string, userId: string): Promise<RunDoc> {
    const run = await this.get(runId);
    if (!run.requestedBy.equals(userId)) throw AppError.notFound('Graph build not found');
    if (run.status === 'queued') {
      await this.options.queue.dequeue(run.id);
      run.status = 'cancelled';
      run.finishedAt = new Date(this.now());
      run.progress = { step: 'done', percent: 100, message: 'Cancelled before it started' };
      await run.save();
    } else if (run.status === 'running') {
      run.cancelRequested = true;
      await run.save();
    }
    return run;
  }

  /** The queue calls this. Errors are rethrown so the queue can retry; cancellation is not an error. */
  async process(runId: string, attempt: number): Promise<void> {
    const run = await GraphRun.findById(runId);
    if (!run || run.status === 'cancelled' || run.status === 'succeeded') return;
    const [owner = '', name = ''] = run.fullName.split('/');
    const sha = run.sha ?? '';
    const log = this.options.logger?.child({ runId, fullName: run.fullName, attempt });
    run.status = 'running';
    run.attempt = attempt;
    run.startedAt = run.startedAt ?? new Date(this.now());
    await this.progress(run, 'fetching', 5, 'Reading the file tree');

    try {
      const digest = await treeDigestOf(this.options.github, owner, name, sha);
      run.treeDigest = digest ?? undefined;
      await this.checkCancelled(run);

      let graph: ArchitectureGraph | null = null;
      const cached = digest
        ? await ArchitectureGraphModel.findOne({ treeDigest: digest }).lean()
        : null;
      if (cached) {
        const parsed = architectureGraphSchema.safeParse(cached.graph);
        if (parsed.success) {
          graph = parsed.data;
          await this.progress(run, 'parsing', 60, 'Reusing the graph of an identical file tree');
        }
      }
      if (!graph) {
        if (!this.options.worker)
          throw new AppError(503, 'WORKER_UNAVAILABLE', 'The analysis worker is not configured');
        await this.progress(run, 'fetching', 15, 'Downloading the repository archive');
        const archive = await fetchArchive(owner, name, sha, {
          fetch: this.options.fetch,
          token: this.options.serverToken,
        });
        await this.checkCancelled(run);
        await this.progress(
          run,
          'parsing',
          30,
          `Parsing ${Math.round(archive.byteLength / 1024)} KB with the worker`,
        );
        graph = await this.options.worker.graph(archive);
      }
      await this.checkCancelled(run);
      await this.progress(run, 'storing', 90, 'Storing the graph');
      await ArchitectureGraphModel.updateOne(
        { fullName: run.fullName, sha },
        {
          $set: {
            graph: withImportedBy(graph),
            treeDigest: digest ?? undefined,
            computedAt: new Date(this.now()),
          },
        },
        { upsert: true },
      );
      run.status = 'succeeded';
      run.finishedAt = new Date(this.now());
      await this.progress(
        run,
        'done',
        100,
        `Finished: ${graph.files.length} files, ${graph.symbols.length} symbols`,
      );
      log?.info({ files: graph.files.length }, 'graph finished');
    } catch (err) {
      if (err instanceof CancelledError) {
        run.status = 'cancelled';
        run.finishedAt = new Date(this.now());
        await this.progress(run, 'done', 100, 'Cancelled');
        return;
      }
      const message =
        err instanceof AppError ? `${err.code}: ${err.message}` : 'Graph build failed';
      const permanent =
        (err instanceof AppError && err.statusCode < 500 && err.code !== 'RATE_LIMITED') ||
        attempt >= MAX_ATTEMPTS;
      run.error = message;
      run.status = permanent ? 'failed' : 'queued';
      run.finishedAt = permanent ? new Date(this.now()) : undefined;
      await this.progress(
        run,
        permanent ? 'done' : 'queued',
        permanent ? 100 : 0,
        permanent ? `Failed: ${message}` : `Attempt ${attempt} failed, retrying`,
      );
      log?.warn({ err, permanent }, 'graph attempt failed');
      if (!permanent) throw err;
    }
  }

  // ---- reading --------------------------------------------------------------------------------------

  async latestSha(fullName: string): Promise<string | null> {
    const doc = await ArchitectureGraphModel.findOne({ fullName: fullName.toLowerCase() })
      .sort({ computedAt: -1 })
      .select('sha')
      .lean();
    return doc?.sha ?? null;
  }

  async load(fullName: string, sha: string): Promise<{ graph: ArchitectureGraph; doc: GraphDoc }> {
    const resolved = sha === 'latest' ? await this.latestSha(fullName) : sha.toLowerCase();
    const doc = resolved
      ? await ArchitectureGraphModel.findOne({ fullName: fullName.toLowerCase(), sha: resolved })
      : null;
    if (!doc) throw AppError.notFound('No architecture graph for this repository and commit');
    const parsed = architectureGraphSchema.safeParse(doc.graph);
    if (!parsed.success) throw AppError.upstream('The stored graph could not be read');
    return { graph: parsed.data, doc };
  }

  summary(graph: ArchitectureGraph, doc: GraphDoc): GraphSummary {
    const layers = Object.fromEntries(
      (
        ['presentation', 'service', 'data', 'integration', 'config', 'test', 'other'] as Layer[]
      ).map((l) => [l, 0]),
    ) as Record<Layer, number>;
    for (const file of graph.files) layers[file.layer] += 1;
    return {
      fullName: doc.fullName,
      sha: doc.sha,
      computedAt: doc.computedAt.toISOString(),
      stats: graph.stats,
      stack: graph.stack,
      entryPoints: graph.entryPoints,
      routes: graph.routes,
      models: graph.models,
      auth: graph.auth,
      cycles: graph.cycles,
      layerViolations: graph.layerViolations,
      layers,
      folders: buildFolders(graph),
      detected: true,
    };
  }

  /** One file at the pinned commit, for the source viewer. Bounded, text only. */
  async source(
    owner: string,
    name: string,
    sha: string,
    path: string,
    viewer?: Viewer,
  ): Promise<SourceFile> {
    if (!/^[0-9a-f]{40}$/i.test(sha)) throw AppError.badRequest('A full commit SHA is required');
    if (path.split('/').some((p) => p === '..' || p === ''))
      throw AppError.badRequest('Invalid path');
    const { data } = await this.options.github.getJson(
      {
        route: 'GET /repos/{owner}/{repo}/contents/{path}',
        params: { owner, repo: name, path, ref: sha },
        schema: contentsSchema,
        // Content at a commit never changes.
        freshMs: 7 * 24 * 3_600_000,
      },
      viewer,
    );
    const bytes =
      data.encoding === 'base64'
        ? Buffer.from(data.content, 'base64')
        : Buffer.from(data.content, 'utf8');
    if (bytes.includes(0)) throw AppError.badRequest('This file is binary');
    const truncated = bytes.byteLength > MAX_SOURCE_BYTES;
    const ext = path.split('.').pop()?.toLowerCase() ?? '';
    return {
      path,
      sha,
      content: bytes.subarray(0, MAX_SOURCE_BYTES).toString('utf8'),
      language: LANGUAGE_BY_EXT[ext] ?? null,
      truncated,
      bytes: bytes.byteLength,
    };
  }

  private async progress(
    run: RunDoc,
    step: string,
    percent: number,
    message: string,
  ): Promise<void> {
    run.progress = { step, percent, message };
    await run.save();
  }

  private async checkCancelled(run: RunDoc): Promise<void> {
    const fresh = await GraphRun.findById(run._id).select('cancelRequested').lean();
    if (fresh?.cancelRequested) throw new CancelledError();
  }
}

/** Fills each file's importedBy count from the import edges. */
export function withImportedBy(graph: ArchitectureGraph): ArchitectureGraph {
  const counts = new Map<string, number>();
  for (const edge of graph.imports)
    if (edge.to) counts.set(edge.to, (counts.get(edge.to) ?? 0) + 1);
  return {
    ...graph,
    files: graph.files.map((f) => ({ ...f, importedBy: counts.get(f.path) ?? 0 })),
  };
}

export function toGraphRun(
  run: RunDoc,
  reused: boolean,
  summary: GraphSummary | null,
): GraphRunView {
  return {
    id: run.id,
    fullName: run.fullName,
    sha: run.sha ?? null,
    status: run.status,
    progress: {
      step: run.progress.step,
      percent: run.progress.percent,
      message: run.progress.message,
    },
    error: run.error ?? null,
    reused,
    summary,
  };
}
