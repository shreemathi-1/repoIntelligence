import { describe, expect, it } from 'vitest';
import { healthScoreSchema, type Area } from '@repointelligence/shared';
import {
  NOW,
  healthyInputs,
  healthySignals,
  inventory,
  missing,
  ok,
  toolData,
  troubledInputs,
  withTool,
} from '../../test/fixtures/analysis.js';
import type { AnalysisInputs } from './inputs.js';
import { WEIGHTS, computeHealth, countStatuses, scale, scoreArea } from './scoring.js';

const area = (score: ReturnType<typeof computeHealth>, id: Area) =>
  score.areas.find((a) => a.id === id);
const metric = (score: ReturnType<typeof computeHealth>, id: string) =>
  score.areas.flatMap((a) => a.metrics).find((m) => m.id === id);

describe('scale', () => {
  it('maps linearly between best and worst in either direction and clamps', () => {
    expect(scale(0, 0, 20)).toBe(100);
    expect(scale(10, 0, 20)).toBe(50);
    expect(scale(25, 0, 20)).toBe(0);
    expect(scale(60, 60, 5)).toBe(100);
    expect(scale(5, 60, 5)).toBe(0);
    expect(scale(32.5, 60, 5)).toBe(50);
  });
});

describe('computeHealth', () => {
  it('scores a healthy project high with full confidence and stores the formula and weights', () => {
    const score = computeHealth(healthyInputs(), NOW);
    expect(healthScoreSchema.parse(score)).toBeTruthy();
    expect(score.status).toBe('scored');
    expect(score.overall).toBeGreaterThanOrEqual(90);
    expect(score.weights).toEqual(WEIGHTS);
    expect(score.formula).toContain('weight-averaged');
    expect(score.totalWeight).toBe(100);
    // Architecture and coverage are the only things we cannot see for a healthy project.
    expect(area(score, 'architecture')?.score).toBeNull();
    expect(metric(score, 'coverage')?.status).toBe('unavailable');
    expect(score.confidence).toBeGreaterThan(0.8);
    expect(score.confidence).toBeLessThan(1);
  });

  it('scores a troubled project low and lists its findings', () => {
    const score = computeHealth(troubledInputs(), NOW);
    expect(score.status).toBe('scored');
    expect(score.overall).toBeLessThan(30);
    expect(area(score, 'security')?.score).toBeLessThan(25);
    expect(metric(score, 'secrets')).toMatchObject({ status: 'measured', value: 2, score: 20 });
    expect(metric(score, 'vulnerabilities')).toMatchObject({ value: 2, score: 55 });
    expect(area(score, 'busFactor')?.score).toBeLessThanOrEqual(15);
    expect(area(score, 'documentation')?.score).toBeLessThan(20);
    const tools = new Set(score.findings.map((f) => f.tool));
    expect(tools).toEqual(new Set(['gitleaks', 'semgrep', 'ruff', 'osv', 'lizard']));
    expect(score.findings.filter((f) => f.tool === 'lizard')).toHaveLength(8);
  });

  it('never counts an unavailable tool as a clean result', () => {
    const withSecrets = computeHealth(healthyInputs(), NOW);
    const withoutScanner = computeHealth(withTool(healthyInputs(), missing('gitleaks')), NOW);
    const secrets = metric(withoutScanner, 'secrets');
    expect(secrets).toMatchObject({ status: 'unavailable', score: null, value: null });
    expect(secrets?.evidence).toBe('gitleaks is not installed');
    // The area is still scored from what remains, but with lower confidence.
    expect(area(withoutScanner, 'security')?.confidence).toBeLessThan(
      area(withSecrets, 'security')?.confidence ?? 0,
    );
    expect(withoutScanner.confidence).toBeLessThan(withSecrets.confidence);
  });

  it('reports insufficient data instead of a number when too little was observed', () => {
    const inputs: AnalysisInputs = {
      scan: null,
      scanUnavailableReason: 'worker not configured',
      signals: null,
      sourceLines: null,
    };
    const score = computeHealth(inputs, NOW);
    expect(score.status).toBe('insufficient-data');
    expect(score.overall).toBeNull();
    expect(score.confidence).toBe(0);
    expect(score.areas.every((a) => a.score === null)).toBe(true);
    expect(countStatuses(score).unavailable).toBeGreaterThan(30);
    expect(metric(score, 'secrets')?.evidence).toBe('worker not configured');
  });

  it('still scores community and activity from GitHub alone, below the confidence line', () => {
    const inputs: AnalysisInputs = {
      scan: null,
      scanUnavailableReason: 'worker not configured',
      signals: healthySignals(),
      sourceLines: null,
    };
    const score = computeHealth(inputs, NOW);
    expect(score.status).toBe('insufficient-data');
    expect(area(score, 'activity')?.score).toBeGreaterThan(80);
    expect(area(score, 'busFactor')?.score).toBeGreaterThan(80);
    expect(area(score, 'codeQuality')?.score).toBeNull();
  });

  it('marks inferred metrics as inferred and measured ones as measured', () => {
    const score = computeHealth(healthyInputs(), NOW);
    expect(metric(score, 'complexity.average')?.status).toBe('measured');
    expect(metric(score, 'lint.configured')?.status).toBe('inferred');
    expect(metric(score, 'readme.install')?.status).toBe('inferred');
    expect(metric(score, 'push.recency')).toMatchObject({
      status: 'measured',
      value: 2,
      unit: 'days',
    });
    const counts = countStatuses(score);
    expect(counts.measured).toBeGreaterThan(10);
    expect(counts.inferred).toBeGreaterThan(10);
  });

  it('treats an archived repository as inactive and a repo without Python as unlintable, not bad', () => {
    const archived = healthyInputs();
    archived.signals = { ...healthySignals(), archived: true };
    expect(area(computeHealth(archived, NOW), 'activity')?.score).toBe(0);

    const noPython = withTool(
      healthyInputs(),
      ok('inventory', inventory({ linesByLanguage: { Go: 5000 } })),
    );
    const lint = metric(computeHealth(noPython, NOW), 'lint.density');
    expect(lint?.status).toBe('unavailable');
    expect(lint?.evidence).toMatch(/no Python code/);
  });

  it('rejects malformed tool output as failed rather than trusting it', () => {
    const inputs = withTool(healthyInputs(), ok('lizard', { nonsense: true }));
    expect(metric(computeHealth(inputs, NOW), 'complexity.average')).toMatchObject({
      status: 'unavailable',
      evidence: 'lizard returned an unexpected shape',
    });
  });

  it('caps the stored findings per tool and says how many were cut', () => {
    const inputs = troubledInputs();
    const score = computeHealth(inputs, NOW);
    expect(score.findings.filter((f) => f.tool === 'ruff')).toHaveLength(153);
    const many = troubledInputs();
    const data = toolData(many, 'ruff');
    data.findings = Array.from({ length: 260 }, (_, i) => ({
      tool: 'ruff',
      rule: 'E501',
      severity: 'low',
      message: 'x',
      path: 'a.py',
      line: i,
    }));
    data.count = 260;
    const capped = computeHealth(many, NOW);
    expect(capped.findings.filter((f) => f.tool === 'ruff')).toHaveLength(200);
    expect(capped.findingsTruncated).toEqual({ ruff: 60 });
  });
});

describe('scoreArea', () => {
  it('weights metrics and ignores unavailable ones in the score but not in the confidence', () => {
    const result = scoreArea('tests', [
      {
        id: 'a',
        label: 'A',
        status: 'measured',
        value: 1,
        unit: null,
        score: 100,
        weight: 3,
        evidence: '',
        source: 't',
      },
      {
        id: 'b',
        label: 'B',
        status: 'inferred',
        value: 0,
        unit: null,
        score: 0,
        weight: 1,
        evidence: '',
        source: 't',
      },
      {
        id: 'c',
        label: 'C',
        status: 'unavailable',
        value: null,
        unit: null,
        score: null,
        weight: 4,
        evidence: 'no data',
        source: 't',
      },
    ]);
    expect(result.score).toBe(75);
    expect(result.confidence).toBe(0.5);
    expect(result.weight).toBe(WEIGHTS.tests);
  });

  it('has no score when nothing was observed', () => {
    const result = scoreArea('architecture', [
      {
        id: 'x',
        label: 'X',
        status: 'unavailable',
        value: null,
        unit: null,
        score: null,
        weight: 1,
        evidence: 'later',
        source: 't',
      },
    ]);
    expect(result).toMatchObject({ score: null, confidence: 0 });
  });
});
