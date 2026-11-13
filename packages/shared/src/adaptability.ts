import { z } from 'zod';
import { licenseInfoSchema, repoCardSchema } from './discovery.js';
import { interpretationSchema } from './evolution.js';

// ---- the user's stack ------------------------------------------------------------------------------

export const RUNTIMES = ['node', 'python', 'java', 'go'] as const;
export type Runtime = (typeof RUNTIMES)[number];

export const ECOSYSTEMS = ['npm', 'pypi', 'maven', 'go'] as const;
export const DB_ENGINES = ['postgresql', 'mysql', 'sqlite', 'mongodb', 'mssql'] as const;
export type DbEngine = (typeof DB_ENGINES)[number];
export const AUTH_APPROACHES = ['none', 'session', 'jwt', 'oauth', 'saml', 'hosted'] as const;
export type AuthApproach = (typeof AUTH_APPROACHES)[number];
export const OPERATING_SYSTEMS = ['linux', 'macos', 'windows'] as const;
export const DEPLOYMENTS = ['container', 'serverless', 'vm', 'paas'] as const;
export const INFRASTRUCTURE = [
  'docker',
  'redis',
  'queue',
  'object-storage',
  'smtp',
  'search',
] as const;
export type Infrastructure = (typeof INFRASTRUCTURE)[number];
export const LICENSE_USES = ['internal', 'saas', 'distributed'] as const;
export const COPYLEFT_LIMITS = ['none', 'weak', 'strong'] as const;

export const MAX_STACK_PROFILES = 5;

const version = z.string().regex(/^\d+(\.\d+){0,2}$/, 'Use a version such as 22 or 3.12.1');
const name = z.string().trim().min(1).max(80);

export const stackProfileInputSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    runtimes: z
      .object({
        node: version.optional(),
        python: version.optional(),
        java: version.optional(),
        go: version.optional(),
      })
      .strict()
      .default({}),
    frameworks: z
      .array(z.object({ name, version: version.optional() }))
      .max(10)
      .default([]),
    databases: z
      .array(z.object({ engine: z.enum(DB_ENGINES), version: version.optional() }))
      .max(5)
      .default([]),
    auth: z.enum(AUTH_APPROACHES).default('none'),
    os: z.array(z.enum(OPERATING_SYSTEMS)).min(1).default(['linux']),
    deployment: z.enum(DEPLOYMENTS).optional(),
    infrastructure: z.array(z.enum(INFRASTRUCTURE)).default([]),
    license: z
      .object({
        // How the code would be used: inside the company, behind a hosted service, or shipped.
        use: z.enum(LICENSE_USES),
        // The strongest copyleft the user is willing to comply with.
        copyleft: z.enum(COPYLEFT_LIMITS),
      })
      .default({ use: 'internal', copyleft: 'weak' }),
    // The user's own dependencies, usually pasted from a manifest. Exact versions or ranges.
    dependencies: z
      .array(z.object({ name, version: z.string().trim().max(60), ecosystem: z.enum(ECOSYSTEMS) }))
      .max(300)
      .default([]),
    requirements: z.string().trim().max(500).default(''),
  })
  .strict();
export type StackProfileInput = z.infer<typeof stackProfileInputSchema>;

export const stackProfileSchema = stackProfileInputSchema.extend({
  id: z.string(),
  updatedAt: z.string(),
});
export type StackProfile = z.infer<typeof stackProfileSchema>;
export const stackProfileListSchema = z.object({
  profiles: z.array(stackProfileSchema),
  limit: z.number().int(),
});

/** Turns a pasted package.json, requirements.txt, pyproject.toml, pom.xml or go.mod into profile fields. */
export const parseManifestRequestSchema = z
  .object({ filename: z.string().max(100), content: z.string().max(80_000) })
  .strict();
export const parsedManifestSchema = z.object({
  ecosystem: z.enum(ECOSYSTEMS),
  runtimes: stackProfileInputSchema.shape.runtimes.unwrap(),
  dependencies: stackProfileInputSchema.shape.dependencies.unwrap(),
});
export type ParsedManifest = z.infer<typeof parsedManifestSchema>;

export const evaluateRequestSchema = z.union([
  z.object({ profileId: z.string().regex(/^[0-9a-f]{24}$/i) }).strict(),
  z.object({ profile: stackProfileInputSchema }).strict(),
]);
export type EvaluateRequest = z.infer<typeof evaluateRequestSchema>;

// ---- the report ------------------------------------------------------------------------------------

export const EVIDENCE_SOURCES = ['file', 'graph', 'github', 'profile'] as const;

/** Where a statement comes from: a line in the repository, a detection, a GitHub fact or the profile. */
export const evidenceSchema = z.object({
  source: z.enum(EVIDENCE_SOURCES),
  path: z.string().nullable(),
  line: z.number().int().positive().nullable(),
  text: z.string(),
});
export type Evidence = z.infer<typeof evidenceSchema>;

export const DIMENSIONS = [
  'runtime',
  'framework',
  'dependencies',
  'license',
  'database',
  'auth',
  'services',
  'infrastructure',
  'os',
  'configuration',
] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export const DIMENSION_LABELS: Record<Dimension, string> = {
  runtime: 'Language and runtime',
  framework: 'Framework',
  dependencies: 'Dependencies',
  license: 'License',
  database: 'Database and migrations',
  auth: 'Authentication',
  services: 'External services',
  infrastructure: 'Infrastructure and deployment',
  os: 'Operating system',
  configuration: 'Configuration',
};

