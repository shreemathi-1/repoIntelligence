import mongoose from 'mongoose';
import { beforeEach, describe, expect, it } from 'vitest';
import { analysisRunSchema } from '@repointelligence/shared';
import { useMemoryDb } from '../../test/db.js';
import { healthyScan, NOW } from '../../test/fixtures/analysis.js';
import {
  NODE_SERVICE,
  makeRepo,
  withSignals,
  type FixtureRepo,
  type SignalOverrides,
} from '../../test/fixtures/repos.js';
import { WORKER_SECRET, WORKER_URL, fakeWorker } from '../../test/fixtures/worker.js';
import { jsonResponse } from '../../test/github-fixtures.js';
import { AppError } from '../errors.js';
import { GithubService } from '../github/service.js';
import { AnalysisRun } from '../models/analysis-run.js';
import { ScanCache } from '../models/scan-cache.js';
import type { RunQueue } from './queue.js';
import { AnalysisService, QUOTA, inputsOf, scoreOf, toAnalysisRun } from './service.js';
import { WorkerClient } from './worker-client.js';

useMemoryDb();

const USER = new mongoose.Types.ObjectId().toHexString();
const OTHER = new mongoose.Types.ObjectId().toHexString();
let clock = NOW;

/** The AppError a promise rejects with. Anything else fails the test. */
async function failure(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof AppError) return err;
    throw err;
  }
  throw new Error('expected the promise to reject');
}

/** Records what was enqueued; tests run jobs themselves so every step is observable. */
class ManualQueue implements RunQueue {
  enqueued: string[] = [];
  enqueue(runId: string): Promise<void> {
    this.enqueued.push(runId);
    return Promise.resolve();
  }
  dequeue(runId: string): Promise<boolean> {
    const before = this.enqueued.length;
    this.enqueued = this.enqueued.filter((id) => id !== runId);
    return Promise.resolve(this.enqueued.length < before);
  }
}

interface Setup {
  repo?: FixtureRepo;
  signals?: SignalOverrides;
  scan?: () => ReturnType<typeof healthyScan> | Response;
  worker?: boolean;
}

function setup(options: Setup = {}) {
  const repo = options.repo ?? makeRepo('acme/users-api', NODE_SERVICE);
  const api = withSignals(repo, options.signals);
  const fake = fakeWorker(api, options.scan ?? healthyScan);
  const github = new GithubService({
    fetch: fake.fetch,
    now: () => clock,
    sleep: () => Promise.resolve(),
  });
  const queue = new ManualQueue();
  const service = new AnalysisService({
    github,
    queue,
    worker:
      options.worker === false
        ? undefined
        : new WorkerClient({ url: WORKER_URL, secret: WORKER_SECRET, fetch: fake.fetch }),
    fetch: fake.fetch,
    now: () => clock,
  });
  const [owner = '', name = ''] = repo.fullName.split('/');
  const start = (extra: { userId?: string; force?: boolean; ref?: string } = {}) =>
    service.start({
      owner,
      name,
      userId: extra.userId ?? USER,
      ...(extra.force && { force: true }),
      ...(extra.ref && { ref: extra.ref }),
    });
  const runNext = async (attempt = 1) => {
    const id = queue.enqueued.shift();
    if (!id) throw new Error('nothing queued');
    await service.process(id, attempt);
    return AnalysisRun.findById(id).orFail();
  };
  return { repo, service, queue, start, runNext, fake };
}

beforeEach(async () => {
  await Promise.all([
    AnalysisRun.deleteMany({}),
    ScanCache.deleteMany({}),
    mongoose.connection.collection('githubcaches').deleteMany({}),
  ]);
  clock = NOW;
});

