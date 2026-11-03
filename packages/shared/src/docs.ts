import { z } from 'zod';
import { citationSchema } from './chat.js';

export const DOC_KINDS = [
  'readme',
  'setup',
  'env',
  'api',
  'architecture',
  'database',
  'docstrings',
  'contributing',
  'troubleshooting',
  'sequence',
  'deployment',
  'changelog',
] as const;
export const docKindSchema = z.enum(DOC_KINDS);
export type DocKind = z.infer<typeof docKindSchema>;

/** Where each kind lands in the repository when proposed in a pull request. */
export const DOC_TARGETS: Record<DocKind, string> = {
  readme: 'README.md',
  setup: 'docs/SETUP.md',
  env: 'docs/CONFIGURATION.md',
  api: 'docs/API.md',
  architecture: 'docs/ARCHITECTURE.md',
  database: 'docs/DATABASE.md',
  docstrings: 'docs/DOCSTRING_SUGGESTIONS.md',
  contributing: 'CONTRIBUTING.md',
  troubleshooting: 'docs/TROUBLESHOOTING.md',
  sequence: 'docs/SEQUENCES.md',
  deployment: 'docs/DEPLOYMENT.md',
  changelog: 'CHANGELOG.md',
};

export const DOC_LABELS: Record<DocKind, string> = {
  readme: 'README',
  setup: 'Installation and setup',
  env: 'Environment variables',
  api: 'API reference',
  architecture: 'Architecture',
  database: 'Database schema',
  docstrings: 'Docstring suggestions',
  contributing: 'Contributing guide',
  troubleshooting: 'Troubleshooting',
  sequence: 'Sequence diagrams',
  deployment: 'Deployment guide',
  changelog: 'Changelog',
};

const ref = z.string().regex(/^[\w./-]{1,100}$/);

export const generateDocRequestSchema = z.object({
  kind: docKindSchema,
  // Generate again even when this commit already has a document of this kind.
  force: z.boolean().optional(),
  // Changelog only: the range to describe. Defaults to the latest tag up to the ingested commit.
  from: ref.optional(),
  to: ref.optional(),
});
export type GenerateDocRequest = z.infer<typeof generateDocRequestSchema>;

// facts: built only from repository data. prose: a model wrote explanations around the facts.
export const DOC_ORIGINS = ['facts', 'prose', 'edited'] as const;

export const docSectionSchema = z.object({
  id: z.string(),
  heading: z.string(),
  // Why a section is empty, when the repository had nothing to build it from.
  missing: z.string().nullable(),
  citations: z.array(citationSchema),
});
export type DocSection = z.infer<typeof docSectionSchema>;

export const generatedDocSchema = z.object({
  id: z.string(),
  fullName: z.string(),
  sha: z.string(),
  kind: docKindSchema,
  title: z.string(),
  targetPath: z.string(),
  // Markdown; citations are written as [[path:start-end]] and turned into links on export.
  content: z.string(),
  origin: z.enum(DOC_ORIGINS),
  sections: z.array(docSectionSchema),
  citations: z.array(citationSchema),
  // Citations the model wrote that did not match the material and were removed.
  droppedCitations: z.number().int().nonnegative(),
  model: z.string().nullable(),
  notes: z.array(z.string()),
  generatedAt: z.string(),
  editedAt: z.string().nullable(),
});
export type GeneratedDoc = z.infer<typeof generatedDocSchema>;

export const docListSchema = z.object({
  docs: z.array(generatedDocSchema.omit({ content: true, sections: true })),
});
export type DocList = z.infer<typeof docListSchema>;

export const updateDocRequestSchema = z.object({
  content: z.string().min(1).max(200_000),
  title: z.string().trim().min(1).max(200).optional(),
});
export type UpdateDocRequest = z.infer<typeof updateDocRequestSchema>;

export const DOC_EXPORT_FORMATS = ['markdown', 'html'] as const;
export const docExportQuerySchema = z.object({
  format: z.enum(DOC_EXPORT_FORMATS).default('markdown'),
  // relative: links work once the file is committed; github: links pinned to the commit.
  links: z.enum(['github', 'relative']).default('github'),
});

export const missingDocSchema = z.object({
  kind: z.enum(['document', 'symbol', 'route', 'env', 'script']),
  label: z.string(),
  path: z.string().nullable(),
  line: z.number().int().nullable(),
  // Which generator would fill the gap.
  suggest: docKindSchema.nullable(),
});
export const missingDocsSchema = z.object({
  fullName: z.string(),
  sha: z.string(),
  items: z.array(missingDocSchema),
  // Share of exported symbols that carry a doc comment, or null when none were found.
  symbolCoverage: z.number().min(0).max(1).nullable(),
});
export type MissingDocs = z.infer<typeof missingDocsSchema>;

export const reviewIssueSchema = z.object({
  rule: z.string(),
  severity: z.enum(['error', 'warning', 'info']),
  message: z.string(),
  // 1-based line in the document, when the issue points at one.
  line: z.number().int().nullable(),
  source: z.enum(['rule', 'model']),
});
export const docReviewSchema = z.object({
  docId: z.string(),
  // 0-100, or null when only rule checks ran and too little was measured to score.
  score: z.number().int().min(0).max(100).nullable(),
  scores: z.object({
    accuracy: z.number().int().min(0).max(5).nullable(),
    completeness: z.number().int().min(0).max(5).nullable(),
    clarity: z.number().int().min(0).max(5).nullable(),
  }),
  issues: z.array(reviewIssueSchema),
  summary: z.string().nullable(),
  model: z.string().nullable(),
});
export type DocReview = z.infer<typeof docReviewSchema>;

export const docDriftSchema = z.object({
  docId: z.string(),
  docSha: z.string(),
  // The newest ingested commit, or null when there is none to compare with.
  latestSha: z.string().nullable(),
  status: z.enum(['current', 'drifted', 'unknown']),
  changedFiles: z.array(z.string()),
  sections: z.array(
    z.object({ id: z.string(), heading: z.string(), changedSources: z.array(z.string()) }),
  ),
  commitsBehind: z.number().int().nonnegative().nullable(),
});
export type DocDrift = z.infer<typeof docDriftSchema>;

export const docPullRequestRequestSchema = z.object({
  docIds: z
    .array(z.string().regex(/^[0-9a-f]{24}$/i))
    .min(1)
    .max(12),
  // The exact paths the user confirmed; the request is refused when they differ from the docs.
  confirmPaths: z.array(z.string().min(1)).min(1).max(12),
  title: z.string().trim().min(5).max(120).optional(),
});
export type DocPullRequestRequest = z.infer<typeof docPullRequestRequestSchema>;

export const docPullRequestSchema = z.object({
  id: z.string(),
  fullName: z.string(),
  branch: z.string(),
  base: z.string(),
  number: z.number().int(),
  url: z.url(),
  draft: z.boolean(),
  files: z.array(z.string()),
  createdAt: z.string(),
});
export type DocPullRequest = z.infer<typeof docPullRequestSchema>;

export const docQuotaSchema = z.object({
  dailyLimit: z.number().int(),
  usedToday: z.number().int(),
  // Whether the stored token may write to public (or private) repositories.
  canProposePullRequests: z.boolean(),
});
export type DocQuota = z.infer<typeof docQuotaSchema>;
