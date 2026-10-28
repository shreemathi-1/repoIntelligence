import type { Logger } from 'pino';

const DAY_MS = 86_400_000;

/** Milliseconds from `now` until the next occurrence of `hourUtc`:00 UTC (never zero). */
export function msUntilNextRun(now: number, hourUtc: number): number {
  const date = new Date(now);
  const next = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hourUtc);
  return next > now ? next - now : next + DAY_MS - now;
}

/** Runs `task` every day at the given UTC hour. Returns a function that stops the schedule. */
export function startDailyJob(
  task: () => Promise<unknown>,
  logger: Logger,
  hourUtc = 3,
  now: () => number = Date.now,
): () => void {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let running = false;

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(
      () => {
        if (!running) {
          running = true;
          task()
            .catch((err: unknown) => {
              logger.error({ err }, 'scheduled job failed');
            })
            .finally(() => {
              running = false;
            });
        }
        schedule();
      },
      msUntilNextRun(now(), hourUtc),
    );
    // A pending schedule must not keep the process alive on shutdown.
    timer.unref();
  };

  schedule();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