describe('starting an analysis', () => {
  it('queues a run pinned to the commit, then reuses it while it is active and after it succeeds', async () => {
    const { start, runNext, queue, repo } = setup();
    const first = await start();
    expect(first.reused).toBe(false);
    expect(first.run).toMatchObject({
      status: 'queued',
      sha: repo.commits[0],
      fullName: 'acme/users-api',
    });
    expect(queue.enqueued).toEqual([first.run.id]);

    const again = await start();
    expect(again.reused).toBe(true);
    expect(again.run.id).toBe(first.run.id);

    await runNext();
    const done = await start();
    expect(done.reused).toBe(true);
    expect(done.run.status).toBe('succeeded');
    expect(await AnalysisRun.countDocuments()).toBe(1);
  });

  it('force starts a fresh run for an already analysed commit', async () => {
    const { start, runNext } = setup();
    await start();
    await runNext();
    const forced = await start({ force: true });
    expect(forced.reused).toBe(false);
    expect(await AnalysisRun.countDocuments()).toBe(2);
  });

  it('refuses private repositories', async () => {
    const { start } = setup({ repo: makeRepo('acme/users-api', NODE_SERVICE, { private: true }) });
    await expect(start()).rejects.toMatchObject({ statusCode: 400 });
  });

  it('enforces one running analysis and a daily limit per user', async () => {
    const { start, service, runNext } = setup();
    await start();
    const other = makeRepo('acme/other', NODE_SERVICE);
    const second = setup({ repo: other });
    const running = await failure(second.start());
    expect(running.code).toBe('QUOTA_EXCEEDED');
    expect(running.message).toContain('already have');
    await runNext();

    for (let i = 1; i < QUOTA.dailyLimit; i++) {
      await start({ force: true });
      await runNext();
    }
    expect((await service.quota(USER)).usedToday).toBe(QUOTA.dailyLimit);
    const daily = await failure(start({ force: true }));
    expect(daily.code).toBe('QUOTA_EXCEEDED');
    expect(daily.message).toContain("today's");
    // Another user is not affected, and a new day resets the count.
    await expect(start({ userId: OTHER, force: true })).resolves.toMatchObject({ reused: false });
    clock += 86_400_000;
    expect((await service.quota(USER)).usedToday).toBe(0);
  });
});

