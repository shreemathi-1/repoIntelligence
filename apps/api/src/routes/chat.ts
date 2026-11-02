import { Router, type Response } from 'express';
import {
  analyzeRequestSchema,
  askRequestSchema,
  explainRequestSchema,
  ownerNameParams,
  type ChatSessionList,
} from '@repointelligence/shared';
import { z } from 'zod';
import { authConfigOf, type Config } from '../config.js';
import { AppError } from '../errors.js';
import { loadViewer } from '../github/viewer.js';
import { sessionMarkdown, toSessionView, type ChatService } from '../rag/chat-service.js';
import type { EmbeddingIndexer } from '../rag/index.js';

const idParams = z.object({ id: z.string().regex(/^[0-9a-f]{24}$/i) });

function requireUser(res: Response, message?: string): string {
  const userId = typeof res.locals.userId === 'string' ? res.locals.userId : undefined;
  if (!userId) throw AppError.unauthorized(message);
  return userId;
}

/** Repository-scoped chat routes. Mounted under /repos behind optionalAuth. */
export function createChatRepoRouter(
  config: Config,
  chat: ChatService,
  indexer: EmbeddingIndexer,
): Router {
  const router = Router();
  const auth = authConfigOf(config);

  router.get('/:owner/:name/chat/status', async (req, res) => {
    const { owner, name } = ownerNameParams.parse(req.params);
    const userId = typeof res.locals.userId === 'string' ? res.locals.userId : undefined;
    res.json(await chat.status(`${owner}/${name}`, userId));
  });

  router.post('/:owner/:name/chat/sessions', async (req, res) => {
    const { owner, name } = ownerNameParams.parse(req.params);
    const userId = requireUser(res, 'Sign in to chat about a repository');
    const session = await chat.createSession(`${owner}/${name}`, userId);
    res.status(201).json(toSessionView(session));
  });

  router.get('/:owner/:name/chat/sessions', async (req, res) => {
    const { owner, name } = ownerNameParams.parse(req.params);
    const userId = requireUser(res);
    const sessions = await chat.listSessions(`${owner}/${name}`, userId);
    const body: ChatSessionList = {
      sessions: sessions.map((s) => ({ ...toSessionView(s), messages: s.messages.length })),
    };
    res.json(body);
  });

  router.get('/:owner/:name/chat/suggestions', async (req, res) => {
    const { owner, name } = ownerNameParams.parse(req.params);
    const userId = requireUser(res);
    res.json(await chat.suggestions(`${owner}/${name}`, userId));
  });

  router.post('/:owner/:name/chat/index', async (req, res) => {
    const { owner, name } = ownerNameParams.parse(req.params);
    const userId = requireUser(res, 'Sign in to index a repository');
    const { force } = analyzeRequestSchema.parse(req.body ?? {});
    const run = await chat.latestRun(`${owner}/${name}`, userId);
    if (!run) throw AppError.notFound('Ingest this repository before indexing it');
    await indexer.request(run, force ?? false);
    res.status(202).json(await chat.status(`${owner}/${name}`, userId));
  });

  router.post('/:owner/:name/explain', async (req, res) => {
    const { owner, name } = ownerNameParams.parse(req.params);
    const userId = requireUser(res, 'Sign in to explain code');
    const body = explainRequestSchema.parse(req.body);
    const viewer = await loadViewer(res.locals.userId, auth);
    res.json(await chat.explain(owner, name, body, userId, viewer));
  });

  return router;
}

/** Session routes. Mounted under /chat/sessions behind optionalAuth. */
export function createChatSessionRouter(chat: ChatService): Router {
  const router = Router();

  router.get('/:id', async (req, res) => {
    const { id } = idParams.parse(req.params);
    res.json(toSessionView(await chat.getSession(id, requireUser(res))));
  });

  router.post('/:id/messages', async (req, res) => {
    const { id } = idParams.parse(req.params);
    const userId = requireUser(res);
    const { question } = askRequestSchema.parse(req.body);
    res.json(await chat.ask(id, userId, question));
  });

  router.delete('/:id', async (req, res) => {
    const { id } = idParams.parse(req.params);
    await chat.deleteSession(id, requireUser(res));
    res.status(204).end();
  });

  router.get('/:id/export.md', async (req, res) => {
    const { id } = idParams.parse(req.params);
    const view = toSessionView(await chat.getSession(id, requireUser(res)));
    const [owner = 'repo', name = 'chat'] = view.fullName.split('/');
    res
      .type('text/markdown; charset=utf-8')
      .setHeader(
        'Content-Disposition',
        `attachment; filename="${owner}-${name}-chat-${view.id.slice(-6)}.md"`,
      )
      .send(sessionMarkdown(view));
  });

  return router;
}

/** Mounted under /me behind requireAuth. */
export function createLlmUsageRouter(chat: ChatService): Router {
  const router = Router();
  router.get('/llm-usage', async (_req, res) => {
    res.json(await chat.usage(requireUser(res)));
  });
  return router;
}
