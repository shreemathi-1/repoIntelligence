import { createHash } from 'node:crypto';
import type { Types } from 'mongoose';
import type { Logger } from 'pino';
import { z } from 'zod';
import {
  healthScoreSchema,
  type AnalysisRun as AnalysisRunView,
  type HealthHistoryItem,
  type HealthScore,
  type SimulateRequest,
  type SimulateResponse,
} from '@repointelligence/shared';
import { AppError } from '../errors.js';
import type { GithubService, Viewer } from '../github/service.js';
import { AnalysisRun } from '../models/analysis-run.js';
import { ArchitectureGraphModel } from '../models/architecture-graph.js';
import { ScanCache } from '../models/scan-cache.js';
import { fetchArchive } from './fetch-archive.js';
import { collectSignals } from './github-signals.js';
import { architectureSignalsOf } from './architecture-signals.js';
import { analysisInputsSchema, type AnalysisInputs, type ArchitectureSignals } from './inputs.js';
import { MAX_ATTEMPTS, type RunQueue } from './queue.js';
import { computeHealth } from './scoring.js';
import { simulate } from './simulator.js';
import type { WorkerClient } from './worker-client.js';

export const QUOTA = { dailyLimit: 5, maxRunning: 1 } as const;

const commitSchema = z.object({
  sha: z.string(),
  commit: z.object({ tree: z.object({ sha: z.string() }) }),
});
const treeSchema = z.object({
  truncated: z.boolean(),
  tree: z.array(z.object({ path: z.string(), sha: z.string(), type: z.string() })),
});

export interface AnalysisServiceOptions {
  github: GithubService;
  queue: RunQueue;
  worker?: WorkerClient;
  /** For the archive download; defaults to the global fetch and the server token. */
  fetch?: typeof fetch;
  serverToken?: string;
  now?: () => number;
  logger?: Logger;
}

export interface StartInput {
  owner: string;
  name: string;
  ref?: string;
  force?: boolean;
  userId: string;
  viewer?: Viewer;
}

type RunDoc = InstanceType<typeof AnalysisRun>;

class CancelledError extends Error {
  constructor() {
    super('cancelled');
    this.name = 'CancelledError';
  }
}

export class AnalysisService {
  private readonly now: () => number;

  constructor(private readonly options: AnalysisServiceOptions) {
    this.now = options.now ?? Date.now;
  }

  // ---- starting and reading runs ------------------------------------------------------------------

  async start(input: StartInput): Promise<{ run: RunDoc; reused: boolean }> {
    const { owner, name, viewer } = input;
    const { repo } = await this.options.github.getRepo(owner, name, viewer);
    if (repo.private) throw AppError.badRequest('Private repositories cannot be analysed yet');
    const fullName = repo.fullName.toLowerCase();
    const sha = await this.resolveSha(owner, name, input.ref ?? repo.defaultBranch, viewer);

    const active = await AnalysisRun.findOne({
      fullName,
      sha,
      status: { $in: ['queued', 'running'] },
    });
    if (active) return { run: active, reused: true };
    if (!input.force) {
      const done = await AnalysisRun.findOne({ fullName, sha, status: 'succeeded' }).sort({
        finishedAt: -1,
      });
      if (done) return { run: done, reused: true };
    }

    await this.enforceQuota(input.userId);
    const run = await AnalysisRun.create({
      fullName,
      sha,
      ref: input.ref ?? repo.defaultBranch,
      requestedBy: input.userId,
      status: 'queued',
      queuedAt: new Date(this.now()),
    });
    try {
      await this.options.queue.enqueue(run.id);
    } catch (err) {
      await AnalysisRun.deleteOne({ _id: run._id });
      throw err;
    }
    return { run, reused: false };
  }

  async quota(
    userId: string,
  ): Promise<{ dailyLimit: number; usedToday: number; running: number; maxRunning: number }> {
    const dayStart = new Date(this.now());
    dayStart.setUTCHours(0, 0, 0, 0);
    const [usedToday, running] = await Promise.all([
      AnalysisRun.countDocuments({ requestedBy: userId, queuedAt: { $gte: dayStart } }),
      AnalysisRun.countDocuments({ requestedBy: userId, status: { $in: ['queued', 'running'] } }),
    ]);
    return { ...QUOTA, usedToday, running };
  }

  private async enforceQuota(userId: string): Promise<void> {
    const q = await this.quota(userId);
    if (q.running >= q.maxRunning) {
      throw AppError.quotaExceeded(
        'You already have an analysis running; wait for it to finish',
        q,
      );
    }
    if (q.usedToday >= q.dailyLimit) {
      throw AppError.quotaExceeded(`You have used today's ${q.dailyLimit} analyses`, q);
    }
  }

