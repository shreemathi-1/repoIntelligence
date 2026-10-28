import { loadConfig } from '../config.js';
import { connectDb, disconnectDb } from '../db.js';
import { runTrendingJob } from '../discovery/trending-job.js';
import { GithubService } from '../github/service.js';
import { createLogger } from '../logger.js';

// Run by hand with `npm run job:trending` to fill the lists without waiting for 03:00 UTC.
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);
  await connectDb(config.MONGODB_URI);
  try {
    const github = new GithubService({ serverToken: config.GITHUB_TOKEN });
    const result = await runTrendingJob({
      github,
      logger,
      paceMs: config.GITHUB_TOKEN ? 2200 : 6500,
    });
    logger.info(result, 'done');
  } finally {
    await disconnectDb();
  }
}

main().catch((err: unknown) => {
  console.error('trending job failed', err);
  process.exit(1);
});
