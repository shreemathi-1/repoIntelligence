import mongoose from 'mongoose';
import { z } from 'zod';
import type {
  AskResponse,
  ChatMessage as ChatMessageView,
  ChatSession as ChatSessionView,
  ChatStatus,
  ExplainRequest,
  ExplainResponse,
  LlmUsageSummary,
  Suggestions,
} from '@repointelligence/shared';
import { AppError } from '../errors.js';
import type { Viewer } from '../github/service.js';
import type { GraphService } from '../graph/service.js';
import type { LlmGateway } from '../llm/gateway.js';
import { DATA_RULES, dataBlock } from '../llm/prompts.js';
import { completeStructured } from '../llm/structured.js';
import { ChatSession } from '../models/chat-session.js';
import { isObjectId, latestReadableRun, requireModelConsent } from '../ingest/access.js';
import type { IngestionRun } from '../models/ingestion-run.js';
import { usageToday } from '../llm/usage-sink.js';
import { answerQuestion } from './answer.js';
import type { EmbeddingIndexer } from './index.js';
import { boostTerms, classifyIntent, termsOf } from './intent.js';
import { redactSecrets } from './redact.js';
import { loadChunks, type HybridRetriever } from './retrieve.js';
import { followUps, modelSuggestions } from './suggest.js';

export const CHAT_QUOTA = { dailyQuestions: 50, maxSessionMessages: 200 } as const;

export interface ChatServiceOptions {
  gateway: LlmGateway;
  retriever: HybridRetriever;
  indexer: EmbeddingIndexer;
  graphs: GraphService;
  vectorSearch?: boolean;
  now?: () => number;
}

type RunDoc = InstanceType<typeof IngestionRun>;
type SessionDoc = InstanceType<typeof ChatSession>;

const explainSchema = z.object({
  summary: z.string().min(1).max(2_000),
  lines: z
    .array(z.object({ line: z.number().int().min(1), note: z.string().min(1).max(500) }))
    .max(200),
});

export class ChatService {
  private readonly now: () => number;

  constructor(private readonly options: ChatServiceOptions) {
    this.now = options.now ?? Date.now;
  }

  // ---- access ----------------------------------------------------------------------------------------

  /** The newest finished ingestion the caller may read; private runs belong to their owner. */
  latestRun(fullName: string, userId?: string, sha?: string): Promise<RunDoc | null> {
    return latestReadableRun(fullName, userId, sha);
  }

  private privacyOf(run: RunDoc, userId: string): Promise<boolean> {
    return requireModelConsent(run, userId);
  }

  async status(fullName: string, userId?: string): Promise<ChatStatus> {
    const run = await this.latestRun(fullName, userId);
    const privateContent = run?.private ?? false;
    const providers = this.options.gateway.route('chat', { privateContent }).map((r) => r.provider);
    const unique = [...new Set(providers)];
    return {
      fullName: fullName.toLowerCase(),
      sha: run?.sha ?? null,
      private: privateContent,
      chunks: run ? ((run.stats as { chunks?: number } | undefined)?.chunks ?? 0) : 0,
      embedding: {
        status: run?.embedding.status ?? 'none',
        embedded: run?.embedding.embedded ?? 0,
        model: run?.embedding.model ?? null,
        error: run?.embedding.error ?? null,
      },
      llm: {
        available: unique.length > 0,
        providers: unique,
        reason:
          unique.length > 0
            ? null
            : privateContent
              ? 'No configured provider may receive private repository content'
              : 'No model provider is configured on this server',
      },
      vectorSearch: this.options.vectorSearch ?? false,
    };
  }

  // ---- sessions --------------------------------------------------------------------------------------

  async createSession(fullName: string, userId: string): Promise<SessionDoc> {
    const run = await this.latestRun(fullName, userId);
    if (!run) throw AppError.notFound('Ingest this repository before chatting about it');
    await this.privacyOf(run, userId);
    // Embedding is best effort: keyword search answers until the vectors are ready.
    if (this.options.indexer.available && run.embedding.status === 'none') {
      await this.options.indexer.request(run).catch(() => undefined);
    }
    return ChatSession.create({ user: userId, fullName: run.fullName, sha: run.sha });
  }

  async listSessions(fullName: string, userId: string): Promise<SessionDoc[]> {
    return ChatSession.find({ user: userId, fullName: fullName.toLowerCase() })
      .sort({ updatedAt: -1 })
      .limit(50);
  }