  async get(runId: string): Promise<RunDoc> {
    const run = /^[0-9a-f]{24}$/i.test(runId) ? await AnalysisRun.findById(runId) : null;
    if (!run) throw AppError.notFound('Analysis not found');
    return run;
  }

  async cancel(runId: string, userId: string): Promise<RunDoc> {
    const run = await this.get(runId);
    if (!run.requestedBy.equals(userId)) throw AppError.notFound('Analysis not found');
    if (run.status === 'queued') {
      await this.options.queue.dequeue(run.id);
      run.status = 'cancelled';
      run.finishedAt = new Date(this.now());
      run.progress = { step: 'done', percent: 100, message: 'Cancelled before it started' };
      await run.save();
    } else if (run.status === 'running') {
      // The worker checks this flag between steps and stops at the next one.
      run.cancelRequested = true;
      run.progress = { ...run.progress, message: 'Cancelling after the current step' };
      await run.save();
    }
    return run;
  }

  async latest(fullName: string): Promise<RunDoc | null> {
    return AnalysisRun.findOne({ fullName: fullName.toLowerCase(), status: 'succeeded' }).sort({
      finishedAt: -1,
    });
  }

  async history(fullName: string, limit = 30): Promise<HealthHistoryItem[]> {
    const runs = await AnalysisRun.find({ fullName: fullName.toLowerCase(), status: 'succeeded' })
      .sort({ finishedAt: -1 })
      .limit(limit);
    return runs.flatMap((run) => {
      const score = scoreOf(run);
      if (!score || !run.sha || !run.finishedAt) return [];
      return [
        {
          runId: run.id,
          sha: run.sha,
          finishedAt: run.finishedAt.toISOString(),
          overall: score.overall,
          confidence: score.confidence,
          areas: Object.fromEntries(
            score.areas.map((a) => [a.id, a.score]),
          ) as HealthHistoryItem['areas'],
        },
      ];
    });
  }

  async simulate(fullName: string, request: SimulateRequest): Promise<SimulateResponse> {
    const run = await this.latest(fullName);
    const inputs = run ? inputsOf(run) : null;
    if (!run || !inputs) throw AppError.notFound('Analyse the repository first');
    return simulate(inputs, request, this.now());
  }

  // ---- the job -----------------------------------------------------------------------------------

  /** The queue calls this. Errors are rethrown so the queue can retry; cancellation is not an error. */
  async process(runId: string, attempt: number): Promise<void> {
    const run = await AnalysisRun.findById(runId);
    if (!run || run.status === 'cancelled' || run.status === 'succeeded') return;
    const [owner = '', name = ''] = run.fullName.split('/');
    const sha = run.sha ?? '';
    const log = this.options.logger?.child({ runId, fullName: run.fullName, attempt });

    run.status = 'running';
    run.attempt = attempt;
    run.startedAt = run.startedAt ?? new Date(this.now());
    await this.progress(run, 'fetching', 5, 'Reading the file tree');

    try {
      const digest = await this.treeDigest(owner, name, sha);
      run.treeDigest = digest ?? undefined;
      await this.checkCancelled(run);

      const inputs = await this.gatherInputs(run, owner, name, sha, digest);
      await this.checkCancelled(run);

      await this.progress(run, 'scoring', 90, 'Computing the score');
      const score = computeHealth(inputs, this.now());
      run.inputs = inputs;
      run.score = score;
      run.status = 'succeeded';
      run.finishedAt = new Date(this.now());
      await this.progress(
        run,
        'done',
        100,
        score.overall === null
          ? 'Finished: not enough data for an overall score'
          : `Finished: ${score.overall}/100`,
      );
      log?.info({ overall: score.overall, confidence: score.confidence }, 'analysis finished');
    } catch (err) {
      if (err instanceof CancelledError) {
        run.status = 'cancelled';
        run.finishedAt = new Date(this.now());
        await this.progress(run, 'done', 100, 'Cancelled');
        return;
      }
      const message = err instanceof AppError ? `${err.code}: ${err.message}` : 'Analysis failed';
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
      log?.warn({ err, permanent }, 'analysis attempt failed');
      if (!permanent) throw err;
    }
  }

