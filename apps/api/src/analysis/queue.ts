import { MongoBackend } from '@agendajs/mongo-backend';
import { Agenda, exponential, type Job } from 'agenda';
import type { Db } from 'mongodb';
import type { Logger } from 'pino';
import { AppError } from '../errors.js';

export const JOB_NAME = 'analysis.run';
export const MAX_ATTEMPTS = 3;

export const JOB_KINDS = ['analysis', 'graph', 'embed'] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export interface JobData {
  runId: string;
  kind: JobKind;
}

/** What the services need from a queue. Tests swap in an inline version. */
export interface RunQueue {
  enqueue(runId: string, kind?: JobKind): Promise<void>;
  /** Removes a job that has not started. Returns true when one was removed. */
  dequeue(runId: string): Promise<boolean>;
}

export type RunHandler = (runId: string, attempt: number, kind: JobKind) => Promise<void>;

export interface AnalysisQueueOptions {
  /** Either a connection string or an open database. */
  mongoUri?: string;
  db?: Db;
  processEveryMs?: number;
  /** Base delay before a retry; doubles each time. */
  retryDelayMs?: number;
  logger?: Logger;
}

/**
 * Mongo-backed job queue. One job runs at a time in this process, each is retried up to
 * MAX_ATTEMPTS with exponential backoff, and nothing touches the database until start().
 */
export class AnalysisQueue implements RunQueue {
  private agenda: Agenda | undefined;

  constructor(
    private readonly options: AnalysisQueueOptions,
    private readonly handler: RunHandler,
  ) {}

  async start(): Promise<void> {
    if (this.agenda) return;
    const backend = this.options.db
      ? new MongoBackend({ mongo: this.options.db, collection: 'analysisJobs' })
      : new MongoBackend({ address: this.options.mongoUri ?? '', collection: 'analysisJobs' });
    const agenda = new Agenda({
      backend,
      name: 'repointelligence-api',
      processEvery: this.options.processEveryMs ?? 5000,
      maxConcurrency: 1,
      defaultConcurrency: 1,
      defaultLockLifetime: 20 * 60_000,
      removeOnComplete: true,
    });
    agenda.define<JobData>(
      JOB_NAME,
      async (job: Job<JobData>) => {
        const attempt = (job.attrs.failCount ?? 0) + 1;
        await this.handler(job.attrs.data.runId, attempt, job.attrs.data.kind);
      },
      {
        concurrency: 1,
        lockLimit: 1,
        backoff: exponential({
          delay: this.options.retryDelayMs ?? 5000,
          maxRetries: MAX_ATTEMPTS - 1,
        }),
      },
    );
    agenda.on('error', (err) => {
      this.options.logger?.error({ err }, 'analysis queue error');
    });
    await agenda.start();
    this.agenda = agenda;
  }

  async stop(): Promise<void> {
    if (!this.agenda) return;
    await this.agenda.stop(true);
    this.agenda = undefined;
  }

  async enqueue(runId: string, kind: JobKind = 'analysis'): Promise<void> {
    if (!this.agenda) {
      throw new AppError(503, 'QUEUE_UNAVAILABLE', 'The analysis queue is not running');
    }
    await this.agenda.now<JobData>(JOB_NAME, { runId, kind });
  }

  async dequeue(runId: string): Promise<boolean> {
    if (!this.agenda) return false;
    // The services only ask for jobs that have not started, so nothing running is removed.
    const removed = await this.agenda.cancel({ name: JOB_NAME, data: { runId } });
    return removed > 0;
  }
}

/** Runs each job on the next tick, for tests and for environments without a queue. */
export class InlineQueue implements RunQueue {
  private running: Promise<void> = Promise.resolve();

  constructor(private readonly handler: RunHandler) {}

  enqueue(runId: string, kind: JobKind = 'analysis'): Promise<void> {
    this.running = this.running.then(() => this.handler(runId, 1, kind)).catch(() => undefined);
    return Promise.resolve();
  }

  dequeue(): Promise<boolean> {
    return Promise.resolve(false);
  }

  /** Waits for every queued job to finish. */
  drain(): Promise<void> {
    return this.running;
  }
}
