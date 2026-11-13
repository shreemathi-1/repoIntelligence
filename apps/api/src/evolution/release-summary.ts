import type { CompareFacts, Interpretation } from '@repointelligence/shared';
import { z } from 'zod';
import { AppError } from '../errors.js';
import type { LlmGateway } from '../llm/gateway.js';
import { DATA_RULES, noteBlock } from '../llm/prompts.js';
import { completeStructured } from '../llm/structured.js';
import { redactSecrets } from '../rag/redact.js';

const SUBJECTS_PER_GROUP = 15;
const QUIET_ERRORS = new Set(['LLM_NOT_CONFIGURED', 'LLM_UNAVAILABLE', 'LLM_INVALID_OUTPUT']);

const replySchema = z.object({
  summary: z.string().min(1).max(1500),
  highlights: z.array(z.string().max(300)).max(8).default([]),
  risks: z.array(z.string().max(300)).max(6).default([]),
});

/** The facts as plain lines. Commit subjects come from the repository and stay inside the data block. */
export function factsText(tag: string, base: string | null, compare: CompareFacts): string {
  const lines = [
    `Release ${tag}${base ? `, compared with ${base}` : ''}.`,
    `Commits: ${compare.totalCommits} by ${compare.authors} authors${compare.commits.length < compare.totalCommits ? ` (first ${compare.commits.length} listed)` : ''}.`,
    `Files changed: ${compare.files.total}${compare.files.truncated ? ' or more' : ''}, +${compare.files.additions} -${compare.files.deletions} lines.`,
    `Busiest directories: ${compare.files.directories.slice(0, 6).map((d) => `${d.path} (${d.files} files)`).join(', ') || 'none'}.`,
  ];
  for (const [group, count] of Object.entries(compare.groups)) {
    if (count === 0 || group === 'merge' || group === 'chore') continue;
    const subjects = compare.commits.filter((c) => c.group === group).slice(0, SUBJECTS_PER_GROUP).map((c) => `  - ${c.subject}`);
    lines.push(`${group} (${count}):`, ...subjects);
  }
  for (const m of compare.dependencies.manifests) {
    lines.push(`Dependencies in ${m.path}:`);
    for (const c of m.changed) lines.push(`  - ${c.name} ${c.from} -> ${c.to} (${c.change} ${c.direction})`);
    for (const a of m.added) lines.push(`  - added ${a.name} ${a.spec}`);
    for (const r of m.removed) lines.push(`  - removed ${r.name}`);
  }
  return lines.join('\n');
} // prettier-ignore

export interface InterpretOptions {
  privateContent: boolean;
  userId: string;
  fullName: string;
  now: number;
}

export type InterpretResult =
  { interpretation: Interpretation; note: null } | { interpretation: null; note: string };

/** Asks one model to read the facts. Failure leaves the facts standing with a note instead. */
export async function interpretRelease(
  gateway: LlmGateway,
  tag: string,
  base: string | null,
  compare: CompareFacts,
  options: InterpretOptions,
): Promise<InterpretResult> {
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
            'You summarise a software release for someone deciding whether to upgrade.',
            'Use only the facts provided; do not invent features, numbers or versions.',
            'Mention breaking changes and major dependency upgrades first when there are any.',
            DATA_RULES,
            'Reply with JSON: {"summary": "two to four sentences", "highlights": ["..."], "risks": ["..."]}.',
          ].join(' '),
        },
        { role: 'user', content: noteBlock('release-facts', factsText(tag, base, compare)) },
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
    return { interpretation: null, note: `The summary was not written: ${err.message}.` };
  }
} // prettier-ignore
