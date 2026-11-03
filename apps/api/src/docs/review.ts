import { z } from 'zod';
import type { DocReview } from '@repointelligence/shared';
import { AppError } from '../errors.js';
import type { LlmGateway } from '../llm/gateway.js';
import { DATA_RULES, noteBlock } from '../llm/prompts.js';
import { completeStructured } from '../llm/structured.js';
import { parseCitations } from '../rag/citations.js';
import { redactSecrets } from '../rag/redact.js';

type Issue = DocReview['issues'][number];

export interface ReviewContext {
  paths: Set<string>;
  scripts: Set<string>;
}

/** Checks that need no model: structure, links, commands, citations and placeholders. */
export function ruleIssues(markdown: string, ctx: ReviewContext): Issue[] {
  const issues: Issue[] = [];
  const lines = markdown.split('\n');
  const add = (rule: string, severity: Issue['severity'], message: string, line: number | null) =>
    issues.push({ rule, severity, message, line, source: 'rule' });
  const h1 = lines.filter((l) => /^#\s/.test(l)).length;
  if (h1 === 0) add('no-title', 'warning', 'The document has no top-level heading', null);
  if (h1 > 1) add('many-titles', 'info', `The document has ${h1} top-level headings`, null);
  let inCode = false;
  lines.forEach((line, i) => {
    const n = i + 1;
    if (/^\s*```/.test(line)) inCode = !inCode;
    if (!inCode && /\b(TODO|TBD|FIXME|lorem ipsum)\b/i.test(line)) add('placeholder', 'warning', 'Placeholder text left in', n);
    if (line.startsWith("_Not found in the repository")) add('empty-section', 'info', line.replace(/_/g, ''), n);
    for (const m of line.matchAll(/\b(?:npm|pnpm|yarn)\s+run\s+([\w:.-]+)/g)) {
      if (ctx.scripts.size > 0 && !ctx.scripts.has(m[1] ?? '')) add('unknown-script', 'error', `"${m[0]}" is not a script in package.json`, n);
    }
    for (const m of line.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = (m[1] ?? '').split('#')[0] ?? '';
      if (!target || /^(https?:|mailto:)/.test(target)) continue;
      const path = target.replace(/^\.\//, '');
      if (!ctx.paths.has(path) && !/^docs\/|^(README|CONTRIBUTING|CHANGELOG)\.md$/.test(path)) add('broken-link', 'warning', `Link to ${target}, which is not in the repository`, n);
    }
  });
  for (const c of parseCitations(markdown)) {
    if (!ctx.paths.has(c.path)) add('unknown-citation', 'error', `Cites ${c.path}, which is not in the repository at this commit`, null);
  }
  const prose = lines.filter((l) => l.trim() && !l.startsWith('#') && !l.startsWith('|') && !l.startsWith('>'));
  if (prose.length > 0 && parseCitations(markdown).length === 0) add('no-citations', 'warning', 'Nothing in the document is cited', null);
  return issues;
} // prettier-ignore

const modelSchema = z.object({
  accuracy: z.number().int().min(0).max(5),
  completeness: z.number().int().min(0).max(5),
  clarity: z.number().int().min(0).max(5),
  summary: z.string().max(1_000),
  issues: z
    .array(
      z.object({
        message: z.string().max(300),
        line: z.number().int().min(1).nullable().optional(),
      }),
    )
    .max(15),
});

export async function reviewDoc(
  gateway: LlmGateway,
  doc: { id: string; content: string; fullName: string },
  ctx: ReviewContext,
  models: { allowed: boolean; privateContent: boolean; userId: string },
): Promise<DocReview> {
  const issues = ruleIssues(doc.content, ctx);
  const penalty = issues.reduce((n, i) => n + (i.severity === 'error' ? 15 : i.severity === 'warning' ? 5 : 0), 0);
  let scores: DocReview['scores'] = { accuracy: null, completeness: null, clarity: null };
  let summary: string | null = null;
  let model: string | null = null;
  if (models.allowed) {
    try {
      const numbered = doc.content.split('\n').slice(0, 400).map((l, i) => `${i + 1}: ${l}`).join('\n');
      const { data, result } = await completeStructured(
        gateway,
        'structured',
        [
          { role: 'system', content: `You review documentation for a software repository. ${DATA_RULES} Score accuracy (claims are cited and plausible), completeness (a newcomer can get started) and clarity from 0 to 5, summarise in two sentences and list concrete issues with the document line they refer to. Reply with JSON: {"accuracy": 0, "completeness": 0, "clarity": 0, "summary": "", "issues": [{"message": "", "line": 1}]}.` },
          { role: 'user', content: noteBlock('document', redactSecrets(numbered)) },
        ],
        modelSchema,
        { privateContent: models.privateContent, userId: models.userId, fullName: doc.fullName },
      );
      model = `${result.provider}/${result.model}`;
      scores = { accuracy: data.accuracy, completeness: data.completeness, clarity: data.clarity };
      summary = data.summary;
      for (const i of data.issues) issues.push({ rule: 'review', severity: 'info', message: i.message, line: i.line ?? null, source: 'model' });
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
    }
  }
  const base = scores.accuracy === null ? 100 : Math.round(((scores.accuracy + (scores.completeness ?? 0) + (scores.clarity ?? 0)) / 15) * 100);
  return { docId: doc.id, score: Math.max(0, Math.min(100, base - penalty)), scores, issues, summary, model };
} // prettier-ignore