  async getSession(id: string, userId: string): Promise<SessionDoc> {
    const session = isObjectId(id) ? await ChatSession.findById(id) : null;
    // Someone else's session looks exactly like a missing one.
    if (!session?.user.equals(userId)) throw AppError.notFound('Chat session not found');
    return session;
  }

  async deleteSession(id: string, userId: string): Promise<void> {
    const session = await this.getSession(id, userId);
    await session.deleteOne();
  }

  private async questionsToday(userId: string): Promise<number> {
    const dayStart = new Date(this.now());
    dayStart.setUTCHours(0, 0, 0, 0);
    const [row] = await ChatSession.aggregate<{ n: number }>([
      { $match: { user: new mongoose.Types.ObjectId(userId), updatedAt: { $gte: dayStart } } },
      { $unwind: '$messages' },
      { $match: { 'messages.role': 'user', 'messages.createdAt': { $gte: dayStart } } },
      { $count: 'n' },
    ]);
    return row?.n ?? 0;
  }

  async ask(id: string, userId: string, question: string): Promise<AskResponse> {
    const session = await this.getSession(id, userId);
    if (session.messages.length >= CHAT_QUOTA.maxSessionMessages) {
      throw AppError.badRequest('This session is full; start a new one');
    }
    if ((await this.questionsToday(userId)) >= CHAT_QUOTA.dailyQuestions) {
      throw AppError.quotaExceeded(`You have asked today's ${CHAT_QUOTA.dailyQuestions} questions`);
    }
    const run = await this.latestRun(session.fullName, userId, session.sha);
    if (!run) throw AppError.notFound('The ingestion this session reads from no longer exists');
    const privateContent = await this.privacyOf(run, userId);

    const intent = classifyIntent(question);
    const history = session.messages.map((m) => ({ role: m.role, content: m.content }));
    // A short follow-up ("and where is it called?") borrows the terms of the previous question.
    const previous = [...history].reverse().find((m) => m.role === 'user')?.content ?? '';
    const query = termsOf(question).length < 4 && previous ? `${question} ${previous}` : question;
    const graph = await this.options.graphs
      .load(session.fullName, session.sha)
      .then((g) => g.graph)
      .catch(() => null);
    const retrieval = await this.options.retriever.retrieve(query, {
      fullName: session.fullName,
      sha: session.sha,
      boost: boostTerms(question, graph),
      useVectors: run.embedding.status === 'ready',
    });

    const answer = await answerQuestion(this.options.gateway, {
      fullName: session.fullName,
      sha: session.sha,
      question,
      intent,
      history,
      retrieved: retrieval.chunks,
      evidence: retrieval.evidence,
      privateContent,
      userId,
    });

    const at = new Date(this.now());
    session.messages.push(
      { role: 'user', content: question, citations: [], createdAt: at },
      {
        role: 'assistant',
        content: answer.text,
        citations: answer.citations,
        confidence: answer.confidence,
        ...(answer.model && { answeredBy: answer.model }),
        createdAt: at,
      },
    );
    session.title ??= question.slice(0, 80);
    await session.save();

    const view = toSessionView(session);
    const last = view.messages.at(-1);
    if (!last) throw new Error('the answer was not stored');
    return {
      session: view,
      answer: last,
      retrieved: retrieval.chunks.length,
      suggestions: answer.noEvidence ? [] : followUps(intent, answer.citations),
    };
  }

  // ---- extras ----------------------------------------------------------------------------------------

  async suggestions(fullName: string, userId: string): Promise<Suggestions> {
    const run = await this.latestRun(fullName, userId);
    if (!run) throw AppError.notFound('Ingest this repository before chatting about it');
    const privateContent = await this.privacyOf(run, userId);
    const [chunks, graph] = await Promise.all([
      loadChunks(run.fullName, run.sha),
      this.options.graphs
        .load(run.fullName, run.sha)
        .then((g) => g.graph)
        .catch(() => null),
    ]);
    return modelSuggestions(this.options.gateway, {
      fullName: run.fullName,
      graph,
      chunks,
      privateContent,
      userId,
    });
  }

