import { z } from 'zod';

const slug = /^[\w.-]{1,100}$/;
export const fullNameSchema = z.string().regex(/^[\w.-]{1,100}\/[\w.-]{1,100}$/, 'Use owner/name');

export const SEARCH_SORTS = ['best-match', 'stars', 'forks', 'updated'] as const;
export const SIZE_BUCKETS = ['small', 'medium', 'large'] as const;

export const searchParamsSchema = z
  .object({
    q: z.string().trim().max(200).optional(),
    language: z
      .string()
      .regex(/^[\w+#. -]{1,40}$/)
      .optional(),
    topic: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,49}$/)
      .optional(),
    license: z
      .string()
      .regex(/^[a-z0-9][a-z0-9.-]{0,40}$/)
      .optional(),
    minStars: z.coerce.number().int().min(0).optional(),
    maxStars: z.coerce.number().int().min(0).optional(),
    activeWithinDays: z.coerce.number().int().min(1).max(3650).optional(),
    size: z.enum(SIZE_BUCKETS).optional(),
    includeArchived: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .optional(),
    sort: z.enum(SEARCH_SORTS).default('best-match'),
    order: z.enum(['asc', 'desc']).default('desc'),
    page: z.coerce.number().int().min(1).max(34).default(1),
    perPage: z.coerce.number().int().min(1).max(30).default(20),
  })
  .refine((p) => p.minStars === undefined || p.maxStars === undefined || p.minStars <= p.maxStars, {
    message: 'minStars cannot exceed maxStars',
    path: ['minStars'],
  });

export type SearchParams = z.infer<typeof searchParamsSchema>;

export const LICENSE_CATEGORIES = [
  'permissive',
  'public-domain',
  'weak-copyleft',
  'strong-copyleft',
  'network-copyleft',
  'none',
  'unknown',
] as const;

export const licenseInfoSchema = z.object({
  spdxId: z.string().nullable(),
  category: z.enum(LICENSE_CATEGORIES),
  // Plain-language adoption restrictions worth knowing before reuse.
  flags: z.array(z.string()),
});
export type LicenseInfo = z.infer<typeof licenseInfoSchema>;

export const repoCardSchema = z.object({
  fullName: z.string().min(1),
  description: z.string().nullable(),
  language: z.string().nullable(),
  stars: z.number().int().nonnegative(),
  forks: z.number().int().nonnegative(),
  openIssues: z.number().int().nonnegative(),
  topics: z.array(z.string()),
  license: licenseInfoSchema,
  pushedAt: z.string().nullable(),
  createdAt: z.string().nullable(),
  sizeKb: z.number().int().nonnegative().nullable(),
  archived: z.boolean(),
  htmlUrl: z.url(),
});
export type RepoCard = z.infer<typeof repoCardSchema>;

export const searchResponseSchema = z.object({
  items: z.array(repoCardSchema),
  totalCount: z.number().int().nonnegative(),
  // GitHub sets this when the search timed out and results may be partial.
  incomplete: z.boolean(),
  page: z.number().int(),
  perPage: z.number().int(),
  query: z.string(),
});
export type SearchResponse = z.infer<typeof searchResponseSchema>;

export const TRENDING_PERIODS = ['daily', 'weekly', 'monthly'] as const;
export const trendingQuerySchema = z.object({
  period: z.enum(TRENDING_PERIODS).default('weekly'),
  topic: z
    .string()
    .regex(/^[a-z0-9-]{1,40}$/)
    .optional(),
});

export const trendingItemSchema = z.object({ repo: repoCardSchema, score: z.number() });
export const trendingResponseSchema = z.object({
  period: z.enum(TRENDING_PERIODS),
  topic: z.string().nullable(),
  // null means the job has not produced this list yet. It is not an empty result.
  computedAt: z.string().nullable(),
  // GitHub has no trending API, so this is always our own estimate.
  estimate: z.literal(true),
  items: z.array(trendingItemSchema),
});
export type TrendingResponse = z.infer<typeof trendingResponseSchema>;

export const trendingTopicsResponseSchema = z.object({
  technologies: z.array(z.object({ id: z.string(), label: z.string() })),
  useCases: z.array(z.object({ id: z.string(), label: z.string() })),
});

export const beginnerSignalSchema = z.object({
  id: z.string(),
  label: z.string(),
  status: z.enum(['present', 'absent', 'unavailable']),
  weight: z.number(),
  evidence: z.string(),
});
export const beginnerScoreSchema = z.object({
  // null when no signal could be observed. Never 0 for missing data.
  score: z.number().min(0).max(100).nullable(),
  // Share of the total signal weight we could actually observe.
  confidence: z.number().min(0).max(1),
  signals: z.array(beginnerSignalSchema),
});
export type BeginnerScore = z.infer<typeof beginnerScoreSchema>;

