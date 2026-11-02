import mongoose from 'mongoose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useMemoryDb } from '../../test/db.js';
import { AnalysisQueue } from './queue.js';

useMemoryDb();

const queues: AnalysisQueue[] = [];

function db() {
  const database = mongoose.connection.db;
  if (!database) throw new Error('no database');
  return database;
}

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

afterEach(async () => {
  await Promise.all(queues.splice(0).map((q) => q.stop()));
});

describe('AnalysisQueue', () => {
  it('refuses work before it is started', async () => {
    const queue = new AnalysisQueue({ db: db() }, () => Promise.resolve());
    await expect(queue.enqueue('abc')).rejects.toMatchObject({ statusCode: 503 });
  });

  it('runs an enqueued job once with attempt 1', async () => {
    const handler = vi.fn(() => Promise.resolve());
    const queue = new AnalysisQueue({ db: db(), processEveryMs: 50 }, handler);
    queues.push(queue);
    await queue.start();
    await queue.enqueue('run-1');
    await until(() => handler.mock.calls.length === 1);
    expect(handler).toHaveBeenCalledWith('run-1', 1, 'analysis');
  });

  it('retries a failing job with increasing attempt numbers', async () => {
    const attempts: number[] = [];
    const handler = vi.fn((_: string, attempt: number) => {
      attempts.push(attempt);
      return attempt < 3 ? Promise.reject(new Error('flaky')) : Promise.resolve();
    });
    const queue = new AnalysisQueue({ db: db(), processEveryMs: 50, retryDelayMs: 20 }, handler);
    queues.push(queue);
    await queue.start();
    await queue.enqueue('run-2');
    await until(() => attempts.length === 3, 10_000);
    expect(attempts).toEqual([1, 2, 3]);
  });

  it('removes a job that has not been picked up yet', async () => {
    const handler = vi.fn(() => Promise.resolve());
    // A long poll interval keeps the job waiting so it can be removed.
    const queue = new AnalysisQueue({ db: db(), processEveryMs: 60_000 }, handler);
    queues.push(queue);
    await queue.start();
    await queue.enqueue('run-3');
    expect(await queue.dequeue('run-3')).toBe(true);
    expect(await queue.dequeue('run-3')).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });
});
