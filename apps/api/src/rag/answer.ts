import type { Citation, Confidence } from '@repointelligence/shared';
import type { LlmGateway } from '../llm/gateway.js';
import { DATA_RULES, dataBlock } from '../llm/prompts.js';
import type { ChatMessage } from '../llm/provider.js';
import { NO_EVIDENCE, validateAnswer } from './citations.js';
import type { Intent } from './intent.js';
import { redactSecrets } from './redact.js';
import type { Evidence, Retrieved } from './retrieve.js';

/** Shown when nothing in the repository supports an answer. No model is asked in that case. */
export const NO_EVIDENCE_REPLY =
  'I could not find anything in this repository, at this commit, that answers that. ' +
  'Try naming a file, function, endpoint or setting, or ask about something the README covers.';

const MAX_HISTORY = 6;
const MAX_HISTORY_CHARS = 1_500;
const MAX_EVIDENCE_TOKENS = 5_000;

const INTENT_HINTS: Record<Intent, string> = {
  function: 'Describe what the function or class does, its inputs, outputs and side effects.',
  api: 'List the relevant endpoints with method, path, handler and where each is defined.',
  database: 'Name the models or tables, their main fields and where they are defined.',
  config:
    'Name the settings and where they are read. Never state a secret value, only the variable name.',
  explain: 'Walk through the code in order, citing the lines for each step.',
  find: 'Say exactly which files and lines define it.',
  compare: 'Compare only what the material shows; say what it does not show.',
  example: 'Give a short usage example based on the material, and cite where it comes from.',
  general: 'Answer briefly and point to where to read more.',
};

export function systemPrompt(): string {
  return [
    'You answer questions about one software repository, using only the material provided.',
    DATA_RULES,
    'Cite every factual claim with a marker of the form [[path:start-end]] using the path and line',
    'numbers shown on the data block you relied on. Cite only lines inside a block you were shown.',
    `If the material does not contain the answer, reply with exactly ${NO_EVIDENCE} and nothing else.`,
    'Never reveal passwords, keys, tokens or other secret values; refer to them by variable name.',
    'Answer in concise Markdown.',
  ].join(' ');
}

export interface AnswerInput {
  fullName: string;
  sha: string;
  question: string;
  intent: Intent;
  /** Earlier turns of this session, oldest first. */
  history: { role: 'user' | 'assistant'; content: string }[];
  retrieved: Retrieved[];
  evidence: Evidence;
  privateContent: boolean;
  userId?: string;
}

export interface AnswerOutput {
  text: string;
  citations: Citation[];
  confidence: Confidence;
  model: string | null;
  noEvidence: boolean;
}

/** Packs retrieved chunks into data blocks, best first, within a token budget. */
export function evidenceBlocks(retrieved: Retrieved[], budget = MAX_EVIDENCE_TOKENS): string[] {
  const out: string[] = [];
  let used = 0;
  for (const { chunk } of retrieved) {
    if (used + chunk.tokens > budget && out.length > 0) break;
    used += chunk.tokens;
    out.push(
      dataBlock(
        {
          path: chunk.provenance.path,
          startLine: chunk.provenance.startLine,
          endLine: chunk.provenance.endLine,
          kind: chunk.kind,
        },
        redactSecrets(chunk.text),
      ),
    );
  }
  return out;
}

export function buildMessages(input: AnswerInput): ChatMessage[] {
  const history = input.history.slice(-MAX_HISTORY).map((m) => ({
    role: m.role,
    content: m.content.slice(0, MAX_HISTORY_CHARS),
  }));
  const blocks = evidenceBlocks(input.retrieved);
  const weak =
    input.evidence === 'weak'
      ? 'The search found only loose matches; say so if they do not really answer the question.\n'
      : '';
  return [
    { role: 'system', content: systemPrompt() },
    ...history,
    {
      role: 'user',
      content:
        `Repository: ${input.fullName} at commit ${input.sha}\n` +
        `${INTENT_HINTS[input.intent]}\n${weak}\n` +
        `Material:\n${blocks.join('\n\n')}\n\n` +
        `Question: ${input.question}`,
    },
  ];
}

/**
 * Answers a question from retrieved chunks. With no evidence the model is not asked at all;
 * otherwise its citations are checked against the chunks it was shown.
 */
export async function answerQuestion(
  gateway: LlmGateway,
  input: AnswerInput,
): Promise<AnswerOutput> {
  const shown = input.retrieved.map((r) => r.chunk);
  if (input.evidence === 'none' || shown.length === 0) {
    return {
      text: NO_EVIDENCE_REPLY,
      citations: [],
      confidence: 'insufficient',
      model: null,
      noEvidence: true,
    };
  }
  const result = await gateway.complete('chat', buildMessages(input), {
    privateContent: input.privateContent,
    fullName: input.fullName,
    ...(input.userId && { userId: input.userId }),
  });
  const model = `${result.provider}/${result.model}`;
  const checked = validateAnswer(result.text, shown, { hasEvidence: true });
  if (checked.noEvidence || checked.text === '') {
    return {
      text: NO_EVIDENCE_REPLY,
      citations: [],
      confidence: 'insufficient',
      model,
      noEvidence: true,
    };
  }
  return {
    // The answer is redacted too, in case a value slipped through in the model's own words.
    text: redactSecrets(checked.text),
    citations: checked.citations,
    confidence: checked.confidence,
    model,
    noEvidence: false,
  };
}