export const dimensionSchema = z.object({
  id: z.enum(DIMENSIONS),
  label: z.string(),
  // `unavailable` means nothing could be compared; it is left out of the overall score.
  status: z.enum(['measured', 'unavailable']),
  score: z.number().min(0).max(100).nullable(),
  weight: z.number().positive(),
  summary: z.string(),
  evidence: z.array(evidenceSchema),
});
export type DimensionResult = z.infer<typeof dimensionSchema>;

export const WARNING_SEVERITIES = ['blocker', 'major', 'minor', 'info'] as const;
export type WarningSeverity = (typeof WARNING_SEVERITIES)[number];

export const warningSchema = z.object({
  id: z.string(),
  dimension: z.enum(DIMENSIONS),
  severity: z.enum(WARNING_SEVERITIES),
  message: z.string(),
  // A warning without evidence is not allowed.
  evidence: z.array(evidenceSchema).min(1),
});
export type Warning = z.infer<typeof warningSchema>;

const hours = z.object({ low: z.number().nonnegative(), high: z.number().nonnegative() });

export const modificationSchema = z.object({
  id: z.string(),
  dimension: z.enum(DIMENSIONS),
  title: z.string(),
  detail: z.string(),
  hours,
  evidence: z.array(evidenceSchema),
});
export type Modification = z.infer<typeof modificationSchema>;

export const requirementsSchema = z.object({
  runtimes: z.array(
    z.object({
      runtime: z.enum(RUNTIMES),
      // What the manifest declares, or `*` when it names no version.
      range: z.string(),
      // True when the version comes from a pin (.nvmrc, a Docker image tag) rather than a declared range.
      pinned: z.boolean(),
      evidence: z.array(evidenceSchema),
    }),
  ),
  frameworks: z.array(
    z.object({
      name: z.string(),
      version: z.string().nullable(),
      evidence: z.array(evidenceSchema),
    }),
  ),
  dependencyCount: z.number().int().nonnegative(),
  envVars: z.array(
    z.object({
      name: z.string(),
      required: z.boolean(),
      description: z.string().nullable(),
      evidence: evidenceSchema,
    }),
  ),
  services: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      kind: z.enum(['database', 'infrastructure', 'saas']),
      evidence: z.array(evidenceSchema),
    }),
  ),
  database: z.object({
    engines: z.array(z.enum(DB_ENGINES)),
    orms: z.array(z.string()),
    models: z.number().int().nonnegative(),
    migrations: z.number().int().nonnegative(),
    evidence: z.array(evidenceSchema),
  }),
  auth: z.array(
    z.object({ approach: z.enum(AUTH_APPROACHES), label: z.string(), evidence: evidenceSchema }),
  ),
  license: licenseInfoSchema,
});
export type Requirements = z.infer<typeof requirementsSchema>;

export const RISK_LEVELS = ['low', 'medium', 'high'] as const;
export const VERDICTS = ['ready', 'adaptable', 'difficult', 'blocked'] as const;

export const adaptabilityFactsSchema = z.object({
  overall: z.object({
    // null when too little could be compared to put a number on it.
    score: z.number().min(0).max(100).nullable(),
    confidence: z.number().min(0).max(1),
    verdict: z.enum(VERDICTS).nullable(),
    formula: z.string(),
  }),
  dimensions: z.array(dimensionSchema),
  warnings: z.array(warningSchema),
  requirements: requirementsSchema,
  breakingRisk: z.object({
    level: z.enum(RISK_LEVELS),
    reasons: z.array(z.object({ text: z.string(), evidence: z.array(evidenceSchema) })),
  }),
  missingInfrastructure: z.array(
    z.object({ id: z.string(), label: z.string(), evidence: z.array(evidenceSchema) }),
  ),
  setupComplexity: z.object({ level: z.enum(RISK_LEVELS), factors: z.array(z.string()) }),
  effort: z.object({
    hours,
    basis: z.array(z.object({ text: z.string(), hours })),
    // Built from fixed hours per issue; it is a range to plan with, not a measurement.
    estimate: z.literal(true),
  }),
  modifications: z.array(modificationSchema),
  // Which stored inputs the evaluation could read.
  inputs: z.object({ ingestion: z.literal(true), graph: z.boolean() }),
});
export type AdaptabilityFacts = z.infer<typeof adaptabilityFactsSchema>;

export const checklistItemSchema = z.object({
  id: z.string(),
  dimension: z.enum(DIMENSIONS).nullable(),
  text: z.string(),
  done: z.boolean(),
});
export type ChecklistItem = z.infer<typeof checklistItemSchema>;

export const adaptabilityReportSchema = z.object({
  // null for an anonymous, unsaved evaluation.
  id: z.string().nullable(),
  fullName: z.string(),
  sha: z.string(),
  profile: stackProfileInputSchema,
  generatedAt: z.string(),
  notes: z.array(z.string()),
  facts: adaptabilityFactsSchema,
  checklist: z.array(checklistItemSchema),
  interpretation: interpretationSchema.nullable(),
  interpretationNote: z.string().nullable(),
});
export type AdaptabilityReport = z.infer<typeof adaptabilityReportSchema>;

export const checklistUpdateSchema = z
  .object({ done: z.array(z.string().max(80)).max(200) })
  .strict();

export const adaptabilityExportQuerySchema = z.object({
  format: z.enum(['markdown', 'html', 'json']).default('markdown'),
});

export const alternativeSchema = z.object({
  repo: repoCardSchema,
  similarity: z.number().min(0).max(1),
  // Why it fits the profile, each from a deterministic check.
  reasons: z.array(z.string()),
});
export const alternativesSchema = z.object({
  basis: z.object({ language: z.string().nullable(), topics: z.array(z.string()) }),
  items: z.array(alternativeSchema),
  // How many similar repositories were dropped for license or runtime reasons.
  filtered: z.number().int().nonnegative(),
});
export type Alternatives = z.infer<typeof alternativesSchema>;
