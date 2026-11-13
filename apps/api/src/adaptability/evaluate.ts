import {
  DIMENSIONS,
  DIMENSION_LABELS,
  type AdaptabilityFacts,
  type ChecklistItem,
  type Dimension,
  type StackProfileInput,
  type WarningSeverity,
} from '@repointelligence/shared';
import { authCheck, databaseCheck, licenseCheck } from './checks/policy.js';
import {
  configurationCheck,
  infrastructureCheck,
  osCheck,
  servicesCheck,
} from './checks/platform.js';
import { dependencyCheck, frameworkCheck, runtimeCheck } from './checks/versions.js';
import type { Check, Detected } from './types.js';

/** How much each dimension counts toward the overall score. They add up to 100. */
export const WEIGHTS: Record<Dimension, number> = {
  runtime: 15,
  framework: 10,
  dependencies: 15,
  license: 15,
  database: 10,
  auth: 8,
  services: 8,
  infrastructure: 7,
  os: 7,
  configuration: 5,
};

/** A blocker cannot be worked around with effort, so it caps the overall score. */
export const BLOCKER_CAP = 25;
/** Below this share of observed weight there is too little to put a number on. */
const MIN_CONFIDENCE = 0.3;

const CHECKS: Record<Dimension, Check> = {
  runtime: runtimeCheck,
  framework: frameworkCheck,
  dependencies: dependencyCheck,
  license: licenseCheck,
  database: databaseCheck,
  auth: authCheck,
  services: servicesCheck,
  infrastructure: infrastructureCheck,
  os: osCheck,
  configuration: configurationCheck,
};

export const FORMULA =
  'Each dimension is scored 0 to 100 by fixed rules. The overall score is the weight-averaged mean ' +
  `of the dimensions that could be compared; the rest are left out, not counted as zero. Any blocker caps it at ${BLOCKER_CAP}.`;

const SEVERITY_ORDER: Record<WarningSeverity, number> = { blocker: 0, major: 1, minor: 2, info: 3 };
const SETUP_HOURS = {
  low: { low: 1, high: 2 },
  medium: { low: 2, high: 6 },
  high: { low: 6, high: 16 },
};
const round = (n: number): number => Math.round(n * 10) / 10;

/** Runs every check and combines the results. Pure: the same inputs always give the same report. */
export function evaluate(detected: Detected, profile: StackProfileInput): AdaptabilityFacts {
  const results = DIMENSIONS.map((id) => CHECKS[id](detected, profile));
  const dimensions = results.map((r) => ({
    ...r.dimension,
    label: DIMENSION_LABELS[r.dimension.id],
    weight: WEIGHTS[r.dimension.id],
  }));
  const warnings = results
    .flatMap((r) => r.warnings)
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  const modifications = results.flatMap((r) => r.modifications);
  const breaking = results.flatMap((r) => r.breaking ?? []);
  const blocked = warnings.some((w) => w.severity === 'blocker');

  const measured = dimensions.filter((d) => d.score !== null);
  const observed = measured.reduce((sum, d) => sum + d.weight, 0);
  const confidence = observed / 100;
  let score: number | null = null;
  if (measured.length > 0 && confidence >= MIN_CONFIDENCE) {
    score = Math.round(measured.reduce((sum, d) => sum + (d.score ?? 0) * d.weight, 0) / observed);
    if (blocked) score = Math.min(score, BLOCKER_CAP);
  }
  const verdict =
    score === null
      ? null
      : blocked
        ? 'blocked'
        : score >= 80
          ? 'ready'
          : score >= 55
            ? 'adaptable'
            : 'difficult';

  const { requirements, signals } = detected;
  const required = requirements.envVars.filter((v) => v.required).length;
  const infra = requirements.services.filter((s) => s.kind !== 'saas').length;
  const saas = requirements.services.length - infra;
  const factors: [number, string][] = [
    [required > 8 ? 2 : required > 3 ? 1 : 0, `${required} required environment variables`],
    [infra, `${infra} databases or infrastructure services to run`],
    [saas * 0.5, `${saas} third-party accounts`],
    [requirements.database.migrations > 0 ? 1 : 0, `${requirements.database.migrations} migrations to apply`],
    [requirements.runtimes.length > 1 ? 1 : 0, `${requirements.runtimes.length} language runtimes`],
    [signals.compose ? 1 : 0, 'a Docker Compose setup'],
    [signals.nativePackages.length > 0 ? 1 : 0, 'native dependencies to compile'],
  ]; // prettier-ignore
  const points = factors.reduce((sum, [p]) => sum + p, 0);
  const level = points < 2 ? 'low' : points < 5 ? 'medium' : 'high';

  const basis = [
    { text: `Base setup (${level} complexity)`, hours: SETUP_HOURS[level] },
    ...modifications.map((m) => ({ text: m.title, hours: m.hours })),
  ];
  return {
    overall: { score, confidence, verdict, formula: FORMULA },
    dimensions,
    warnings,
    requirements,
    breakingRisk: {
      level: breaking.length >= 3 ? 'high' : breaking.length > 0 ? 'medium' : 'low',
      reasons: breaking,
    },
    missingInfrastructure: results.flatMap((r) => r.missingInfrastructure ?? []),
    setupComplexity: { level, factors: factors.filter(([p]) => p > 0).map(([, text]) => text) },
    effort: {
      hours: {
        low: round(basis.reduce((sum, b) => sum + b.hours.low, 0)),
        high: round(basis.reduce((sum, b) => sum + b.hours.high, 0)),
      },
      basis,
      estimate: true,
    },
    modifications,
    inputs: { ingestion: true, graph: signals.hasGraph },
  };
}

/** The order someone would actually work through: permission first, then environment, then code. */
const CHECKLIST_ORDER: Dimension[] = ['license', 'runtime', 'infrastructure', 'services', 'database', 'configuration', 'auth', 'framework', 'dependencies', 'os']; // prettier-ignore

export function buildChecklist(facts: AdaptabilityFacts, sha: string, done: string[] = []): ChecklistItem[] {
  const items: Omit<ChecklistItem, 'done'>[] = [];
  for (const w of facts.warnings) {
    if (w.dimension === 'license') items.push({ id: `review-${w.id}`, dimension: 'license', text: `Resolve the license question: ${w.message}` });
  }
  items.push({ id: 'pin-commit', dimension: null, text: `Check out commit ${sha.slice(0, 12)}, the one this report describes` });
  for (const dimension of CHECKLIST_ORDER) {
    for (const m of facts.modifications.filter((x) => x.dimension === dimension)) {
      items.push({ id: m.id, dimension, text: `${m.title}. ${m.detail}` });
    }
  }
  items.push({ id: 'verify', dimension: null, text: "Install dependencies and run the repository's tests in your environment" });
  return items.map((item) => ({ ...item, done: done.includes(item.id) }));
} // prettier-ignore
