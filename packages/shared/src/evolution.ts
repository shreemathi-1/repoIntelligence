import { z } from 'zod';
import { AREAS, SEVERITIES, findingSchema } from './analysis.js';

// Every evolution response keeps what was retrieved or computed (`facts`) apart from what a model
// wrote about it (`interpretation`). Facts never contain model text; interpretation is optional.

export const FACT_SOURCES = ['github', 'computed', 'analysis', 'graph'] as const;
export type FactSource = (typeof FACT_SOURCES)[number];

export const SERIES_STATUSES = ['ok', 'pending', 'unavailable'] as const;
/** `pending` means GitHub is still computing the statistic; ask again shortly. */
export const seriesStatusSchema = z.enum(SERIES_STATUSES);

export const EVOLUTION_WEEKS = [12, 26, 52] as const;
export const evolutionQuerySchema = z.object({
  weeks: z
    .enum(['12', '26', '52'])
    .default('52')
    .transform((w) => Number(w) as (typeof EVOLUTION_WEEKS)[number]),
});

const ref = z
  .string()
  .regex(/^[\w./-]{1,100}$/)
  .refine((r) => !r.includes('..'), 'Invalid ref');
const runId = z.string().regex(/^[0-9a-f]{24}$/i);

export const refCompareQuerySchema = z.object({ base: ref, head: ref });
export const timelineQuerySchema = z.object({
  ref: ref.optional(),
  page: z.coerce.number().int().min(1).max(10).default(1),
});
export const snapshotCompareQuerySchema = z.object({ a: runId, b: runId });

export const interpretationSchema = z.object({
  summary: z.string(),
  highlights: z.array(z.string()),
  risks: z.array(z.string()),
  // The model that wrote it, e.g. `groq/openai/gpt-oss-120b`.
  writtenBy: z.string(),
  generatedAt: z.string(),
});
export type Interpretation = z.infer<typeof interpretationSchema>;

/** The common envelope. Pass `z.never()` for endpoints that never carry an interpretation. */
export function evolutionResponse<F extends z.ZodType, I extends z.ZodType>(
  facts: F,
  interpretation: I,
) {
  return z.object({
    fullName: z.string(),
    retrievedAt: z.string(),
    sources: z.array(z.enum(FACT_SOURCES)),
    // Caveats a reader needs: sampled series, capped lists, statistics still computing.
    notes: z.array(z.string()),
    facts,
    interpretation: interpretation.nullable(),
  });
}

// ---- commits -----------------------------------------------------------------------------------

export const COMMIT_GROUPS = [
  'breaking',
  'feat',
  'fix',
  'perf',
  'docs',
  'refactor',
  'other',
  'chore',
  'merge',
] as const;
export type CommitGroup = (typeof COMMIT_GROUPS)[number];

export const commitItemSchema = z.object({
  sha: z.string(),
  subject: z.string(),
  author: z.string().nullable(),
  login: z.string().nullable(),
  date: z.string().nullable(),
  group: z.enum(COMMIT_GROUPS),
  pr: z.number().int().nullable(),
  url: z.string().nullable(),
});
export type CommitItem = z.infer<typeof commitItemSchema>;

export const releaseItemSchema = z.object({
  tag: z.string(),
  name: z.string().nullable(),
  // null for plain tags, which carry no date.
  publishedAt: z.string().nullable(),
  prerelease: z.boolean(),
  url: z.string().nullable(),
  daysSincePrevious: z.number().nullable(),
});
export type ReleaseItem = z.infer<typeof releaseItemSchema>;

export const timelineFactsSchema = z.object({
  ref: z.string(),
  page: z.number().int(),
  hasMore: z.boolean(),
  commits: z.array(commitItemSchema),
  releases: z.array(releaseItemSchema),
});
export const timelineSchema = evolutionResponse(timelineFactsSchema, z.never());
export type Timeline = z.infer<typeof timelineSchema>;

// ---- activity ----------------------------------------------------------------------------------

const count = z.number().int().nonnegative().nullable();
const series = { status: seriesStatusSchema, reason: z.string().nullable() };

