import type {
  AdaptabilityFacts,
  Interpretation,
  StackProfileInput,
} from '@repointelligence/shared';
import { z } from 'zod';
import { AppError } from '../errors.js';
import type { LlmGateway } from '../llm/gateway.js';
import { DATA_RULES, noteBlock } from '../llm/prompts.js';
import { completeStructured } from '../llm/structured.js';
import { redactSecrets } from '../rag/redact.js';

const QUIET_ERRORS = new Set(['LLM_NOT_CONFIGURED', 'LLM_UNAVAILABLE', 'LLM_INVALID_OUTPUT']);
const MAX_WARNINGS = 20;

const replySchema = z.object({
  summary: z.string().min(1).max(1500),
  highlights: z.array(z.string().max(300)).max(8).default([]),
  risks: z.array(z.string().max(300)).max(8).default([]),
});

/** The rule results as plain lines. Names taken from the repository stay inside the data block. */
export function factsText(facts: AdaptabilityFacts): string {
  const { overall, effort } = facts;
  return [
    `Overall: ${overall.score ?? 'not scored'} of 100, verdict ${overall.verdict ?? 'none'}, ${Math.round(overall.confidence * 100)}% of the weight compared.`,
    `Breaking-change risk: ${facts.breakingRisk.level}. Setup complexity: ${facts.setupComplexity.level}. Effort estimate: ${effort.hours.low} to ${effort.hours.high} hours.`,
    'Dimensions:',
    ...facts.dimensions.map((d) => `  - ${d.label}: ${d.score ?? 'not compared'} - ${d.summary}`),
    'Warnings:',
    ...facts.warnings.slice(0, MAX_WARNINGS).map((w) => `  - [${w.severity}] ${w.message}`),
    'Required modifications:',
    ...facts.modifications.map((m) => `  - ${m.title} (${m.hours.low} to ${m.hours.high} h)`),
  ].join('\n');
} // prettier-ignore

export interface ExplainOptions {
  privateContent: boolean;
  userId: string;
  fullName: string;
  now: number;
}

export type ExplainResult =
  { interpretation: Interpretation; note: null } | { interpretation: null; note: string };

/** Asks one model to explain the rule results. It adds no scores or warnings of its own. */
export async function explainReport(
  gateway: LlmGateway,
  facts: AdaptabilityFacts,
  profile: StackProfileInput,
  options: ExplainOptions,
): Promise<ExplainResult> {
  if (!gateway.available('explain', { privateContent: options.privateContent })) {
    return { interpretation: null, note: 'No suitable model is configured on this server.' };
  }
  try {
    const { data, result } = await completeStructured(
      gateway,
      'explain',
      [
        {
          role: 'system',
          content: [
            'You explain a compatibility report to an engineer deciding whether to adopt a repository into their own stack.',
            'The scores, warnings and hours were computed by fixed rules. Explain them; do not change them, add new findings or invent versions.',
            'Say what fits, then what stands in the way, most serious first.',
            DATA_RULES,
            'Reply with JSON: {"summary": "two to four sentences", "highlights": ["what already fits"], "risks": ["what to resolve first"]}.',
          ].join(' '),
        },
        {
          role: 'user',
          content: [
            noteBlock('compatibility-report', factsText(facts)),
            ...(profile.requirements ? [noteBlock('adopter-requirements', profile.requirements)] : []),
          ].join('\n\n'),
        },
      ],
      replySchema,
      { privateContent: options.privateContent, userId: options.userId, fullName: options.fullName, maxTokens: 1_200 },
    );
    return {
      interpretation: {
        summary: redactSecrets(data.summary.trim()),
        highlights: data.highlights.map((h) => redactSecrets(h.trim())).filter(Boolean),
        risks: data.risks.map((r) => redactSecrets(r.trim())).filter(Boolean),
        writtenBy: `${result.provider}/${result.model}`,
        generatedAt: new Date(options.now).toISOString(),
      },
      note: null,
    };
  } catch (err) {
    if (!(err instanceof AppError) || !QUIET_ERRORS.has(err.code)) throw err;
    return { interpretation: null, note: `The explanation was not written: ${err.message}.` };
  }
} // prettier-ignore
