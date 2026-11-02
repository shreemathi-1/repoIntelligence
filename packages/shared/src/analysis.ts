import { z } from 'zod';

// ---- scanner output (worker -> api) --------------------------------------------------------

export const SCANNER_TOOLS = [
  'inventory',
  'lizard',
  'jscpd',
  'ruff',
  'semgrep',
  'gitleaks',
  'osv',
] as const;
export type ScannerTool = (typeof SCANNER_TOOLS)[number];

export const SCAN_STATUSES = ['ok', 'unavailable', 'failed', 'timeout'] as const;

export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
export type Severity = (typeof SEVERITIES)[number];

/** One finding from any tool. Secrets are never included, only where one was found. */
export const findingSchema = z.object({
  tool: z.enum(SCANNER_TOOLS),
  rule: z.string(),
  severity: z.enum(SEVERITIES),
  message: z.string(),
  path: z.string(),
  line: z.number().int().nonnegative().nullable(),
});
export type Finding = z.infer<typeof findingSchema>;

export const complexityFunctionSchema = z.object({
  name: z.string(),
  path: z.string(),
  line: z.number().int().nonnegative(),
  ccn: z.number().int().nonnegative(),
  nloc: z.number().int().nonnegative(),
  parameters: z.number().int().nonnegative(),
});

export const lizardDataSchema = z.object({
  filesAnalysed: z.number().int().nonnegative(),
  nloc: z.number().int().nonnegative(),
  functionCount: z.number().int().nonnegative(),
  averageCcn: z.number().nonnegative().nullable(),
  // Functions with a cyclomatic complexity above 15, the usual "hard to test" line.
  complexFunctions: z.array(complexityFunctionSchema),
});

export const jscpdDataSchema = z.object({
  totalLines: z.number().int().nonnegative(),
  duplicatedLines: z.number().int().nonnegative(),
  duplicationPercent: z.number().nonnegative(),
  cloneCount: z.number().int().nonnegative(),
});

export const findingsDataSchema = z.object({
  filesChecked: z.number().int().nonnegative().nullable(),
  findings: z.array(findingSchema),
  // Set when the list was cut to keep the payload small; `count` is still the full number.
  count: z.number().int().nonnegative(),
});

export const vulnerabilitySchema = z.object({
  id: z.string(),
  package: z.string(),
  ecosystem: z.string(),
  version: z.string(),
  severity: z.enum(SEVERITIES),
  fixedIn: z.string().nullable(),
});

export const osvDataSchema = z.object({
  lockfilesScanned: z.array(z.string()),
  packagesScanned: z.number().int().nonnegative(),
  vulnerabilities: z.array(vulnerabilitySchema),
});

/** Deterministic facts about the files in the archive. Always available. */
export const inventoryDataSchema = z.object({
  files: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  linesByLanguage: z.record(z.string(), z.number().int().nonnegative()),
  sourceFiles: z.number().int().nonnegative(),
  testFiles: z.number().int().nonnegative(),
  testFrameworks: z.array(z.string()),
  coverageConfig: z.boolean(),
  ciWorkflows: z.array(z.string()),
  lockfiles: z.array(z.string()),
  manifests: z.array(z.string()),
  // Each key is a community file; true when some variant of it exists.
  communityFiles: z.record(z.string(), z.boolean()),
  readmeLines: z.number().int().nonnegative().nullable(),
  readmeHasInstall: z.boolean().nullable(),
  readmeHasUsage: z.boolean().nullable(),
  readmeHasCodeBlocks: z.boolean().nullable(),
  apiDocs: z.boolean(),
  dockerfile: z.boolean(),
  linterConfig: z.array(z.string()),
  formatterConfig: z.array(z.string()),
  typeChecking: z.boolean(),
  preCommitHooks: z.boolean(),
  securityPolicy: z.boolean(),
  dependabotOrRenovate: z.boolean(),
  codeowners: z.boolean(),
});

export const scanResultSchema = z.object({
  tool: z.enum(SCANNER_TOOLS),
  status: z.enum(SCAN_STATUSES),
  version: z.string().nullable(),
  // Why the tool produced nothing: not installed, timed out, crashed, nothing to scan.
  reason: z.string().nullable(),
  durationMs: z.number().int().nonnegative(),
  data: z.unknown().nullable(),
});
export type ScanResult = z.infer<typeof scanResultSchema>;

export const scanResponseSchema = z.object({
  archiveFiles: z.number().int().nonnegative(),
  archiveBytes: z.number().int().nonnegative(),
  results: z.array(scanResultSchema),
});
export type ScanResponse = z.infer<typeof scanResponseSchema>;

export const scannerInfoSchema = z.object({
  tool: z.enum(SCANNER_TOOLS),
  available: z.boolean(),
  version: z.string().nullable(),
});
export const scannersResponseSchema = z.object({ scanners: z.array(scannerInfoSchema) });

// ---- metrics and scores ----------------------------------------------------------------------

export const METRIC_STATUSES = ['measured', 'inferred', 'unavailable'] as const;
export type MetricStatus = (typeof METRIC_STATUSES)[number];

