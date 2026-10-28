import { Router } from 'express';
import { authConfigOf, type Config } from '../config.js';
import { IngestionService } from '../ingest/service.js';
import { DiscoveryService } from '../discovery/service.js';
import { GithubService } from '../github/service.js';
import { optionalAuth, requireAuth } from '../middleware/require-auth.js';
import { createAuthRouter } from './auth.js';
import { createDiscoveryRouter } from './discovery.js';
import { createIngestRouter } from './ingest.js';
import { createLibraryRouter } from './library.js';
import { createMeRouter } from './me.js';
import { createReposRouter } from './repos.js';

export interface AppDeps {
  /** Replaces the global fetch for GitHub calls; tests use it to avoid the network. */
  fetch?: typeof fetch;
  github?: GithubService;
  /** Tests inject a clock and limits; the defaults suit production. */
  ingestion?: IngestionService;
}

export function createApiRouter(config: Config, deps: AppDeps = {}): Router {
  const router = Router();
  const fetchImpl = deps.fetch ?? fetch;
  const github =
    deps.github ?? new GithubService({ fetch: deps.fetch, serverToken: config.GITHUB_TOKEN });
  const discovery = new DiscoveryService(github);
  const ingestion = deps.ingestion ?? new IngestionService(github);
  const jwtSecret = authConfigOf(config)?.jwtSecret;
  const guard = requireAuth(jwtSecret);
  const maybe = optionalAuth(jwtSecret);

  router.use('/auth', createAuthRouter(config, fetchImpl));
  router.use('/me', guard, createMeRouter());
  router.use('/me', guard, createLibraryRouter(config, discovery));
  router.use('/repos', maybe, createReposRouter(config, github));
  router.use('/repos', maybe, createIngestRouter(config, ingestion));
  router.use(maybe, createDiscoveryRouter(config, discovery));
  return router;
}
