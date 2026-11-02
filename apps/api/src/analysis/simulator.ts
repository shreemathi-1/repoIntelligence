import {
  findingsDataSchema,
  inventoryDataSchema,
  lizardDataSchema,
  osvDataSchema,
  type Area,
  type Severity,
  type SimulateRequest,
  type SimulateResponse,
} from '@repointelligence/shared';
import type { AnalysisInputs } from './inputs.js';
import { computeHealth } from './scoring.js';

interface Edited {
  inputs: AnalysisInputs;
  resolved: number;
}

/**
 * Applies "what if" edits to a copy of the stored inputs: findings resolved, files added.
 * The same scoring code then runs on the copy, so the estimate uses the real formula.
 */
export function applySimulation(original: AnalysisInputs, request: SimulateRequest): Edited {
  const inputs = structuredClone(original);
  let resolved = 0;
  const rules = new Set(request.resolveRules.map((r) => `${r.tool}|${r.rule}`));
  const severities = new Set<Severity>(request.resolveSeverities);
  const drop = (tool: string, rule: string, severity: Severity): boolean =>
    rules.has(`${tool}|${rule}`) || severities.has(severity);

  for (const result of inputs.scan?.results ?? []) {
    if (result.status !== 'ok') continue;
    switch (result.tool) {
      case 'ruff':
      case 'semgrep':
      case 'gitleaks': {
        const parsed = findingsDataSchema.safeParse(result.data);
        if (!parsed.success) break;
        const kept = parsed.data.findings.filter((f) => !drop(result.tool, f.rule, f.severity));
        const removed = parsed.data.findings.length - kept.length;
        resolved += removed;
        result.data = {
          ...parsed.data,
          findings: kept,
          count: Math.max(0, parsed.data.count - removed),
        };
        break;
      }
      case 'osv': {
        const parsed = osvDataSchema.safeParse(result.data);
        if (!parsed.success) break;
        const kept = parsed.data.vulnerabilities.filter((v) => !drop('osv', v.id, v.severity));
        resolved += parsed.data.vulnerabilities.length - kept.length;
        result.data = { ...parsed.data, vulnerabilities: kept };
        break;
      }
      case 'lizard': {
        const parsed = lizardDataSchema.safeParse(result.data);
        if (!parsed.success) break;
        const kept = parsed.data.complexFunctions.filter(
          (f) => !drop('lizard', 'complexity', f.ccn > 30 ? 'medium' : 'low'),
        );
        resolved += parsed.data.complexFunctions.length - kept.length;
        result.data = { ...parsed.data, complexFunctions: kept };
        break;
      }
      case 'inventory': {
        if (request.addFiles.length === 0) break;
        const parsed = inventoryDataSchema.safeParse(result.data);
        if (!parsed.success) break;
        const data = parsed.data;
        for (const file of request.addFiles) {
          if (file === 'ci') data.ciWorkflows = [...data.ciWorkflows, 'simulated.yml'];
          else if (file === 'tests') {
            data.testFiles = Math.max(data.testFiles, Math.ceil(data.sourceFiles * 0.3));
            if (data.testFrameworks.length === 0) data.testFrameworks = ['simulated'];
          } else {
            data.communityFiles[file] = true;
            if (file === 'SECURITY') data.securityPolicy = true;
          }
        }
        result.data = data;
        break;
      }
      default:
        break;
    }
  }
  return { inputs, resolved };
}

export function simulate(
  original: AnalysisInputs,
  request: SimulateRequest,
  now: number = Date.now(),
): SimulateResponse {
  const before = computeHealth(original, now);
  const { inputs, resolved } = applySimulation(original, request);
  const after = computeHealth(inputs, now);
  const diff = (a: number | null, b: number | null): number | null =>
    a === null || b === null ? null : b - a;
  const areas = Object.fromEntries(
    before.areas.map((area) => [
      area.id,
      diff(area.score, after.areas.find((x) => x.id === area.id)?.score ?? null),
    ]),
  ) as Record<Area, number | null>;
  return {
    before,
    after,
    delta: { overall: diff(before.overall, after.overall), areas },
    findingsResolved: resolved,
    estimate: true,
  };
}
