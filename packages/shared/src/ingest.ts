import { z } from 'zod';

export const EXPORT_FORMATS = ['markdown', 'json', 'text', 'bundle'] as const;

export const ingestRequestSchema = z.object({
  // A branch, tag or full commit SHA. Defaults to the repository's default branch.
  ref: z
    .string()
    .regex(/^[\w./-]{1,100}$/)
    .optional(),
  // Re-ingest even when this commit has been ingested before.
  force: z.boolean().optional(),
});
export type IngestRequest = z.infer<typeof ingestRequestSchema>;

export const exportQuerySchema = z.object({
  format: z.enum(EXPORT_FORMATS).default('markdown'),
  // Token budget for the bundle format.
  tokens: z.coerce.number().int().min(1000).max(1_000_000).default(100_000),
});

export const ingestStatsSchema = z.object({
  filesInTree: z.number().int().nonnegative(),
  filesIngested: z.number().int().nonnegative(),
  bytesIngested: z.number().int().nonnegative(),
  // Files left out, by reason (binary, generated, lock, vendor, too-large, limit, ...).
  skipped: z.record(z.string(), z.number().int().nonnegative()),
  chunks: z.number().int().nonnegative(),
  duplicatesRemoved: z.number().int().nonnegative(),
  symbols: z.number().int().nonnegative(),
  brokenLinks: z.number().int().nonnegative(),
  findings: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  // Why the result may be incomplete: tree-truncated, time-limit, file-limit, size-limit.
  truncated: z.array(z.string()),
});
export type IngestStats = z.infer<typeof ingestStatsSchema>;

export const ingestionSchema = z.object({
  fullName: z.string(),
  sha: z.string(),
  ref: z.string().nullable(),
  status: z.enum(['running', 'completed', 'partial', 'failed']),
  private: z.boolean(),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
  stats: ingestStatsSchema.nullable(),
  error: z.string().nullable(),
  // True when an earlier run for the same commit was returned instead of doing the work again.
  reused: z.boolean(),
});
export type Ingestion = z.infer<typeof ingestionSchema>;

export const freshnessSchema = z.object({
  ingestedSha: z.string().nullable(),
  ingestedAt: z.string().nullable(),
  headSha: z.string().nullable(),
  // null when nothing has been ingested yet or the head could not be read.
  fresh: z.boolean().nullable(),
  commitsBehind: z.number().int().nonnegative().nullable(),
});
export type Freshness = z.infer<typeof freshnessSchema>;
