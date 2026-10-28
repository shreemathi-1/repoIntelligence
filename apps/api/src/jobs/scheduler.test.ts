import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../logger.js';
import { msUntilNextRun, startDailyJob } from './scheduler.js';

const HOUR = 3_600_000;

describe('msUntilNextRun', () => {
  it('waits until later today when the hour has not passed', () => {
    expect(msUntilNextRun(Date.parse('2026-03-31T01:00:00Z'), 3)).toBe(2 * HOUR);
  });

  it('waits until tomorrow when the hour has passed or is now', () => {
    expect(msUntilNextRun(Date.parse('2026-03-31T05:00:00Z'), 3)).toBe(22 * HOUR);
    expect(msUntilNextRun(Date.parse('2026-03-31T03:00:00Z'), 3)).toBe(24 * HOUR);
  });
});

describe('startDailyJob', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs at the scheduled time, repeats daily and stops on request', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-03-31T02:00:00Z') });
    const task = vi.fn(() => Promise.resolve());
    const stop = startDailyJob(task, createLogger({ LOG_LEVEL: 'silent', NODE_ENV: 'test' }), 3);

    await vi.advanceTimersByTimeAsync(HOUR);
    expect(task).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(24 * HOUR);
    expect(task).toHaveBeenCalledTimes(2);

    stop();
    await vi.advanceTimersByTimeAsync(48 * HOUR);
    expect(task).toHaveBeenCalledTimes(2);
  });

  it('survives a failing run', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-03-31T02:00:00Z') });
    const task = vi.fn(() => Promise.reject(new Error('boom')));
    const stop = startDailyJob(task, createLogger({ LOG_LEVEL: 'silent', NODE_ENV: 'test' }), 3);
    await vi.advanceTimersByTimeAsync(HOUR + 24 * HOUR);
    expect(task).toHaveBeenCalledTimes(2);
    stop();
  });
});
