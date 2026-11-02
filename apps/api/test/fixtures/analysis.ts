import type { ScanResponse, ScanResult } from '@repointelligence/shared';
import type { AnalysisInputs, GithubSignals } from '../../src/analysis/inputs.js';

export const NOW = Date.parse('2026-03-31T00:00:00Z');
const daysAgo = (d: number): string => new Date(NOW - d * 86_400_000).toISOString();

export const inventory = (over: Record<string, unknown> = {}) => ({
  files: 40,
  bytes: 120_000,
  linesByLanguage: { Python: 4000, TypeScript: 1000 },
  sourceFiles: 30,
  testFiles: 10,
  testFrameworks: ['pytest'],
  coverageConfig: true,
  ciWorkflows: ['ci.yml'],
  lockfiles: ['poetry.lock'],
  manifests: ['pyproject.toml'],
  communityFiles: {
    README: true,
    LICENSE: true,
    CONTRIBUTING: true,
    CODE_OF_CONDUCT: true,
    SECURITY: true,
    CHANGELOG: true,
  },
  readmeLines: 120,
  readmeHasInstall: true,
  readmeHasUsage: true,
  readmeHasCodeBlocks: true,
  apiDocs: true,
  dockerfile: true,
  linterConfig: ['ruff'],
  formatterConfig: ['black'],
  typeChecking: true,
  preCommitHooks: true,
  securityPolicy: true,
  dependabotOrRenovate: true,
  codeowners: true,
  ...over,
});

export const ok = (tool: ScanResult['tool'], data: unknown): ScanResult => ({
  tool,
  status: 'ok',
  version: '1.0',
  reason: null,
  durationMs: 10,
  data,
});
export const missing = (
  tool: ScanResult['tool'],
  reason = `${tool} is not installed`,
): ScanResult => ({
  tool,
  status: 'unavailable',
  version: null,
  reason,
  durationMs: 0,
  data: null,
});

/** A well-kept project: every tool ran and found nothing worrying. */
export function healthyScan(): ScanResponse {
  return {
    archiveFiles: 40,
    archiveBytes: 120_000,
    results: [
      ok('inventory', inventory()),
      ok('lizard', {
        filesAnalysed: 20,
        nloc: 3000,
        functionCount: 200,
        averageCcn: 2.5,
        complexFunctions: [],
      }),
      ok('jscpd', { totalLines: 5000, duplicatedLines: 50, duplicationPercent: 1, cloneCount: 2 }),
      ok('ruff', { filesChecked: 20, findings: [], count: 0 }),
      ok('semgrep', { filesChecked: 30, findings: [], count: 0 }),
      ok('gitleaks', { filesChecked: null, findings: [], count: 0 }),
      ok('osv', { lockfilesScanned: ['poetry.lock'], packagesScanned: 80, vulnerabilities: [] }),
    ],
  };
}

export function healthySignals(): GithubSignals {
  return {
    archived: false,
    pushedAt: daysAgo(2),
    commitsLast90Days: 60,
    releasesLastYear: 6,
    contributors: 25,
    topContributorShare: 0.3,
    maintainersOver10Percent: 3,
    medianFirstResponseHours: 10,
    issuesSampled: 20,
    checkRuns: ['success', 'success'],
  };
}

export function healthyInputs(): AnalysisInputs {
  return {
    scan: healthyScan(),
    scanUnavailableReason: null,
    signals: healthySignals(),
    sourceLines: 5000,
  };
}

/** A project in trouble: secrets, vulnerabilities, complexity, no docs, one maintainer. */
export function troubledInputs(): AnalysisInputs {
  const finding = (
    tool: 'ruff' | 'semgrep' | 'gitleaks',
    rule: string,
    severity: ScanResult['tool'] extends never ? never : 'critical' | 'high' | 'medium' | 'low',
    n: number,
  ) =>
    Array.from({ length: n }, (_, i) => ({
      tool,
      rule,
      severity,
      message: `${rule} #${i}`,
      path: 'src/a.py',
      line: i + 1,
    }));
  return {
    scan: {
      archiveFiles: 10,
      archiveBytes: 1000,
      results: [
        ok(
          'inventory',
          inventory({
            testFiles: 0,
            testFrameworks: [],
            ciWorkflows: [],
            lockfiles: [],
            readmeLines: null,
            readmeHasInstall: null,
            readmeHasUsage: null,
            readmeHasCodeBlocks: null,
            communityFiles: {
              README: false,
              LICENSE: false,
              CONTRIBUTING: false,
              CODE_OF_CONDUCT: false,
              SECURITY: false,
              CHANGELOG: false,
            },
            linterConfig: [],
            formatterConfig: [],
            typeChecking: false,
            preCommitHooks: false,
            securityPolicy: false,
            dependabotOrRenovate: false,
            codeowners: false,
            apiDocs: false,
          }),
        ),
        ok('lizard', {
          filesAnalysed: 5,
          nloc: 4000,
          functionCount: 40,
          averageCcn: 14,
          complexFunctions: Array.from({ length: 8 }, (_, i) => ({
            name: `f${i}`,
            path: 'src/a.py',
            line: i,
            ccn: 20 + i * 3,
            nloc: 100,
            parameters: 4,
          })),
        }),
        ok('jscpd', {
          totalLines: 5000,
          duplicatedLines: 1200,
          duplicationPercent: 24,
          cloneCount: 40,
        }),
        ok('ruff', {
          filesChecked: 5,
          findings: [
            ...finding('ruff', 'E501', 'low', 150),
            ...finding('ruff', 'S605', 'medium', 3),
          ],
          count: 153,
        }),
        ok('semgrep', {
          filesChecked: 5,
          findings: finding('semgrep', 'sqli', 'high', 8),
          count: 8,
        }),
        ok('gitleaks', {
          filesChecked: null,
          findings: finding('gitleaks', 'aws-key', 'critical', 2),
          count: 2,
        }),
        ok('osv', {
          lockfilesScanned: ['requirements.txt'],
          packagesScanned: 30,
          vulnerabilities: [
            {
              id: 'GHSA-1',
              package: 'requests',
              ecosystem: 'PyPI',
              version: '2.0',
              severity: 'critical',
              fixedIn: '2.32',
            },
            {
              id: 'GHSA-2',
              package: 'flask',
              ecosystem: 'PyPI',
              version: '1.0',
              severity: 'high',
              fixedIn: null,
            },
          ],
        }),
      ],
    },
    scanUnavailableReason: null,
    signals: {
      archived: false,
      pushedAt: daysAgo(300),
      commitsLast90Days: 1,
      releasesLastYear: 0,
      contributors: 1,
      topContributorShare: 1,
      maintainersOver10Percent: 1,
      medianFirstResponseHours: 24 * 30,
      issuesSampled: 5,
      checkRuns: [],
    },
    sourceLines: 5000,
  };
}

/** The same inputs with one tool's result swapped out. */
export function withTool(inputs: AnalysisInputs, result: ScanResult): AnalysisInputs {
  if (!inputs.scan) throw new Error('fixture has no scan');
  return {
    ...inputs,
    scan: {
      ...inputs.scan,
      results: inputs.scan.results.map((r) => (r.tool === result.tool ? result : r)),
    },
  };
}

/** A findings tool's data from the fixture, for tests that edit it. */
export function toolData(
  inputs: AnalysisInputs,
  tool: 'ruff' | 'semgrep' | 'gitleaks',
): { findings: unknown[]; count: number } {
  const result = inputs.scan?.results.find((r) => r.tool === tool);
  if (!result) throw new Error(`fixture has no ${tool} result`);
  return result.data as { findings: unknown[]; count: number };
}
