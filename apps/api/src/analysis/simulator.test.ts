import { describe, expect, it } from 'vitest';
import { simulateResponseSchema } from '@repointelligence/shared';
import { NOW, troubledInputs } from '../../test/fixtures/analysis.js';
import type { computeHealth } from './scoring.js';
import { simulate } from './simulator.js';

const area = (score: ReturnType<typeof computeHealth>, id: string) =>
  score.areas.find((a) => a.id === id)?.score ?? null;

describe('simulate', () => {
  it('resolving the secrets and vulnerabilities raises security and dependencies, nothing else', () => {
    const result = simulate(
      troubledInputs(),
      {
        resolveRules: [{ tool: 'gitleaks', rule: 'aws-key' }],
        resolveSeverities: ['critical'],
        addFiles: [],
      },
      NOW,
    );
    expect(simulateResponseSchema.parse(result)).toBeTruthy();
    expect(result.estimate).toBe(true);
    expect(result.findingsResolved).toBe(3);
    expect(result.delta.areas.security).toBeGreaterThan(0);
    expect(result.delta.areas.dependencies).toBeGreaterThan(0);
    expect(result.delta.areas.documentation).toBe(0);
    expect(result.delta.overall).toBeGreaterThan(0);
    expect(area(result.after, 'security')).toBeGreaterThan(area(result.before, 'security') ?? 0);
  });

  it('resolving complexity hotspots counts each function once', () => {
    const result = simulate(
      troubledInputs(),
      {
        resolveRules: [{ tool: 'lizard', rule: 'complexity' }],
        resolveSeverities: [],
        addFiles: [],
      },
      NOW,
    );
    expect(result.findingsResolved).toBe(8);
    expect(result.delta.areas.codeQuality).toBeGreaterThan(0);
    expect(result.after.findings.some((f) => f.tool === 'lizard')).toBe(false);
  });

  it('adding community files and tests moves the matching areas', () => {
    const result = simulate(
      troubledInputs(),
      {
        resolveRules: [],
        resolveSeverities: [],
        addFiles: ['CONTRIBUTING', 'SECURITY', 'ci', 'tests'],
      },
      NOW,
    );
    expect(result.findingsResolved).toBe(0);
    expect(result.delta.areas.documentation).toBeGreaterThan(0);
    expect(result.delta.areas.security).toBeGreaterThan(0);
    expect(result.delta.areas.cicd).toBeGreaterThan(0);
    expect(result.delta.areas.tests).toBeGreaterThan(0);
    expect(result.delta.areas.activity).toBe(0);
  });

  it('does not change the original inputs', () => {
    const inputs = troubledInputs();
    const snapshot = JSON.stringify(inputs);
    simulate(
      inputs,
      {
        resolveRules: [],
        resolveSeverities: ['low', 'medium', 'high', 'critical'],
        addFiles: ['ci'],
      },
      NOW,
    );
    expect(JSON.stringify(inputs)).toBe(snapshot);
  });

  it('is a no-op when nothing matches', () => {
    const result = simulate(
      troubledInputs(),
      { resolveRules: [{ tool: 'ruff', rule: 'NOPE' }], resolveSeverities: [], addFiles: [] },
      NOW,
    );
    expect(result.findingsResolved).toBe(0);
    expect(result.delta.overall).toBe(0);
  });
});
