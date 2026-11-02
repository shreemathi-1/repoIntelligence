import { z } from 'zod';

export const citationSchema = z.object({
  path: z.string().min(1),
  startLine: z.number().int().min(1),
  endLine: z.number().int().min(1),
});
export type Citation = z.infer<typeof citationSchema>;

// verified: every claim points at lines that exist in the repository at this commit.
// inferred: the answer draws on retrieved material but some citations could not be checked.
// insufficient: nothing in the repository supported an answer; the reply says so.
export const CONFIDENCE_LEVELS = ['verified', 'inferred', 'insufficient'] as const;
export const confidenceSchema = z.enum(CONFIDENCE_LEVELS);
export type Confidence = z.infer<typeof confidenceSchema>;

export const chatMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  citations: z.array(citationSchema),
  confidence: confidenceSchema.nullable(),
  // Provider and model that produced an assistant message, for example "groq/openai/gpt-oss-120b".
  model: z.string().nullable(),
  createdAt: z.string(),
});
export type ChatMessage = z.infer<typeof chatMessageSchema>;

export const chatSessionSchema = z.object({
  id: z.string(),
  fullName: z.string(),
  // The commit the session reads from; answers cite lines at this commit.
  sha: z.string(),
  title: z.string().nullable(),
  messages: z.array(chatMessageSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ChatSession = z.infer<typeof chatSessionSchema>;

export const chatSessionListSchema = z.object({
  sessions: z.array(chatSessionSchema.omit({ messages: true }).extend({ messages: z.number() })),
});
export type ChatSessionList = z.infer<typeof chatSessionListSchema>;

export const askRequestSchema = z.object({
  question: z.string().trim().min(1).max(2000),
});
export type AskRequest = z.infer<typeof askRequestSchema>;

export const askResponseSchema = z.object({
  session: chatSessionSchema,
  answer: chatMessageSchema,
  // How many chunks were retrieved as evidence for this answer.
  retrieved: z.number().int().nonnegative(),
  suggestions: z.array(z.string()),
});
export type AskResponse = z.infer<typeof askResponseSchema>;

export const EMBEDDING_STATUSES = ['none', 'queued', 'running', 'ready', 'failed'] as const;

export const chatStatusSchema = z.object({
  fullName: z.string(),
  // The commit chat would answer from, or null when nothing has been ingested.
  sha: z.string().nullable(),
  private: z.boolean(),
  chunks: z.number().int().nonnegative(),
  embedding: z.object({
    status: z.enum(EMBEDDING_STATUSES),
    embedded: z.number().int().nonnegative(),
    model: z.string().nullable(),
    error: z.string().nullable(),
  }),
  // Whether answers can be produced at all, and why not.
  llm: z.object({
    available: z.boolean(),
    providers: z.array(z.string()),
    reason: z.string().nullable(),
  }),
  vectorSearch: z.boolean(),
});
export type ChatStatus = z.infer<typeof chatStatusSchema>;

export const suggestionsSchema = z.object({
  questions: z.array(z.string()),
  source: z.enum(['model', 'static']),
});
export type Suggestions = z.infer<typeof suggestionsSchema>;

export const MAX_EXPLAIN_LINES = 120;

export const explainRequestSchema = z
  .object({
    sha: z.string().regex(/^[0-9a-f]{40}$/i),
    path: z.string().min(1).max(500),
    startLine: z.number().int().min(1),
    endLine: z.number().int().min(1),
  })
  .refine((v) => v.endLine >= v.startLine, 'endLine must not be before startLine')
  .refine(
    (v) => v.endLine - v.startLine < MAX_EXPLAIN_LINES,
    `Explain at most ${MAX_EXPLAIN_LINES} lines at a time`,
  );
export type ExplainRequest = z.infer<typeof explainRequestSchema>;

export const explainResponseSchema = z.object({
  path: z.string(),
  sha: z.string(),
  startLine: z.number().int(),
  endLine: z.number().int(),
  summary: z.string(),
  lines: z.array(z.object({ line: z.number().int(), note: z.string() })),
  model: z.string(),
});
export type ExplainResponse = z.infer<typeof explainResponseSchema>;

export const llmUsageSchema = z.object({
  day: z.string(),
  calls: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  byProvider: z.record(
    z.string(),
    z.object({
      calls: z.number().int().nonnegative(),
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
    }),
  ),
  // Questions left today under the chat quota.
  questionsLeft: z.number().int().nonnegative(),
});
export type LlmUsageSummary = z.infer<typeof llmUsageSchema>;

export const embedResponseSchema = z.object({
  model: z.string(),
  dimensions: z.number().int().positive(),
  vectors: z.array(z.array(z.number())),
});
export type EmbedResponse = z.infer<typeof embedResponseSchema>;
