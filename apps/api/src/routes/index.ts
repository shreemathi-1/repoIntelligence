import { Router } from 'express';
import { authConfigOf, type Config } from '../config.js';
import { InlineQueue, type JobKind, type RunQueue } from '../analysis/queue.js';
import { GraphService } from '../graph/service.js';
import { AnalysisService } from '../analysis/service.js';
import { WorkerClient } from '../analysis/worker-client.js';
import { IngestionService } from '../ingest/service.js';
import { DiscoveryService } from '../discovery/service.js';
import { DocsService } from '../docs/service.js';
import { providersFromEnv } from '../llm/adapters/index.js';
import { LlmGateway } from '../llm/gateway.js';
import { MongoUsageSink } from '../llm/usage-sink.js';
import { ChatService } from '../rag/chat-service.js';
import { EmbeddingIndexer } from '../rag/index.js';
import { HybridRetriever } from '../rag/retrieve.js';
import { GithubService } from '../github/service.js';
import { optionalAuth, requireAuth } from '../middleware/require-auth.js';
import {
  createAnalysisRepoRouter,
  createAnalysisRunRouter,
  createQuotaRouter,
} from './analysis.js';
import { createAuthRouter } from './auth.js';
import { createChatRepoRouter, createChatSessionRouter, createLlmUsageRouter } from './chat.js';
import { createGraphRepoRouter, createGraphRunRouter } from './graph.js';
import { createDiscoveryRouter } from './discovery.js';
import { createDocQuotaRouter, createDocsRepoRouter, createDocsRouter } from './docs.js';
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
  /** The job queue for analyses. Without one, jobs run inline on the next tick. */
  queue?: (handler: (runId: string, attempt: number, kind: JobKind) => Promise<void>) => RunQueue;
  analysis?: AnalysisService;
  graphs?: GraphService;
  /** The model gateway. Without one, adapters are built from the provider keys in the config. */
  llm?: LlmGateway;
}

export function createApiRouter(config: Config, deps: AppDeps = {}): Router {
  const router = Router();
  const fetchImpl = deps.fetch ?? fetch;
  const github =
    deps.github ?? new GithubService({ fetch: deps.fetch, serverToken: config.GITHUB_TOKEN });
  const discovery = new DiscoveryService(github);
  const ingestion = deps.ingestion ?? new IngestionService(github);
  // The queue, the analysis service and the graph service refer to each other; the handler
  // closes the loop and is only called once all three exist.
  const handler = (runId: string, attempt: number, kind: JobKind): Promise<void> =>
    kind === 'graph'
      ? graphs.process(runId, attempt)
      : kind === 'embed'
        ? indexer.process(runId, attempt)
        : analysis.process(runId, attempt);
  const queue = deps.queue ? deps.queue(handler) : new InlineQueue(handler);
  const worker =
    config.WORKER_URL && config.WORKER_SHARED_SECRET
      ? new WorkerClient({
          url: config.WORKER_URL,
          secret: config.WORKER_SHARED_SECRET,
          fetch: deps.fetch,
        })
      : undefined;
  const shared = { github, queue, worker, fetch: deps.fetch, serverToken: config.GITHUB_TOKEN };
  const analysis = deps.analysis ?? new AnalysisService(shared);
  const graphs = deps.graphs ?? new GraphService(shared);
  const gateway =
    deps.llm ??
    new LlmGateway({
      providers: providersFromEnv(config, deps.fetch),
      usage: new MongoUsageSink(),
    });
  const retriever = new HybridRetriever({
    vectorSearch: config.VECTOR_SEARCH_ENABLED,
    ...(worker && {
      embedQuery: async (text: string) => (await worker.embed([text])).vectors[0] ?? null,
    }),
  });
  const indexer = new EmbeddingIndexer({ queue, worker, retriever });
  const docs = new DocsService({ github, graphs, ingestion, gateway, fetch: deps.fetch });
  const chat = new ChatService({
    gateway,
    retriever,
    indexer,
    graphs,
    vectorSearch: config.VECTOR_SEARCH_ENABLED,
  });
  const jwtSecret = authConfigOf(config)?.jwtSecret;
  const guard = requireAuth(jwtSecret);
  const maybe = optionalAuth(jwtSecret);

  router.use('/auth', createAuthRouter(config, fetchImpl));
  router.use('/me', guard, createMeRouter());
  router.use('/me', guard, createLibraryRouter(config, discovery));
  router.use('/me', guard, createQuotaRouter(analysis));
  router.use('/me', guard, createLlmUsageRouter(chat));
  router.use('/me', guard, createDocQuotaRouter(docs));
  router.use('/repos', maybe, createReposRouter(config, github));
  router.use('/repos', maybe, createIngestRouter(config, ingestion));
  router.use('/repos', maybe, createAnalysisRepoRouter(config, analysis));
  router.use('/analyses', maybe, createAnalysisRunRouter(analysis));
  router.use('/repos', maybe, createGraphRepoRouter(config, graphs));
  router.use('/graph-builds', maybe, createGraphRunRouter(graphs));
  router.use('/repos', maybe, createChatRepoRouter(config, chat, indexer));
  router.use('/chat/sessions', maybe, createChatSessionRouter(chat));
  router.use('/repos', maybe, createDocsRepoRouter(config, docs));
  router.use('/docs', maybe, createDocsRouter(config, docs));
  router.use(maybe, createDiscoveryRouter(config, discovery));
  return router;
}