export const similarResponseSchema = z.object({
  basis: z.object({ language: z.string().nullable(), topics: z.array(z.string()) }),
  items: z.array(z.object({ repo: repoCardSchema, similarity: z.number().min(0).max(1) })),
});
export type SimilarResponse = z.infer<typeof similarResponseSchema>;

export const activityResponseSchema = z.object({
  status: z.enum(['ready', 'pending', 'unavailable']),
  stars: z.number().int().nonnegative(),
  forks: z.number().int().nonnegative(),
  // 52 weekly commit totals, oldest first. null while GitHub is still computing them.
  commitsByWeek: z.array(z.number().int().nonnegative()).nullable(),
  contributors: z.number().int().nonnegative().nullable(),
});
export type ActivityResponse = z.infer<typeof activityResponseSchema>;

export const compareQuerySchema = z.object({
  repos: z
    .string()
    .transform((value) =>
      value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    )
    .pipe(z.array(fullNameSchema).min(2).max(4)),
});

export const compareItemSchema = z.object({
  fullName: z.string(),
  status: z.enum(['ok', 'not_found', 'unavailable']),
  repo: repoCardSchema.nullable(),
  beginner: beginnerScoreSchema.nullable(),
  commitsLast4Weeks: z.number().int().nonnegative().nullable(),
});
export const compareResponseSchema = z.object({ items: z.array(compareItemSchema) });
export type CompareResponse = z.infer<typeof compareResponseSchema>;

export const contributeQuerySchema = z.object({
  language: z
    .string()
    .regex(/^[\w+#. -]{1,40}$/)
    .optional(),
  repo: fullNameSchema.optional(),
  page: z.coerce.number().int().min(1).max(34).default(1),
});
export const issueSchema = z.object({
  repo: z.string(),
  number: z.number().int(),
  title: z.string(),
  htmlUrl: z.url(),
  labels: z.array(z.string()),
  comments: z.number().int().nonnegative(),
  createdAt: z.string(),
});
export const contributeResponseSchema = z.object({
  totalCount: z.number().int().nonnegative(),
  items: z.array(issueSchema),
});
export type ContributeResponse = z.infer<typeof contributeResponseSchema>;

export const developerProfileSchema = z.object({
  login: z.string(),
  name: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  bio: z.string().nullable(),
  publicRepos: z.number().int().nonnegative(),
  followers: z.number().int().nonnegative(),
  memberSince: z.string(),
  totalStars: z.number().int().nonnegative(),
  activeRepos90d: z.number().int().nonnegative(),
  topLanguages: z.array(
    z.object({ language: z.string(), repos: z.number().int(), stars: z.number().int() }),
  ),
  topRepos: z.array(repoCardSchema),
  // Only the 100 most recently pushed repositories are inspected.
  sampledRepos: z.number().int().nonnegative(),
});
export type DeveloperProfile = z.infer<typeof developerProfileSchema>;

export const saveRepoSchema = z.object({
  fullName: fullNameSchema,
  note: z.string().max(500).optional(),
});
export const savedItemSchema = z.object({
  fullName: z.string(),
  description: z.string().nullable(),
  language: z.string().nullable(),
  stars: z.number().int().nullable(),
  note: z.string().nullable(),
  savedAt: z.string(),
  collections: z.array(z.string()),
});
export const savedListSchema = z.object({ items: z.array(savedItemSchema) });
export type SavedItem = z.infer<typeof savedItemSchema>;

export const collectionInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().max(500).optional(),
});
export const collectionSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  repositories: z.array(z.string()),
});
export const collectionListSchema = z.object({ items: z.array(collectionSchema) });
export type CollectionView = z.infer<typeof collectionSchema>;

export const watchItemSchema = z.object({ fullName: z.string(), addedAt: z.string() });
export const watchListSchema = z.object({ items: z.array(watchItemSchema) });
export const watchChangeSchema = z.object({
  fullName: z.string(),
  status: z.enum(['ok', 'unavailable']),
  latestRelease: z.string().nullable(),
  latestCommitSha: z.string().nullable(),
  latestCommitAt: z.string().nullable(),
  openIssues: z.number().int().nullable(),
  // null means we have nothing to compare with yet (first check) or could not observe it.
  newRelease: z.boolean().nullable(),
  newCommits: z.boolean().nullable(),
  openIssuesDelta: z.number().int().nullable(),
});
export const watchChangesSchema = z.object({ items: z.array(watchChangeSchema) });
export type WatchChange = z.infer<typeof watchChangeSchema>;

export const historyItemSchema = z.object({
  id: z.string(),
  kind: z.enum(['search', 'viewed']),
  query: z.string().nullable(),
  fullName: z.string().nullable(),
  at: z.string(),
});
export const historyListSchema = z.object({ items: z.array(historyItemSchema) });
export type HistoryItem = z.infer<typeof historyItemSchema>;

export const ownerNameParams = z.object({
  owner: z.string().regex(slug),
  name: z.string().regex(slug),
});
