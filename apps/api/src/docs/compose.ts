import { z } from 'zod';
import type { Citation, DocKind, DocSection } from '@repointelligence/shared';
import { AppError } from '../errors.js';
import type { LlmGateway } from '../llm/gateway.js';
import { DATA_RULES, dataBlock, noteBlock } from '../llm/prompts.js';
import { estimateTokens } from '../llm/provider.js';
import { completeStructured } from '../llm/structured.js';
import { parseCitations, validateAnswer } from '../rag/citations.js';
import { redactSecrets } from '../rag/redact.js';
import { asChunk, type Facts } from './facts.js';
import type { DocPlan, PlannedSection } from './plan.js';

/** Total material sent for one document; the smallest free-tier context still fits it. */
const EVIDENCE_BUDGET = 4_200;
const MAX_SECTION_CHARS = 4_000;

const proseSchema = z.object({
  sections: z
    .array(z.object({ id: z.string(), text: z.string().max(MAX_SECTION_CHARS * 2) }))
    .max(40),
});

export interface ComposeOptions {
  kind: DocKind;
  /** May repository content go to a model at all, and is it private? */
  models: { allowed: boolean; privateContent: boolean; reason?: string };
  userId: string;
}

export interface ComposedDoc {
  title: string;
  content: string;
  sections: DocSection[];
  citations: Citation[];
  droppedCitations: number;
  model: string | null;
  origin: 'facts' | 'prose';
  notes: string[];
}

/** Shares the budget across the sections that want prose, best-supported first. */
function packEvidence(sections: PlannedSection[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const per = Math.max(400, Math.floor(EVIDENCE_BUDGET / Math.max(1, sections.length)));
  let used = 0;
  for (const s of sections) {
    const blocks: string[] = [];
    let own = 0;
    for (const e of s.evidence) {
      const tokens = estimateTokens(e.text);
      if ((own + tokens > per || used + tokens > EVIDENCE_BUDGET) && blocks.length > 0) break;
      if (used + tokens > EVIDENCE_BUDGET) break;
      blocks.push(dataBlock(e, redactSecrets(e.text)));
      own += tokens;
      used += tokens;
    }
    out.set(s.id, blocks);
  }
  return out;
}

export function prosePrompt(fullName: string, sha: string, sections: PlannedSection[]) {
  const packed = packEvidence(sections);
  const parts = sections.map((s) =>
    [
      `### Section "${s.id}": ${s.heading}`,
      `Write: ${s.prose ?? ''}`,
      s.facts ? `Already shown to the reader below your text:\n${redactSecrets(s.facts)}` : '',
      s.notes ? noteBlock('notes', redactSecrets(s.notes)) : '',
      ...(packed.get(s.id) ?? []),
    ]
      .filter(Boolean)
      .join('\n'),
  );
  return [
    {
      role: 'system' as const,
      content: [
        'You are a technical writer documenting one software repository from its own files.',
        DATA_RULES,
        'Write only what the material supports. Cite each factual statement with [[path:start-end]]',
        'using the path and lines of a data block you were shown. Do not repeat the facts listed',
        'for a section; explain them. If the material does not support a section, return an empty',
        'text for it. Never write passwords, keys, tokens or other secret values.',
        'Use plain Markdown without top-level headings. Reply with JSON:',
        '{"sections": [{"id": "<section id>", "text": "<markdown>"}]}.',
      ].join(' '),
    },
    {
      role: 'user' as const,
      content: `Repository: ${fullName} at commit ${sha}\n\n${parts.join('\n\n')}`,
    },
  ];
}

const QUIET_ERRORS = new Set(['LLM_NOT_CONFIGURED', 'LLM_UNAVAILABLE', 'LLM_INVALID_OUTPUT']);

/** Writes prose for the sections that ask for it, then assembles and checks the document. */
export async function composeDoc(
  gateway: LlmGateway,
  facts: Facts,
  plan: DocPlan,
  options: ComposeOptions,
): Promise<ComposedDoc> {
  const notes = [...plan.notes];
  const wanting = plan.sections.filter(
    (s) => s.prose && !s.missing && (s.evidence.length > 0 || s.notes),
  );
  const prose = new Map<string, string>();
  let model: string | null = null;
  let dropped = 0;

  if (wanting.length > 0 && !options.models.allowed) {
    notes.push(options.models.reason ?? 'Explanations were not written by a model.');
  } else if (wanting.length > 0) {
    try {
      const { data, result } = await completeStructured(
        gateway,
        'explain',
        prosePrompt(facts.fullName, facts.sha, wanting),
        proseSchema,
        {
          privateContent: options.models.privateContent,
          fullName: facts.fullName,
          userId: options.userId,
          maxTokens: 2_500,
        },
      );
      model = `${result.provider}/${result.model}`;
      const evidence = wanting.flatMap((s) =>
        s.evidence.map((e) => asChunk(e, facts.fullName, facts.sha)),
      );
      for (const s of data.sections) {
        if (!wanting.some((w) => w.id === s.id)) continue;
        const raw = s.text.trim().slice(0, MAX_SECTION_CHARS);
        if (!raw) continue;
        const checked = validateAnswer(raw, evidence, { hasEvidence: true });
        dropped += checked.dropped;
        if (checked.text) prose.set(s.id, redactSecrets(checked.text));
      }
    } catch (err) {
      if (!(err instanceof AppError) || !QUIET_ERRORS.has(err.code)) throw err;
      notes.push(`Explanations were not written: ${err.message}.`);
    }
  }

  const lines = [
    `# ${plan.title}`,
    '',
    `> Generated from ${facts.fullName} at commit ${facts.sha.slice(0, 12)}. Each citation points at` +
      ' the file and lines it came from at that commit.',
    '',
  ];
  const sections: DocSection[] = [];
  for (const s of plan.sections) {
    lines.push(`## ${s.heading}`, '');
    const text = prose.get(s.id);
    if (s.missing) lines.push(`_Not found in the repository: ${s.missing}_`, '');
    if (text) lines.push(text, '');
    if (s.facts) lines.push(s.facts.trim(), '');
    const body = `${text ?? ''}\n${s.facts}`;
    sections.push({
      id: s.id,
      heading: s.heading,
      missing: s.missing ?? null,
      citations: uniqueCitations(body),
    });
  }
  const content = `${lines.join('\n').trimEnd()}\n`;
  return {
    title: plan.title,
    content,
    sections,
    citations: uniqueCitations(content),
    droppedCitations: dropped,
    model,
    origin: prose.size > 0 ? 'prose' : 'facts',
    notes,
  };
}

export function uniqueCitations(markdown: string): Citation[] {
  const seen = new Set<string>();
  const out: Citation[] = [];
  for (const c of parseCitations(markdown)) {
    const key = `${c.path}:${c.startLine}-${c.endLine}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ path: c.path, startLine: c.startLine, endLine: c.endLine });
  }
  return out;
}
