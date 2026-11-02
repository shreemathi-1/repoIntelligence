import { z } from 'zod';
import type { ArchitectureGraph, Citation } from '@repointelligence/shared';
import type { LlmGateway } from '../llm/gateway.js';
import { DATA_RULES, noteBlock } from '../llm/prompts.js';
import { completeStructured } from '../llm/structured.js';
import type { Chunk } from '../ingest/types.js';
import type { Intent } from './intent.js';
import { redactSecrets } from './redact.js';

const MAX_SUGGESTIONS = 6;

type GraphFacts = Pick<ArchitectureGraph, 'routes' | 'models' | 'entryPoints'>;

/** Questions that make sense for any repository, sharpened by what the graph detected. */
export function staticSuggestions(graph: GraphFacts | null, chunks: Chunk[] = []): string[] {
  const out = ['What does this repository do?', 'How do I run it locally?'];
  if (graph?.entryPoints.length) out.push('Where does the application start?');
  if (graph?.routes.length) out.push('Which endpoints does the API expose?');
  if (graph?.models.length) out.push('What data models are defined, and where?');
  if (chunks.some((c) => c.kind === 'config'))
    out.push('Which environment variables does it need?');
  if (chunks.some((c) => /test/i.test(c.provenance.path))) out.push('How is it tested?');
  return out.slice(0, MAX_SUGGESTIONS);
}

/** Next questions after an answer, based on what was asked and cited. */
export function followUps(intent: Intent, citations: Citation[]): string[] {
  const first = citations[0];
  const out: string[] = [];
  if (first)
    out.push(`Explain ${first.path} lines ${first.startLine}-${first.endLine} line by line`);
  const byIntent: Record<Intent, string[]> = {
    function: ['Where is it called from?', 'What could go wrong in it?'],
    api: ['How are requests authenticated?', 'Which data does each endpoint read or write?'],
    database: ['Where are these models queried?', 'How are migrations handled?'],
    config: ['Which settings are required in production?', 'What are the defaults?'],
    explain: ['What calls this code?', 'Are there tests for it?'],
    find: ['What depends on it?', 'Show an example of using it'],
    compare: ['Which one is used by default?'],
    example: ['What options does it accept?'],
    general: ['How is the code organised?', 'What are its main dependencies?'],
  };
  out.push(...byIntent[intent]);
  return out.slice(0, 3);
}

const suggestionSchema = z.object({
  questions: z.array(z.string().trim().min(5).max(160)).min(1).max(10),
});

/**
 * Asks a small model for questions a newcomer would ask, from the README and the detected
 * structure. Falls back to the static list when no model can answer.
 */
export async function modelSuggestions(
  gateway: LlmGateway,
  input: {
    fullName: string;
    graph: GraphFacts | null;
    chunks: Chunk[];
    privateContent: boolean;
    userId?: string;
  },
): Promise<{ questions: string[]; source: 'model' | 'static' }> {
  const fallback = staticSuggestions(input.graph, input.chunks);
  if (!gateway.available('light', { privateContent: input.privateContent })) {
    return { questions: fallback, source: 'static' };
  }
  const readme = input.chunks
    .filter((c) => c.kind === 'doc')
    .slice(0, 3)
    .map((c) => redactSecrets(c.text))
    .join('\n\n')
    .slice(0, 4_000);
  const listOr = (items: string[] | undefined) =>
    items && items.length > 0 ? items.slice(0, 15).join(', ') : 'none detected';
  const facts = [
    `Endpoints: ${listOr(input.graph?.routes.map((r) => `${r.method} ${r.route}`))}`,
    `Models: ${listOr(input.graph?.models.map((m) => m.name))}`,
  ].join('\n');
  try {
    const { data } = await completeStructured(
      gateway,
      'light',
      [
        {
          role: 'system',
          content:
            'You suggest short questions a developer new to a repository would ask about it. ' +
            `${DATA_RULES} Reply with JSON: {"questions": ["..."]}, 4 to 6 questions, each under 120 characters.`,
        },
        {
          role: 'user',
          content: `Repository: ${input.fullName}\n${noteBlock('readme', readme)}\n${noteBlock('structure', facts)}`,
        },
      ],
      suggestionSchema,
      {
        privateContent: input.privateContent,
        fullName: input.fullName,
        ...(input.userId && { userId: input.userId }),
      },
    );
    const questions = [...new Set(data.questions.map((q) => q.trim()))].slice(0, MAX_SUGGESTIONS);
    return { questions, source: 'model' };
  } catch {
    return { questions: fallback, source: 'static' };
  }
}