export const AREAS = [
  'codeQuality',
  'security',
  'tests',
  'maintainability',
  'documentation',
  'dependencies',
  'architecture',
  'community',
  'activity',
  'cicd',
  'busFactor',
] as const;
export type Area = (typeof AREAS)[number];

export const metricSchema = z.object({
  id: z.string(),
  label: z.string(),
  status: z.enum(METRIC_STATUSES),
  // The raw observation, in `unit`. null when unavailable.
  value: z.number().nullable(),
  unit: z.string().nullable(),
  // 0 to 100, null when unavailable. Missing data is never scored as zero.
  score: z.number().min(0).max(100).nullable(),
  weight: z.number().positive(),
  // Where the number came from, or why there is none.
  evidence: z.string(),
  source: z.string(),
});
export type Metric = z.infer<typeof metricSchema>;

export const areaScoreSchema = z.object({
  id: z.enum(AREAS),
  label: z.string(),
  weight: z.number().positive(),
  score: z.number().min(0).max(100).nullable(),
  // Share of this area's metric weight that was measured or inferred.
  confidence: z.number().min(0).max(1),
  metrics: z.array(metricSchema),
});
export type AreaScore = z.infer<typeof areaScoreSchema>;

export const healthScoreSchema = z.object({
  // null when too little was observed to put a number on the whole repository.
  overall: z.number().min(0).max(100).nullable(),
  status: z.enum(['scored', 'insufficient-data']),
  confidence: z.number().min(0).max(1),
  observedWeight: z.number().nonnegative(),
  totalWeight: z.number().positive(),
  formula: z.string(),
  weights: z.record(z.enum(AREAS), z.number().positive()),
  areas: z.array(areaScoreSchema),
  findings: z.array(findingSchema),
  // Findings beyond what is stored on the score, by tool.
  findingsTruncated: z.record(z.string(), z.number().int().nonnegative()),
});
export type HealthScore = z.infer<typeof healthScoreSchema>;

// ---- analysis runs ---------------------------------------------------------------------------

export const ANALYSIS_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export const ANALYSIS_STEPS = [
  'queued',
  'fetching',
  'scanning',
  'collecting',
  'scoring',
  'done',
] as const;

export const analysisProgressSchema = z.object({
  step: z.enum(ANALYSIS_STEPS),
  // 0 to 100 across the whole run.
  percent: z.number().min(0).max(100),
  message: z.string(),
});

export const analysisRunSchema = z.object({
  id: z.string(),
  fullName: z.string(),
  sha: z.string().nullable(),
  status: z.enum(ANALYSIS_STATUSES),
  progress: analysisProgressSchema,
  attempt: z.number().int().nonnegative(),
  error: z.string().nullable(),
  // True when an earlier run for the same commit was returned instead of queuing a new one.
  reused: z.boolean(),
  queuedAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  score: healthScoreSchema.nullable(),
});
export type AnalysisRun = z.infer<typeof analysisRunSchema>;

export const analyzeRequestSchema = z.object({
  ref: z
    .string()
    .regex(/^[\w./-]{1,100}$/)
    .optional(),
  force: z.boolean().optional(),
});

export const healthHistoryItemSchema = z.object({
  runId: z.string(),
  sha: z.string(),
  finishedAt: z.string(),
  overall: z.number().nullable(),
  confidence: z.number(),
  areas: z.record(z.enum(AREAS), z.number().nullable()),
});
export const healthHistorySchema = z.object({ items: z.array(healthHistoryItemSchema) });
export type HealthHistoryItem = z.infer<typeof healthHistoryItemSchema>;

export const simulateRequestSchema = z
  .object({
    // Resolve every finding of these tools and rules, e.g. { tool: 'ruff', rule: 'E501' }.
    resolveRules: z
      .array(z.object({ tool: z.enum(SCANNER_TOOLS), rule: z.string() }))
      .max(100)
      .default([]),
    // Resolve every finding at these severities.
    resolveSeverities: z.array(z.enum(SEVERITIES)).default([]),
    // Pretend these inventory facts became true (e.g. add a CONTRIBUTING file).
    addFiles: z
      .array(
        z.enum([
          'CONTRIBUTING',
          'CODE_OF_CONDUCT',
          'SECURITY',
          'CHANGELOG',
          'LICENSE',
          'ci',
          'tests',
        ]),
      )
      .default([]),
  })
  .strict();
export type SimulateRequest = z.infer<typeof simulateRequestSchema>;

export const simulateResponseSchema = z.object({
  before: healthScoreSchema,
  after: healthScoreSchema,
  // Overall and per-area change. null when either side has no number.
  delta: z.object({
    overall: z.number().nullable(),
    areas: z.record(z.enum(AREAS), z.number().nullable()),
  }),
  findingsResolved: z.number().int().nonnegative(),
  // The simulator applies the same formula to edited inputs; it is an estimate.
  estimate: z.literal(true),
});
export type SimulateResponse = z.infer<typeof simulateResponseSchema>;

export const quotaSchema = z.object({
  dailyLimit: z.number().int(),
  usedToday: z.number().int(),
  running: z.number().int(),
  maxRunning: z.number().int(),
});
