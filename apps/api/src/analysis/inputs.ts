import { z } from 'zod';
import {
  findingsDataSchema,
  inventoryDataSchema,
  jscpdDataSchema,
  lizardDataSchema,
  osvDataSchema,
  scanResponseSchema,
  type ScanResult,
} from '@repointelligence/shared';

/** Facts gathered from the GitHub API about the repository, independent of its files. */
export const githubSignalsSchema = z.object({
  archived: z.boolean(),
  pushedAt: z.string().nullable(),
  commitsLast90Days: z.number().int().nonnegative().nullable(),
  releasesLastYear: z.number().int().nonnegative().nullable(),
  // From the contributors endpoint: how many people, and each one's share of commits.
  contributors: z.number().int().nonnegative().nullable(),
  topContributorShare: z.number().min(0).max(1).nullable(),
  maintainersOver10Percent: z.number().int().nonnegative().nullable(),
  // Median hours between an issue being opened and its first comment, over recent issues.
  medianFirstResponseHours: z.number().nonnegative().nullable(),
  issuesSampled: z.number().int().nonnegative(),
  // Conclusions of the check runs on the analysed commit. Empty when none ran.
  checkRuns: z.array(z.string()).nullable(),
});
export type GithubSignals = z.infer<typeof githubSignalsSchema>;

/** What the architecture area needs from a stored graph, when one exists for the commit. */
export const architectureSignalsSchema = z.object({
  files: z.number().int().nonnegative(),
  cycles: z.number().int().nonnegative(),
  filesInCycles: z.number().int().nonnegative(),
  layerViolations: z.number().int().nonnegative(),
  internalImports: z.number().int().nonnegative(),
  // Share of internal imports that land on the single most imported file.
  topFanInShare: z.number().min(0).max(1).nullable(),
  // How much of the code sits in a recognised layer (not 'other').
  layeredShare: z.number().min(0).max(1),
});
export type ArchitectureSignals = z.infer<typeof architectureSignalsSchema>;

/** Everything the scoring formula reads. Stored on the run so the simulator can edit a copy. */
export const analysisInputsSchema = z.object({
  scan: scanResponseSchema.nullable(),
  // Why there is no scan: worker not configured, archive too large, and so on.
  scanUnavailableReason: z.string().nullable(),
  signals: githubSignalsSchema.nullable(),
  // Total source lines, from the inventory, so densities can be computed.
  sourceLines: z.number().int().nonnegative().nullable(),
  // Present when an architecture graph was built for the same file tree.
  architecture: architectureSignalsSchema.nullable().optional(),
});
export type AnalysisInputs = z.infer<typeof analysisInputsSchema>;

interface ToolData {
  inventory: z.infer<typeof inventoryDataSchema>;
  lizard: z.infer<typeof lizardDataSchema>;
  jscpd: z.infer<typeof jscpdDataSchema>;
  ruff: z.infer<typeof findingsDataSchema>;
  semgrep: z.infer<typeof findingsDataSchema>;
  gitleaks: z.infer<typeof findingsDataSchema>;
  osv: z.infer<typeof osvDataSchema>;
}

const TOOL_SCHEMAS: { [K in keyof ToolData]: z.ZodType<ToolData[K]> } = {
  inventory: inventoryDataSchema,
  lizard: lizardDataSchema,
  jscpd: jscpdDataSchema,
  ruff: findingsDataSchema,
  semgrep: findingsDataSchema,
  gitleaks: findingsDataSchema,
  osv: osvDataSchema,
};

export type ToolOutcome<K extends keyof ToolData> =
  | { status: 'ok'; data: ToolData[K]; version: string | null }
  | {
      status: 'unavailable' | 'failed' | 'timeout' | 'missing';
      reason: string;
      version: string | null;
    };

/** The validated output of one tool, or why there is none. Malformed output counts as failed. */
export function toolOutcome<K extends keyof ToolData>(
  inputs: AnalysisInputs,
  tool: K,
): ToolOutcome<K> {
  if (!inputs.scan) {
    return {
      status: 'missing',
      reason: inputs.scanUnavailableReason ?? 'no scan was run',
      version: null,
    };
  }
  const result: ScanResult | undefined = inputs.scan.results.find((r) => r.tool === tool);
  if (!result) return { status: 'missing', reason: `${tool} was not requested`, version: null };
  if (result.status !== 'ok') {
    return {
      status: result.status,
      reason: result.reason ?? result.status,
      version: result.version,
    };
  }
  const parsed = TOOL_SCHEMAS[tool].safeParse(result.data);
  if (!parsed.success) {
    return {
      status: 'failed',
      reason: `${tool} returned an unexpected shape`,
      version: result.version,
    };
  }
  return { status: 'ok', data: parsed.data, version: result.version };
}
