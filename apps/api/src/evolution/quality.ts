import {
  AREAS,
  SEVERITIES,
  type Area,
  type ArchitectureGraph,
  type Finding,
  type HealthScore,
  type QualityPoint,
  type Regression,
  type Severity,
} from '@repointelligence/shared';
import { toolOutcome, type AnalysisInputs } from '../analysis/inputs.js';
import { diffGraphs } from '../graph/diff.js';

/** Fixed thresholds; a change at or beyond these counts as a regression. */
export const REGRESSION_THRESHOLDS = {
  // Points on the 0 to 100 scale.
  overallDrop: 10,
  areaDrop: 10,
  // Share of the previous finding count.
  findingsRise: 0.2,
} as const;

const MAX_FINDINGS_LISTED = 50;
const MAX_LANGUAGES = 8;

export interface StoredRun {
  id: string;
  sha: string;
  finishedAt: Date;
  score: HealthScore;
  inputs: AnalysisInputs | null;
}

export function qualityPoint(run: StoredRun): QualityPoint {
  const { score, inputs } = run;
  const bySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>;
  for (const f of score.findings) bySeverity[f.severity] += 1;
  const truncated = Object.values(score.findingsTruncated).reduce((a, b) => a + b, 0);
  const lizard = inputs ? toolOutcome(inputs, 'lizard') : null;
  const jscpd = inputs ? toolOutcome(inputs, 'jscpd') : null;
  const osv = inputs ? toolOutcome(inputs, 'osv') : null;
  const arch = inputs?.architecture ?? null;
  return {
    runId: run.id,
    sha: run.sha,
    finishedAt: run.finishedAt.toISOString(),
    overall: score.overall,
    confidence: score.confidence,
    areas: Object.fromEntries(AREAS.map((a) => [a, score.areas.find((x) => x.id === a)?.score ?? null])) as Record<Area, number | null>,
    // Without a scan the finding count is unknown, not zero.
    findings: { total: inputs?.scan ? score.findings.length + truncated : null, bySeverity },
    debt: {
      complexFunctions: lizard?.status === 'ok' ? lizard.data.complexFunctions.length : null,
      averageCcn: lizard?.status === 'ok' ? lizard.data.averageCcn : null,
      duplicationPercent: jscpd?.status === 'ok' ? jscpd.data.duplicationPercent : null,
      vulnerabilities: osv?.status === 'ok' ? osv.data.vulnerabilities.length : null,
      cycles: arch ? arch.cycles : null,
      layerViolations: arch ? arch.layerViolations : null,
    },
  };
} // prettier-ignore

/** Regressions from `before` to `after`. Only measured values on both sides are compared. */
export function regressionsBetween(before: QualityPoint, after: QualityPoint): Regression[] {
  const t = REGRESSION_THRESHOLDS;
  const at = { runId: after.runId, sha: after.sha, at: after.finishedAt };
  const out: Regression[] = [];
  if (before.overall !== null && after.overall !== null && before.overall - after.overall >= t.overallDrop) {
    out.push({ kind: 'overall-drop', ...at, area: null, before: before.overall, after: after.overall, message: `Overall score fell from ${before.overall} to ${after.overall}` });
  }
  for (const area of AREAS) {
    const x = before.areas[area];
    const y = after.areas[area];
    if (x !== null && y !== null && x - y >= t.areaDrop) {
      out.push({ kind: 'area-drop', ...at, area, before: x, after: y, message: `${area} fell from ${x} to ${y}` });
    }
  }
  const fx = before.findings.total;
  const fy = after.findings.total;
  if (fx !== null && fy !== null && fy > fx && (fy - fx) / Math.max(fx, 1) >= t.findingsRise) {
    out.push({ kind: 'findings-rise', ...at, area: null, before: fx, after: fy, message: `Findings rose from ${fx} to ${fy}` });
  }
  const cx = before.debt.cycles;
  const cy = after.debt.cycles;
  if (cx !== null && cy !== null && cy > cx) {
    out.push({ kind: 'new-cycle', ...at, area: null, before: cx, after: cy, message: `Import cycles rose from ${cx} to ${cy}` });
  }
  const vx = before.debt.layerViolations;
  const vy = after.debt.layerViolations;
  if (vx !== null && vy !== null && vy > vx) {
    out.push({ kind: 'new-layer-violation', ...at, area: null, before: vx, after: vy, message: `Layer violations rose from ${vx} to ${vy}` });
  }
  return out;
} // prettier-ignore

/** Regressions along a history, oldest first. */
export function regressions(points: QualityPoint[]): Regression[] {
  return points.slice(1).flatMap((p, i) => {
    const previous = points[i];
    return previous ? regressionsBetween(previous, p) : [];
  });
}

const findingKey = (f: Finding) => `${f.tool}|${f.rule}|${f.path}`;