describe('processing a run', () => {
  it('fetches, scans, collects signals and scores, reporting progress along the way', async () => {
    const { start, runNext, fake } = setup();
    await start();
    const run = await runNext();
    expect(run.status).toBe('succeeded');
    expect(run.progress).toMatchObject({ step: 'done', percent: 100 });
    expect(run.progress.message).toMatch(/Finished: \d+\/100/);
    expect(fake.scans()).toBe(1);

    const score = scoreOf(run);
    expect(score?.status).toBe('scored');
    expect(score?.overall).toBeGreaterThan(70);
    expect(
      score?.areas
        .find((a) => a.id === 'community')
        ?.metrics.find((m) => m.id === 'issues.response'),
    ).toMatchObject({ status: 'measured', value: 6 });
    expect(score?.areas.find((a) => a.id === 'busFactor')?.metrics[0]).toMatchObject({ value: 60 });
    const view = analysisRunSchema.parse(toAnalysisRun(run, false));
    expect(view.score?.weights.codeQuality).toBe(15);
    expect(inputsOf(run)?.sourceLines).toBe(5000);
    expect(run.treeDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('still scores from GitHub alone when no worker is configured, and says so', async () => {
    const { start, runNext } = setup({ worker: false });
    await start();
    const run = await runNext();
    expect(run.status).toBe('succeeded');
    const score = scoreOf(run);
    expect(score?.status).toBe('insufficient-data');
    expect(score?.overall).toBeNull();
    expect(inputsOf(run)?.scanUnavailableReason).toMatch(/worker is not configured/);
    expect(score?.areas.find((a) => a.id === 'activity')?.score).not.toBeNull();
    expect(run.progress.message).toMatch(/not enough data/);
  });

  it('reuses the scan of an identical file tree instead of calling the worker again', async () => {
    const repo = makeRepo('acme/users-api', NODE_SERVICE);
    const { start, runNext, fake } = setup({ repo });
    await start();
    await runNext();
    // A new commit with the same files (an empty commit or a merge).
    repo.commits.push('b'.repeat(40));
    clock += 120_000;
    const second = await start();
    expect(second.run.sha).toBe('b'.repeat(40));
    const run = await runNext();
    expect(run.status).toBe('succeeded');
    expect(fake.scans()).toBe(1);
    expect(await ScanCache.countDocuments()).toBe(1);
  });

  it('retries a worker outage and gives up after the last attempt', async () => {
    let calls = 0;
    const { start, queue, service } = setup({
      scan: () => {
        calls += 1;
        return jsonResponse({ detail: 'boom' }, 500);
      },
    });
    const { run } = await start();
    queue.enqueued.length = 0;

    await expect(service.process(run.id, 1)).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
    let stored = await AnalysisRun.findById(run._id).orFail();
    expect(stored).toMatchObject({ status: 'queued', attempt: 1 });
    expect(stored.progress.message).toMatch(/Attempt 1 failed/);

    await service.process(run.id, 3);
    stored = await AnalysisRun.findById(run._id).orFail();
    expect(stored.status).toBe('failed');
    expect(stored.error).toContain('UPSTREAM_ERROR');
    expect(stored.finishedAt).toBeTruthy();
    expect(calls).toBe(2);
  });

  it('scores without a scan when the archive is too large, instead of failing', async () => {
    const repo = makeRepo('acme/users-api', NODE_SERVICE);
    const api = withSignals(repo);
    const big = (url: string) =>
      url.includes('/tarball/')
        ? new Response(new Uint8Array(8), {
            status: 200,
            headers: { 'content-length': String(100 * 1024 * 1024) },
          })
        : api(url);
    const fake = fakeWorker(big, healthyScan);
    const github = new GithubService({
      fetch: fake.fetch,
      now: () => clock,
      sleep: () => Promise.resolve(),
    });
    const queue = new ManualQueue();
    const service = new AnalysisService({
      github,
      queue,
      worker: new WorkerClient({ url: WORKER_URL, secret: WORKER_SECRET, fetch: fake.fetch }),
      fetch: fake.fetch,
      now: () => clock,
    });
    const { run } = await service.start({ owner: 'acme', name: 'users-api', userId: USER });
    await service.process(run.id, 1);
    const stored = await AnalysisRun.findById(run._id).orFail();
    expect(stored.status).toBe('succeeded');
    expect(inputsOf(stored)?.scanUnavailableReason).toMatch(/50 MB/);
    expect(fake.scans()).toBe(0);
  });

  it('marks GitHub signals unavailable when their endpoints fail, without failing the run', async () => {
    const { start, runNext } = setup({ signals: { failWith: 500 } });
    await start();
    const run = await runNext();
    expect(run.status).toBe('succeeded');
    const community = scoreOf(run)?.areas.find((a) => a.id === 'community');
    expect(community?.metrics.find((m) => m.id === 'contributors')).toMatchObject({
      status: 'unavailable',
      score: null,
    });
    expect(community?.metrics.find((m) => m.id === 'code-of-conduct')?.status).toBe('inferred');
  });

  it('stops at the next step when cancellation was requested while running', async () => {
    const { start, service, queue, fake } = setup();
    const { run } = await start();
    queue.enqueued.length = 0;
    await AnalysisRun.updateOne({ _id: run._id }, { $set: { status: 'running' } });
    await service.cancel(run.id, USER);
    const flagged = await AnalysisRun.findById(run._id).orFail();
    expect(flagged.cancelRequested).toBe(true);

    await service.process(run.id, 1);
    const stored = await AnalysisRun.findById(run._id).orFail();
    expect(stored.status).toBe('cancelled');
    expect(stored.progress.message).toBe('Cancelled');
    expect(fake.scans()).toBe(0);
  });

  it('cancels a queued run outright and only for its owner', async () => {
    const { start, service, queue } = setup();
    const { run } = await start();
    await expect(service.cancel(run.id, OTHER)).rejects.toMatchObject({ statusCode: 404 });
    const cancelled = await service.cancel(run.id, USER);
    expect(cancelled.status).toBe('cancelled');
    expect(queue.enqueued).toEqual([]);
    // Processing a cancelled run does nothing.
    await service.process(run.id, 1);
    expect((await AnalysisRun.findById(run._id).orFail()).status).toBe('cancelled');
  });
});

describe('history and simulation', () => {
  it('lists finished runs newest first and simulates against the latest', async () => {
    const repo = makeRepo('acme/users-api', NODE_SERVICE);
    const { start, runNext, service } = setup({ repo });
    await start();
    await runNext();
    clock += 3_600_000;
    repo.commits.push('c'.repeat(40));
    await start();
    await runNext();

    const history = await service.history('acme/users-api');
    expect(history.map((h) => h.sha)).toEqual(['c'.repeat(40), repo.commits[0]]);
    expect(history[0]?.areas.codeQuality).toBeTypeOf('number');

    const sim = await service.simulate('acme/users-api', {
      resolveRules: [],
      resolveSeverities: [],
      addFiles: ['CONTRIBUTING'],
    });
    expect(sim.estimate).toBe(true);
    const latest = await service.latest('acme/users-api');
    expect(latest).not.toBeNull();
    expect(sim.before.overall).toBe(latest ? scoreOf(latest)?.overall : undefined);
    await expect(
      service.simulate('acme/never', { resolveRules: [], resolveSeverities: [], addFiles: [] }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
