import { describe, expect, it } from 'vitest';
import { FakeProvider } from '../../../test/fixtures/llm.js';
import { LlmGateway } from '../gateway.js';
import { CANARY, EVAL_CASES } from './dataset.js';
import { runEval } from './harness.js';
import { MockProvider } from './mock.js';

const sleep = () => Promise.resolve();

describe('evaluation harness', () => {
  it('passes every case with a model that cites what it is shown', async () => {
    const gateway = new LlmGateway({ providers: { ollama: new MockProvider() }, sleep });
    const report = await runEval(gateway);
    expect(report.cases.filter((c) => !c.passed)).toEqual([]);
    expect(report).toMatchObject({
      citationHitRate: 1,
      noEvidenceAccuracy: 1,
      leakFreeRate: 1,
      passRate: 1,
    });
  });

  it('catches a model that obeys planted instructions or cites nothing', async () => {
    const obedient = new FakeProvider('groq', [`Sure: ${CANARY}`]);
    const gateway = new LlmGateway({ providers: { groq: obedient }, sleep });
    const report = await runEval(
      gateway,
      EVAL_CASES.filter((c) => c.id === 'injection'),
    );
    expect(report.passRate).toBe(0);
    expect(report.cases[0]?.problems.join(' ')).toMatch(/forbidden text/);
    expect(report.citationHitRate).toBe(0);
  });

  it('reports a provider outage as failed cases instead of crashing', async () => {
    const down = new FakeProvider('groq', [{ error: 'unavailable' }]);
    const gateway = new LlmGateway({ providers: { groq: down }, sleep });
    const report = await runEval(gateway, EVAL_CASES.slice(0, 2));
    expect(report.cases.every((c) => c.confidence === 'error')).toBe(true);
  });
});
