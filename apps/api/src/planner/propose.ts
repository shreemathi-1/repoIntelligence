import { MAX_PLAN_TASKS, type ArchitectureGraph } from '@repointelligence/shared';
import { z } from 'zod';
import type { Excerpt } from '../docs/facts.js';
import { AppError } from '../errors.js';
import type { LlmGateway } from '../llm/gateway.js';
import { DATA_RULES, dataBlock, noteBlock } from '../llm/prompts.js';
import { completeStructured } from '../llm/structured.js';
import { boostTerms } from '../rag/intent.js';
import { redactSecrets } from '../rag/redact.js';
import type { HybridRetriever } from '../rag/retrieve.js';
import type { ProposedTask } from './pipeline.js';

const MAX_CANDIDATES = 12;
const EXCERPTS_PER_FILE = 2;
/** Characters of file excerpts shown to the model; keeps the prompt inside free-tier contexts. */
const EXCERPT_BUDGET = 14_000;
const MAX_LISTED_PATHS = 150;
const QUIET_ERRORS = new Set(['LLM_NOT_CONFIGURED', 'LLM_UNAVAILABLE', 'LLM_INVALID_OUTPUT']);

export interface Candidate {
  path: string;
  score: number;
  excerpts: Excerpt[];
}

/** Files most related to the goal, by the same retrieval chat uses. Documentation is left out. */
export async function findCandidates(
  retriever: HybridRetriever,
  goal: string,
  options: { fullName: string; sha: string; graph: ArchitectureGraph | null; useVectors: boolean },
): Promise<Candidate[]> {
  const { chunks } = await retriever.retrieve(goal, {
    fullName: options.fullName,
    sha: options.sha,
    limit: 30,
    boost: boostTerms(goal, options.graph),
    useVectors: options.useVectors,
  });
  const byPath = new Map<string, Candidate>();
  for (const { chunk, score } of chunks) {
    if (chunk.kind === 'doc') continue;
    const { path, startLine, endLine } = chunk.provenance;
    const entry = byPath.get(path) ?? { path, score: 0, excerpts: [] };
    entry.score += score;
    if (entry.excerpts.length < EXCERPTS_PER_FILE) entry.excerpts.push({ path, startLine, endLine, text: chunk.text });
    byPath.set(path, entry);
  }
  return [...byPath.values()].sort((a, b) => b.score - a.score).slice(0, MAX_CANDIDATES);
} // prettier-ignore

const replySchema = z.object({
  tasks: z
    .array(
      z.object({
        title: z.string().min(1).max(160),
        description: z.string().max(1200).default(''),
        files: z
          .array(
            z.object({
              path: z.string().min(1).max(300),
              change: z.enum(['modify', 'create']).default('modify'),
              reason: z.string().max(400).default(''),
            }),
          )
          .max(10)
          .default([]),
        api: z.array(z.object({ method: z.string().max(10), route: z.string().max(200) })).max(10).default([]),
        models: z.array(z.string().max(80)).max(10).default([]),
      }),
    )
    .max(MAX_PLAN_TASKS * 2),
}); // prettier-ignore

const orElse = (text: string | undefined, fallback: string): string =>
  text === undefined || text === '' ? fallback : text;

function outline(graph: ArchitectureGraph | null, paths: string[], candidates: Candidate[]): string {
  const listed = [...new Set([...candidates.map((c) => c.path), ...paths])].slice(0, MAX_LISTED_PATHS);
  return [
    `Stack: ${orElse(graph?.stack.map((s) => s.name).join(', '), 'unknown')}`,
    `Routes: ${orElse(graph?.routes.slice(0, 30).map((r) => `${r.method} ${r.route} (${r.path})`).join('; '), 'none detected')}`,
    `Data models: ${orElse(graph?.models.slice(0, 30).map((m) => `${m.name} (${m.path})`).join('; '), 'none detected')}`,
    `Files (${paths.length} in total, the most relevant first):`,
    ...listed.map((p) => `  ${p}`),
  ].join('\n');
} // prettier-ignore

export interface ProposeInput {
  goal: string;
  fullName: string;
  sha: string;
  graph: ArchitectureGraph | null;
  paths: string[];
  candidates: Candidate[];
  privateContent: boolean;
  userId: string;
}

export type ProposeResult =
  | { tasks: ProposedTask[]; writtenBy: string; note: null }
  | { tasks: null; writtenBy: null; note: string };

/**
 * Asks one model for a task breakdown. The reply is a proposal: paths, order, tests, effort and
 * risk are all decided afterwards by checks against the repository.
 */
export async function proposePlan(gateway: LlmGateway, input: ProposeInput): Promise<ProposeResult> {
  if (!gateway.available('explain', { privateContent: input.privateContent })) {
    return { tasks: null, writtenBy: null, note: 'No suitable model is configured, so the plan lists the relevant files without task descriptions.' };
  }
  const blocks: string[] = [];
  let used = 0;
  for (const c of input.candidates) {
    for (const e of c.excerpts) {
      const text = redactSecrets(e.text).slice(0, 2400);
      if (used + text.length > EXCERPT_BUDGET) break;
      used += text.length;
      blocks.push(dataBlock({ path: e.path, startLine: e.startLine, endLine: e.endLine }, text));
    }
  }
  try {
    const { data, result } = await completeStructured(
      gateway,
      'explain',
      [
        {
          role: 'system',
          content: [
            'You plan how to implement a change in an existing code base, as a list of small tasks a developer can do one at a time.',
            'Use only file paths from the file list, exactly as written. A new file must be placed in a directory that already appears in the list and marked "create".',
            'Follow the conventions visible in the excerpts. Name the routes and data models a task adds or changes. Do not write code.',
            `At most ${MAX_PLAN_TASKS} tasks, each touching a few files.`,
            DATA_RULES,
            'Reply with JSON: {"tasks": [{"title": "...", "description": "what to change and why", "files": [{"path": "src/x.ts", "change": "modify", "reason": "..."}], "api": [{"method": "GET", "route": "/x"}], "models": ["Name"]}]}.',
          ].join(' '),
        },
        {
          role: 'user',
          content: [noteBlock('goal', input.goal), noteBlock('repository-outline', outline(input.graph, input.paths, input.candidates)), ...blocks].join('\n\n'),
        },
      ],
      replySchema,
      { privateContent: input.privateContent, userId: input.userId, fullName: input.fullName, maxTokens: 3_000 },
    );
    const clean = (text: string): string | null => {
      const cleaned = redactSecrets(text.trim());
      return cleaned === '' ? null : cleaned;
    };
    return {
      tasks: data.tasks.map((t) => ({
        title: redactSecrets(t.title.trim()),
        description: clean(t.description),
        files: t.files.map((f) => ({ path: f.path, change: f.change, reason: clean(f.reason) })),
        api: t.api,
        models: t.models,
      })),
      writtenBy: `${result.provider}/${result.model}`,
      note: null,
    };
  } catch (err) {
    if (!(err instanceof AppError) || !QUIET_ERRORS.has(err.code)) throw err;
    return { tasks: null, writtenBy: null, note: `No tasks were written (${err.message}), so the plan lists the relevant files only.` };
  }
} // prettier-ignore

/** Without a model: one review task per relevant file, so order, tests and risk can still be shown. */
export function filesOnlyProposal(candidates: Candidate[]): ProposedTask[] {
  return candidates.slice(0, 8).map((c) => ({
    title: `Review ${c.path}`,
    description: null,
    files: [{ path: c.path, change: 'modify' as const, reason: null }],
    api: [],
    models: [],
  }));
}
