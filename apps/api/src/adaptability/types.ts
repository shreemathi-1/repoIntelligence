import type {
  DimensionResult,
  Evidence,
  Modification,
  Requirements,
  StackProfileInput,
  Warning,
} from '@repointelligence/shared';
import type { Manifest } from '../ingest/types.js';

/** Facts the operating system and deployment checks need beyond the reported requirements. */
export interface RepoSignals {
  dockerfile: Evidence | null;
  compose: Evidence | null;
  /** package.json scripts that only run in a POSIX shell. */
  shellScripts: Evidence[];
  /** Shell scripts in the tree, with one example path. */
  shellFiles: Evidence | null;
  windowsFiles: number;
  nativePackages: Evidence[];
  /** `runs-on` values in the CI workflows, when any were read. */
  ciSystems: { systems: string[]; evidence: Evidence } | null;
  /** A long-running HTTP server, which does not drop into a serverless function unchanged. */
  server: Evidence | null;
  hasGraph: boolean;
}

export interface Detected {
  requirements: Requirements;
  signals: RepoSignals;
  manifests: Manifest[];
  /** Line of a dependency in its manifest, as evidence. */
  dependencyEvidence: (manifest: Manifest, name: string) => Evidence;
}

export interface BreakingReason {
  text: string;
  evidence: Evidence[];
}

export interface CheckResult {
  dimension: Omit<DimensionResult, 'label' | 'weight'>;
  warnings: Warning[];
  modifications: Modification[];
  breaking?: BreakingReason[];
  missingInfrastructure?: { id: string; label: string; evidence: Evidence[] }[];
}

export type Check = (detected: Detected, profile: StackProfileInput) => CheckResult;

export const profileEvidence = (text: string): Evidence => ({
  source: 'profile',
  path: null,
  line: null,
  text,
});

export function unavailable(id: DimensionResult['id'], summary: string): CheckResult {
  return {
    dimension: { id, status: 'unavailable', score: null, summary, evidence: [] },
    warnings: [],
    modifications: [],
  };
}