export const activityFactsSchema = z.object({
  weeks: z.number().int(),
  commits: z.object({
    ...series,
    points: z.array(z.object({ week: z.string(), commits: count })),
    total: count,
    perWeekAverage: z.number().nullable(),
    // Second half of the window against the first, in percent.
    changePercent: z.number().nullable(),
    // Sunday first, summed over the window.
    byWeekday: z.array(z.number().int().nonnegative()).nullable(),
  }),
  codeFrequency: z.object({
    ...series,
    points: z.array(z.object({ week: z.string(), additions: count, deletions: count })),
  }),
  contributors: z.object({
    ...series,
    points: z.array(z.object({ week: z.string(), active: count, newcomers: count })),
    top: z.array(
      z.object({
        login: z.string(),
        commits: z.number().int(),
        additions: z.number().int(),
        deletions: z.number().int(),
      }),
    ),
    // Fewest authors whose commits make up half of the window's commits.
    busFactor: count,
    previousBusFactor: count,
    // GitHub only reports the top 100 authors.
    truncated: z.boolean(),
  }),
  pullRequests: z.object({
    ...series,
    // Weeks before this date are unknown because the listing was capped.
    coverageStart: z.string().nullable(),
    points: z.array(z.object({ week: z.string(), opened: count, merged: count, closed: count })),
    medianHoursToMerge: z.number().nullable(),
  }),
  issues: z.object({
    ...series,
    coverageStart: z.string().nullable(),
    points: z.array(z.object({ week: z.string(), opened: count, closed: count })),
    medianHoursToClose: z.number().nullable(),
  }),
  growth: z.object({
    ...series,
    stars: count,
    forks: count,
    openIssues: count,
    // Star counts at the moments sampled pages of stargazers were starred.
    starPoints: z.array(z.object({ at: z.string(), stars: z.number().int() })),
    sampled: z.boolean(),
  }),
});
export type ActivityFacts = z.infer<typeof activityFactsSchema>;
export const activitySchema = evolutionResponse(activityFactsSchema, z.never());
export type Activity = z.infer<typeof activitySchema>;

// ---- compare and dependencies -----------------------------------------------------------------------

export const SEMVER_CHANGES = ['major', 'minor', 'patch', 'other'] as const;

const dependencySchema = z.object({ name: z.string(), spec: z.string(), scope: z.string() });
export const manifestChangeSchema = z.object({
  path: z.string(),
  ecosystem: z.string(),
  added: z.array(dependencySchema),
  removed: z.array(dependencySchema),
  changed: z.array(
    z.object({
      name: z.string(),
      scope: z.string(),
      from: z.string(),
      to: z.string(),
      change: z.enum(SEMVER_CHANGES),
      direction: z.enum(['upgrade', 'downgrade', 'unknown']),
    }),
  ),
});
export type ManifestChange = z.infer<typeof manifestChangeSchema>;

export const dependencyChangesSchema = z.object({
  ...series,
  manifests: z.array(manifestChangeSchema),
  // Changed manifests that were not read, because of the per-request cap or a parse failure.
  skipped: z.array(z.string()),
});
export type DependencyChanges = z.infer<typeof dependencyChangesSchema>;

export const FILE_STATUSES = ['added', 'removed', 'modified', 'renamed', 'other'] as const;

export const compareFactsSchema = z.object({
  base: z.string(),
  head: z.string(),
  status: z.enum(['ahead', 'behind', 'identical', 'diverged']),
  aheadBy: z.number().int(),
  behindBy: z.number().int(),
  totalCommits: z.number().int(),
  commits: z.array(commitItemSchema),
  authors: z.number().int(),
  groups: z.record(z.enum(COMMIT_GROUPS), z.number().int()),
  files: z.object({
    total: z.number().int(),
    // GitHub lists at most 300 files per comparison.
    truncated: z.boolean(),
    additions: z.number().int(),
    deletions: z.number().int(),
    byStatus: z.record(z.enum(FILE_STATUSES), z.number().int()),
    top: z.array(
      z.object({
        path: z.string(),
        status: z.enum(FILE_STATUSES),
        additions: z.number().int(),
        deletions: z.number().int(),
      }),
    ),
    directories: z.array(
      z.object({
        path: z.string(),
        files: z.number().int(),
        additions: z.number().int(),
        deletions: z.number().int(),
      }),
    ),
  }),
  dependencies: dependencyChangesSchema,
});
export type CompareFacts = z.infer<typeof compareFactsSchema>;
export const compareSchema = evolutionResponse(compareFactsSchema, z.never());
export type Compare = z.infer<typeof compareSchema>;

export const dependenciesFactsSchema = z.object({
  base: z.string(),
  head: z.string(),
  changes: dependencyChangesSchema,
});
export const dependenciesSchema = evolutionResponse(dependenciesFactsSchema, z.never());

// ---- releases ------------------------------------------------------------------------------------

export const releasesFactsSchema = z.object({
  source: z.enum(['releases', 'tags']),
  releases: z.array(releaseItemSchema),
  inWindow: count,
  medianDaysBetween: z.number().nullable(),
});
export const releasesSchema = evolutionResponse(releasesFactsSchema, z.never());
export type Releases = z.infer<typeof releasesSchema>;

export const releaseSummaryRequestSchema = z
  .object({ tag: ref, base: ref.optional(), force: z.boolean().optional() })
  .strict();
export type ReleaseSummaryRequest = z.infer<typeof releaseSummaryRequestSchema>;

