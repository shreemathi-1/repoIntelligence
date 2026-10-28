import { z } from 'zod';

export const repoSummarySchema = z.object({
  fullName: z.string().min(1),
  description: z.string().nullable(),
  private: z.boolean(),
  defaultBranch: z.string().min(1),
  // GitHub omits a language for some repositories; null means unavailable, not "none".
  language: z.string().nullable(),
  stars: z.number().int().nonnegative(),
  htmlUrl: z.url(),
});

export type RepoSummary = z.infer<typeof repoSummarySchema>;

export const repoResponseSchema = z.object({
  repo: repoSummarySchema,
  source: z.enum(['network', 'cache', 'revalidated']),
});

export type RepoResponse = z.infer<typeof repoResponseSchema>;
