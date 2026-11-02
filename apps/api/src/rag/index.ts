import type { Logger } from 'pino';
import { MAX_ATTEMPTS, type RunQueue } from '../analysis/queue.js';
import type { WorkerClient } from '../analysis/worker-client.js';
import { AppError } from '../errors.js';
import { ChunkEmbedding } from '../models/chunk-embedding.js';
import { IngestionRun } from '../models/ingestion-run.js';
import { MAX_INDEXED_CHUNKS, loadChunks, type HybridRetriever } from './retrieve.js';

const BATCH = 64;

export interface IndexerOptions {
  queue: RunQueue;
  worker?: WorkerClient;
  retriever?: HybridRetriever;
  now?: () => number;
  logger?: Logger;
}

type RunDoc = InstanceType<typeof IngestionRun>;

/**
 * Embeds the chunks of an ingestion run with the worker's local model and stores the vectors.
 * Runs as a queued job; the run document carries the progress.
 */
export class EmbeddingIndexer {
  private readonly now: () => number;

  constructor(private readonly options: IndexerOptions) {
    this.now = options.now ?? Date.now;
  }

  get available(): boolean {
    return this.options.worker !== undefined;
  }

  /** Queues the embedding of a run. Returns the run with its status updated. */
  async request(run: RunDoc, force = false): Promise<RunDoc> {
    if (!this.options.worker) {
      throw new AppError(
        503,
        'WORKER_UNAVAILABLE',
        'Embedding needs the analysis worker, which is not configured',
      );
    }
    const status = run.embedding.status;
    if (status === 'queued' || status === 'running') return run;
    if (status === 'ready' && !force) return run;
    run.embedding.status = 'queued';
    run.embedding.error = undefined;
    run.embedding.updatedAt = new Date(this.now());
    await run.save();
    await this.options.queue.enqueue(run.id, 'embed');
    return run;
  }

  /** The queue calls this. Errors are rethrown so the queue retries; the status says why. */
  async process(runId: string, attempt: number): Promise<void> {
    const run = await IngestionRun.findById(runId);
    if (!run || run.embedding.status === 'ready') return;
    const log = this.options.logger?.child({ runId, fullName: run.fullName, attempt });
    run.embedding.status = 'running';
    run.embedding.updatedAt = new Date(this.now());
    await run.save();
    try {
      if (!this.options.worker) {
        throw new AppError(503, 'WORKER_UNAVAILABLE', 'The analysis worker is not configured');
      }
      const chunks = (await loadChunks(run.fullName, run.sha)).slice(0, MAX_INDEXED_CHUNKS);
      const done = new Set(
        (
          await ChunkEmbedding.find({ fullName: run.fullName, sha: run.sha })
            .select('chunkId model')
            .lean()
        ).map((r) => `${r.model}:${r.chunkId}`),
      );
      let model: string | undefined;
      let embedded = 0;
      for (let i = 0; i < chunks.length; i += BATCH) {
        const batch = chunks
          .slice(i, i + BATCH)
          .filter((c) => !model || !done.has(`${model}:${c.id}`));
        if (batch.length === 0) continue;
        const result = await this.options.worker.embed(
          batch.map((c) => `${c.provenance.path}\n${c.heading?.join(' > ') ?? ''}\n${c.text}`),
        );
        model = result.model;
        await ChunkEmbedding.bulkWrite(
          batch.map((c, j) => ({
            updateOne: {
              filter: { fullName: run.fullName, sha: run.sha, chunkId: c.id },
              update: {
                $set: { path: c.provenance.path, model: result.model, vector: result.vectors[j] },
              },
              upsert: true,
            },
          })),
        );
        embedded += batch.length;
        run.embedding.embedded = await ChunkEmbedding.countDocuments({
          fullName: run.fullName,
          sha: run.sha,
        });
        run.embedding.updatedAt = new Date(this.now());
        await run.save();
      }
      run.embedding.status = 'ready';
      run.embedding.model = model ?? run.embedding.model;
      run.embedding.updatedAt = new Date(this.now());
      await run.save();
      this.options.retriever?.invalidate();
      log?.info({ embedded, total: chunks.length }, 'embedding finished');
    } catch (err) {
      const message = err instanceof AppError ? `${err.code}: ${err.message}` : 'Embedding failed';
      const permanent =
        (err instanceof AppError && err.statusCode < 500 && err.code !== 'RATE_LIMITED') ||
        attempt >= MAX_ATTEMPTS;
      run.embedding.status = permanent ? 'failed' : 'queued';
      run.embedding.error = message;
      run.embedding.updatedAt = new Date(this.now());
      await run.save();
      log?.warn({ err, permanent }, 'embedding attempt failed');
      if (!permanent) throw err;
    }
  }
}