export const releaseSummaryFactsSchema = z.object({
  tag: z.string(),
  base: z.string().nullable(),
  publishedAt: z.string().nullable(),
  compare: compareFactsSchema.nullable(),
});
export const releaseSummarySchema = evolutionResponse(
  releaseSummaryFactsSchema,
  interpretationSchema,
).extend({
  id: z.string(),
  reused: z.boolean(),
  // Why there is no interpretation: no model configured, private content not allowed, and so on.
  interpretationNote: z.string().nullable(),
});
export type ReleaseSummary = z.infer<typeof releaseSummarySchema>;

// ---- languages -------------------------------------------------------------------------------------

export const languagesFactsSchema = z.object({
  points: z.array(
    z.object({
      at: z.string(),
      sha: z.string().nullable(),
      source: z.enum(['analysis', 'github']),
      // Analysis snapshots count lines; GitHub reports bytes. Shares make them comparable.
      unit: z.enum(['lines', 'bytes']),
      total: z.number().int().nonnegative(),
      shares: z.record(z.string(), z.number().min(0).max(1)),
    }),
  ),
  languages: z.array(z.string()),
});
export const languagesSchema = evolutionResponse(languagesFactsSchema, z.never());
export type Languages = z.infer<typeof languagesSchema>;

// ---- quality, regressions and snapshots ------------------------------------------------------------------

export const REGRESSION_KINDS = [
  'overall-drop',
  'area-drop',
  'findings-rise',
  'new-cycle',
  'new-layer-violation',
] as const;

export const regressionSchema = z.object({
  kind: z.enum(REGRESSION_KINDS),
  runId: z.string(),
  sha: z.string(),
  at: z.string(),
  area: z.enum(AREAS).nullable(),
  before: z.number(),
  after: z.number(),
  message: z.string(),
});
export type Regression = z.infer<typeof regressionSchema>;

export const qualityPointSchema = z.object({
  runId: z.string(),
  sha: z.string(),
  finishedAt: z.string(),
  overall: z.number().nullable(),
  confidence: z.number(),
  areas: z.record(z.enum(AREAS), z.number().nullable()),
  findings: z.object({
    total: count,
    // Only findings kept on the score carry a severity.
    bySeverity: z.record(z.enum(SEVERITIES), z.number().int()),
  }),
  debt: z.object({
    complexFunctions: count,
    averageCcn: z.number().nullable(),
    duplicationPercent: z.number().nullable(),
    vulnerabilities: count,
    cycles: count,
    layerViolations: count,
  }),
});
export type QualityPoint = z.infer<typeof qualityPointSchema>;

export const regressionThresholdsSchema = z.object({
  overallDrop: z.number(),
  areaDrop: z.number(),
  findingsRise: z.number(),
});

export const qualityFactsSchema = z.object({
  points: z.array(qualityPointSchema),
  regressions: z.array(regressionSchema),
  thresholds: regressionThresholdsSchema,
});
export const qualitySchema = evolutionResponse(qualityFactsSchema, z.never());
export type Quality = z.infer<typeof qualitySchema>;

export const snapshotCompareFactsSchema = z.object({
  a: qualityPointSchema,
  b: qualityPointSchema,
  delta: z.object({
    overall: z.number().nullable(),
    areas: z.record(z.enum(AREAS), z.number().nullable()),
  }),
  findings: z.object({
    introduced: z.array(findingSchema),
    resolved: z.array(findingSchema),
    introducedCount: z.number().int(),
    resolvedCount: z.number().int(),
  }),
  languages: z.object({
    a: z.record(z.string(), z.number()).nullable(),
    b: z.record(z.string(), z.number()).nullable(),
  }),
  regressions: z.array(regressionSchema),
});
export const snapshotCompareSchema = evolutionResponse(snapshotCompareFactsSchema, z.never());
export type SnapshotCompare = z.infer<typeof snapshotCompareSchema>;

// ---- architecture --------------------------------------------------------------------------------------

export const architectureEvolutionFactsSchema = z.object({
  snapshots: z.array(
    z.object({
      sha: z.string(),
      computedAt: z.string(),
      files: z.number().int(),
      imports: z.number().int(),
      cycles: z.number().int(),
      layerViolations: z.number().int(),
    }),
  ),
  changes: z.array(
    z.object({
      from: z.string(),
      to: z.string(),
      filesAdded: z.number().int(),
      filesRemoved: z.number().int(),
      modulesAdded: z.array(z.string()),
      modulesRemoved: z.array(z.string()),
      externalsAdded: z.array(z.string()),
      externalsRemoved: z.array(z.string()),
      cyclesIntroduced: z.number().int(),
      cyclesResolved: z.number().int(),
      violationsBefore: z.number().int(),
      violationsAfter: z.number().int(),
      layerChanges: z.number().int(),
    }),
  ),
});
export const architectureEvolutionSchema = evolutionResponse(
  architectureEvolutionFactsSchema,
  z.never(),
);
export type ArchitectureEvolution = z.infer<typeof architectureEvolutionSchema>;