/** Findings present on one side only, matched by tool, rule and file so moved lines still match. */
export function findingChanges(before: Finding[], after: Finding[]) {
  const onlyIn = (from: Finding[], other: Finding[]) => {
    const left = new Map<string, number>();
    for (const f of other) left.set(findingKey(f), (left.get(findingKey(f)) ?? 0) + 1);
    return from.filter((f) => {
      const n = left.get(findingKey(f)) ?? 0;
      if (n > 0) left.set(findingKey(f), n - 1);
      return n === 0;
    });
  };
  const introduced = onlyIn(after, before);
  const resolved = onlyIn(before, after);
  return {
    introduced: introduced.slice(0, MAX_FINDINGS_LISTED),
    resolved: resolved.slice(0, MAX_FINDINGS_LISTED),
    introducedCount: introduced.length,
    resolvedCount: resolved.length,
  };
}

export function scoreDelta(a: QualityPoint, b: QualityPoint) {
  const diff = (x: number | null | undefined, y: number | null | undefined) =>
    x === null || x === undefined || y === null || y === undefined ? null : y - x;
  return {
    overall: diff(a.overall, b.overall),
    areas: Object.fromEntries(AREAS.map((area) => [area, diff(a.areas[area], b.areas[area])])) as Record<Area, number | null>,
  };
} // prettier-ignore

// ---- languages -------------------------------------------------------------------------------------

/** Lines per language from a run's inventory, or null when the inventory did not run. */
export function linesByLanguage(inputs: AnalysisInputs | null): Record<string, number> | null {
  if (!inputs) return null;
  const inventory = toolOutcome(inputs, 'inventory');
  return inventory.status === 'ok' ? inventory.data.linesByLanguage : null;
}

export function shares(counts: Record<string, number>): Record<string, number> {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total === 0) return {};
  return Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, Math.round((v / total) * 1000) / 1000]));
} // prettier-ignore

export interface LanguagePoint {
  at: string;
  sha: string | null;
  source: 'analysis' | 'github';
  unit: 'lines' | 'bytes';
  counts: Record<string, number>;
}

/**
 * Language shares over time. Names are matched without case so both sources share one series;
 * languages outside the largest few are folded into `Other`.
 */
export function languageHistory(points: LanguagePoint[]) {
  const canonical = new Map<string, string>();
  const name = (n: string) => {
    const key = n.toLowerCase();
    if (!canonical.has(key)) canonical.set(key, n);
    return canonical.get(key) ?? n;
  };
  const normalised = points.map((p) => {
    const counts: Record<string, number> = {};
    for (const [k, v] of Object.entries(p.counts)) counts[name(k)] = (counts[name(k)] ?? 0) + v;
    return { ...p, counts, shares: shares(counts) };
  });
  const peak = new Map<string, number>();
  for (const p of normalised) for (const [k, v] of Object.entries(p.shares)) peak.set(k, Math.max(peak.get(k) ?? 0, v));
  const top = [...peak.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_LANGUAGES).map(([k]) => k);
  const folded = normalised.map((p) => {
    const kept = Object.fromEntries(top.filter((k) => k in p.shares).map((k) => [k, p.shares[k] ?? 0]));
    const other = Math.round((1 - Object.values(kept).reduce((a, b) => a + b, 0)) * 1000) / 1000;
    return {
      at: p.at,
      sha: p.sha,
      source: p.source,
      unit: p.unit,
      total: Object.values(p.counts).reduce((a, b) => a + b, 0),
      shares: other > 0.001 ? { ...kept, Other: other } : kept,
    };
  });
  const hasOther = folded.some((p) => 'Other' in p.shares);
  return { points: folded, languages: hasOther ? [...top, 'Other'] : top };
} // prettier-ignore

// ---- architecture -------------------------------------------------------------------------------------

export interface StoredGraph {
  sha: string;
  computedAt: Date;
  graph: ArchitectureGraph;
}

/** Size and structure of each stored graph, and what changed between neighbours. Oldest first. */
export function architectureHistory(graphs: StoredGraph[]) {
  const snapshots = graphs.map((g) => ({
    sha: g.sha,
    computedAt: g.computedAt.toISOString(),
    files: g.graph.files.length,
    imports: g.graph.imports.filter((e) => e.to).length,
    cycles: g.graph.cycles.length,
    layerViolations: g.graph.layerViolations.length,
  }));
  const changes = graphs.slice(1).flatMap((after, i) => {
    const before = graphs[i];
    if (!before) return [];
    const d = diffGraphs(before.graph, after.graph, { from: before.sha, to: after.sha });
    return [
      {
        from: before.sha,
        to: after.sha,
        filesAdded: d.files.added.length,
        filesRemoved: d.files.removed.length,
        modulesAdded: d.modules.added,
        modulesRemoved: d.modules.removed,
        externalsAdded: d.externals.added,
        externalsRemoved: d.externals.removed,
        cyclesIntroduced: d.cycles.introduced.length,
        cyclesResolved: d.cycles.resolved.length,
        violationsBefore: d.violations.before,
        violationsAfter: d.violations.after,
        layerChanges: d.layerChanges.length,
      },
    ];
  });
  return { snapshots, changes };
}
