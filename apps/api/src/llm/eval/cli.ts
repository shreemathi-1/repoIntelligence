/**
 * Runs the evaluation set against the configured providers, or against a mock with --mock.
 *
 *   npm run eval:llm               # real providers from .env
 *   npm run eval:llm -- --mock     # no keys, checks the pipeline
 *   npm run eval:llm -- --json     # machine-readable report
 */
import { providersFromEnv } from '../adapters/index.js';
import { LlmGateway } from '../gateway.js';
import { runEval } from './harness.js';
import { MockProvider } from './mock.js';

const args = new Set(process.argv.slice(2));
const real = providersFromEnv(process.env);
const useMock = args.has('--mock') || Object.keys(real).length === 0;
const gateway = new LlmGateway({ providers: useMock ? { ollama: new MockProvider() } : real });

const report = await runEval(gateway);
const pct = (n: number) => `${Math.round(n * 100)}%`;

if (args.has('--json')) {
  process.stdout.write(`${JSON.stringify({ mock: useMock, ...report }, null, 2)}\n`);
} else {
  process.stdout.write(`Providers: ${useMock ? 'mock' : Object.keys(real).join(', ')}\n\n`);
  for (const c of report.cases) {
    const mark = c.passed ? 'pass' : 'FAIL';
    process.stdout.write(
      `${mark}  ${c.id.padEnd(12)} ${c.confidence.padEnd(12)} ${String(c.latencyMs).padStart(6)} ms  ${c.model ?? '-'}\n`,
    );
    for (const p of c.problems) process.stdout.write(`      ${p}\n`);
  }
  process.stdout.write(
    `\nCitation hits ${pct(report.citationHitRate)}, no-evidence accuracy ${pct(report.noEvidenceAccuracy)}, ` +
      `leak free ${pct(report.leakFreeRate)}, passed ${pct(report.passRate)}\n`,
  );
}
process.exitCode = report.passRate === 1 ? 0 : 1;