  /** Explains a range of lines, one note per line that needs one. */
  async explain(
    owner: string,
    name: string,
    request: ExplainRequest,
    userId: string,
    viewer?: Viewer,
  ): Promise<ExplainResponse> {
    const fullName = `${owner}/${name}`;
    const run = await this.latestRun(fullName, userId, request.sha);
    if (!run) throw AppError.notFound('Ingest this commit before asking about its code');
    const privateContent = await this.privacyOf(run, userId);
    const source = await this.options.graphs.source(owner, name, run.sha, request.path, viewer);
    const all = source.content.split('\n');
    if (request.startLine > all.length) throw AppError.badRequest('The file is shorter than that');
    const endLine = Math.min(request.endLine, all.length);
    const numbered = all
      .slice(request.startLine - 1, endLine)
      .map((text, i) => `${request.startLine + i}: ${text}`)
      .join('\n');
    const { data, result } = await completeStructured(
      this.options.gateway,
      'explain',
      [
        {
          role: 'system',
          content:
            'You explain source code to a developer, line by line. ' +
            `${DATA_RULES} Each line of the data block starts with its line number. ` +
            'Never reveal secret values. Reply with JSON: ' +
            '{"summary": "what the lines do overall", "lines": [{"line": <number>, "note": "..."}]}. ' +
            'Add a note only for lines that do something worth explaining.',
        },
        {
          role: 'user',
          content: dataBlock(
            { path: request.path, startLine: request.startLine, endLine },
            redactSecrets(numbered),
          ),
        },
      ],
      explainSchema,
      { privateContent, fullName: run.fullName, userId },
    );
    return {
      path: request.path,
      sha: run.sha,
      startLine: request.startLine,
      endLine,
      summary: redactSecrets(data.summary),
      // Notes for lines outside the range are dropped: they cannot refer to the code shown.
      lines: data.lines
        .filter((l) => l.line >= request.startLine && l.line <= endLine)
        .map((l) => ({ line: l.line, note: redactSecrets(l.note) })),
      model: `${result.provider}/${result.model}`,
    };
  }

  async usage(userId: string): Promise<LlmUsageSummary> {
    const [totals, asked] = await Promise.all([
      usageToday(userId, this.now()),
      this.questionsToday(userId),
    ]);
    return {
      day: new Date(this.now()).toISOString().slice(0, 10),
      ...totals,
      questionsLeft: Math.max(0, CHAT_QUOTA.dailyQuestions - asked),
    };
  }
}

// ---- views -----------------------------------------------------------------------------------------

export function toMessageView(m: SessionDoc['messages'][number]): ChatMessageView {
  return {
    role: m.role,
    content: m.content,
    citations: m.citations.map((c) => ({
      path: c.path,
      startLine: c.startLine,
      endLine: c.endLine,
    })),
    confidence: m.confidence ?? null,
    model: m.answeredBy ?? null,
    createdAt: m.createdAt.toISOString(),
  };
}

export function toSessionView(session: SessionDoc): ChatSessionView {
  return {
    id: session.id,
    fullName: session.fullName,
    sha: session.sha,
    title: session.title ?? null,
    messages: session.messages.map(toMessageView),
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
  };
}

const CONFIDENCE_LABEL = {
  verified: 'citations checked',
  inferred: 'partly supported',
  insufficient: 'no evidence found',
} as const;

/** The session as a Markdown document, with citations linked to the files at the pinned commit. */
export function sessionMarkdown(session: ChatSessionView): string {
  const link = (c: { path: string; startLine: number; endLine: number }) =>
    `https://github.com/${session.fullName}/blob/${session.sha}/${c.path}#L${c.startLine}-L${c.endLine}`;
  const lines = [
    `# ${session.title ?? 'Chat'}`,
    '',
    `Repository: ${session.fullName}  `,
    `Commit: ${session.sha}  `,
    `Exported: ${session.updatedAt}`,
    '',
    '> Answers were generated from repository content at this commit. Citations were checked',
    '> against the files that were retrieved; prose is not verified.',
    '',
  ];
  for (const m of session.messages) {
    if (m.role === 'user') {
      lines.push(`## ${m.content.replace(/\n/g, ' ')}`, '');
      continue;
    }
    const meta = [m.confidence && CONFIDENCE_LABEL[m.confidence], m.model]
      .filter(Boolean)
      .join(', ');
    lines.push(m.content, '');
    if (meta) lines.push(`_${meta}_`, '');
    if (m.citations.length > 0) {
      lines.push('Sources:', '');
      for (const c of m.citations)
        lines.push(`- [${c.path}:${c.startLine}-${c.endLine}](${link(c)})`);
      lines.push('');
    }
  }
  return `${lines.join('\n').trimEnd()}\n`;
}