  private async gatherInputs(
    run: RunDoc,
    owner: string,
    name: string,
    sha: string,
    digest: string | null,
  ): Promise<AnalysisInputs> {
    let scan: AnalysisInputs['scan'] = null;
    let scanUnavailableReason: string | null = null;

    const cached = digest ? await ScanCache.findOne({ treeDigest: digest }).lean() : null;
    if (cached) {
      scan = cached.scan as AnalysisInputs['scan'];
      await this.progress(run, 'scanning', 60, 'Reusing the scan of an identical file tree');
    } else if (!this.options.worker) {
      scanUnavailableReason = 'The analysis worker is not configured, so no scanners ran';
    } else {
      await this.progress(run, 'fetching', 15, 'Downloading the repository archive');
      try {
        const archive = await fetchArchive(owner, name, sha, {
          fetch: this.options.fetch,
          token: this.options.serverToken,
        });
        await this.checkCancelled(run);
        await this.progress(
          run,
          'scanning',
          30,
          `Scanning ${Math.round(archive.byteLength / 1024)} KB with the worker`,
        );
        scan = await this.options.worker.scan(archive);
        if (digest) {
          await ScanCache.updateOne(
            { treeDigest: digest },
            {
              $setOnInsert: { fullName: run.fullName, sha, scan, createdAt: new Date(this.now()) },
            },
            { upsert: true },
          );
        }
      } catch (err) {
        // A repository too large to scan is still worth scoring from GitHub signals alone.
        if (err instanceof AppError && err.statusCode === 400) scanUnavailableReason = err.message;
        else throw err;
      }
    }

    await this.progress(
      run,
      'collecting',
      70,
      'Collecting activity and community signals from GitHub',
    );
    const signals = await collectSignals(
      this.options.github,
      owner,
      name,
      sha,
      undefined,
      this.now(),
    );
    const inventory = scan?.results.find((r) => r.tool === 'inventory');
    const lines = inventory?.status === 'ok' ? linesOf(inventory.data) : null;
    const architecture = await this.architectureFor(run.fullName, sha, digest);
    return analysisInputsSchema.parse({
      scan,
      scanUnavailableReason,
      signals,
      sourceLines: lines,
      architecture,
    });
  }

  /** Architecture facts from a stored graph of the same commit or the same file tree. */
  private async architectureFor(
    fullName: string,
    sha: string,
    digest: string | null,
  ): Promise<ArchitectureSignals | null> {
    const doc =
      (await ArchitectureGraphModel.findOne({ fullName, sha }).lean()) ??
      (digest ? await ArchitectureGraphModel.findOne({ treeDigest: digest }).lean() : null);
    return doc ? architectureSignalsOf(doc.graph) : null;
  }

  private async resolveSha(
    owner: string,
    name: string,
    ref: string,
    viewer?: Viewer,
  ): Promise<string> {
    const { data } = await this.options.github.getJson(
      {
        route: 'GET /repos/{owner}/{repo}/commits/{ref}',
        params: { owner, repo: name, ref },
        schema: commitSchema,
        freshMs: /^[0-9a-f]{40}$/i.test(ref) ? 24 * 3_600_000 : 60_000,
      },
      viewer,
    );
    return data.sha;
  }

  /** A fingerprint of every file in the commit, or null when GitHub cut the listing short. */
  private async treeDigest(owner: string, name: string, sha: string): Promise<string | null> {
    const { data: commit } = await this.options.github.getJson({
      route: 'GET /repos/{owner}/{repo}/commits/{ref}',
      params: { owner, repo: name, ref: sha },
      schema: commitSchema,
      freshMs: 24 * 3_600_000,
    });
    const { data: tree } = await this.options.github.getJson({
      route: 'GET /repos/{owner}/{repo}/git/trees/{tree_sha}',
      params: { owner, repo: name, tree_sha: commit.commit.tree.sha, recursive: '1' },
      schema: treeSchema,
      freshMs: 24 * 3_600_000,
    });
    if (tree.truncated) return null;
    const hash = createHash('sha256');
    for (const entry of tree.tree
      .filter((e) => e.type === 'blob')
      .sort((a, b) => a.path.localeCompare(b.path))) {
      hash.update(`${entry.path}\0${entry.sha}\n`);
    }
    return hash.digest('hex');
  }

  private async progress(
    run: RunDoc,
    step: RunDoc['progress']['step'],
    percent: number,
    message: string,
  ): Promise<void> {
    run.progress = { step, percent, message };
    await run.save();
  }

  private async checkCancelled(run: RunDoc): Promise<void> {
    const fresh = await AnalysisRun.findById(run._id).select('cancelRequested').lean();
    if (fresh?.cancelRequested) throw new CancelledError();
  }
}

function linesOf(data: unknown): number | null {
  const parsed = z.object({ linesByLanguage: z.record(z.string(), z.number()) }).safeParse(data);
  return parsed.success
    ? Object.values(parsed.data.linesByLanguage).reduce((a, b) => a + b, 0)
    : null;
}

export function scoreOf(run: RunDoc): HealthScore | null {
  const parsed = healthScoreSchema.safeParse(run.score);
  return parsed.success ? parsed.data : null;
}

export function inputsOf(run: RunDoc): AnalysisInputs | null {
  const parsed = analysisInputsSchema.safeParse(run.inputs);
  return parsed.success ? parsed.data : null;
}

export function toAnalysisRun(run: RunDoc, reused: boolean): AnalysisRunView {
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
    attempt: run.attempt,
    error: run.error ?? null,
    reused,
    queuedAt: run.queuedAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
    score: scoreOf(run),
  };
}

export type { Types };
