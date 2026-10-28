import { createApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { connectDb, disconnectDb } from './db.js';
import { runTrendingJob } from './discovery/trending-job.js';
import { GithubService } from './github/service.js';
import { startDailyJob } from './jobs/scheduler.js';
import { createLogger } from './logger.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);

  await connectDb(config.MONGODB_URI);
  logger.info('connected to MongoDB');

  const github = new GithubService({ serverToken: config.GITHUB_TOKEN });
  const stopJobs = config.TRENDING_JOB_ENABLED
    ? startDailyJob(
        () => runTrendingJob({ github, logger, paceMs: config.GITHUB_TOKEN ? 2200 : 6500 }),
        logger,
      )
    : undefined;

  const server = createApp(config, logger, { github }).listen(config.PORT, () => {
    logger.info({ port: config.PORT }, 'api listening');
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    stopJobs?.();

    const force = setTimeout(() => {
      logger.error('shutdown timed out, exiting');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    force.unref();

    server.close((err) => {
      if (err) logger.error({ err }, 'error closing http server');
      disconnectDb()
        .catch((e: unknown) => {
          logger.error({ err: e }, 'error closing database');
        })
        .finally(() => {
          process.exit(err ? 1 : 0);
        });
    });
  };
  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) {
    console.error(err.message);
  } else {
    console.error('failed to start api', err);
  }
  process.exit(1);
});
