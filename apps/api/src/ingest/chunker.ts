import { createHash } from 'node:crypto';
import { closesFence } from './util.js';
import { estimateTokens } from './tokens.js';
import type {
  Chunk,
  ChunkKind,
  CodeSymbol,
  EnvVar,
  Manifest,
  MdDocument,
  OpenApiDoc,
} from './types.js';

export interface ChunkContext {
  repo: string;
  sha: string;
  /** Largest chunk, in estimated tokens. */
  budget?: number;
}

export const DEFAULT_CHUNK_BUDGET = 800;

function make(
  ctx: ChunkContext,
  kind: ChunkKind,
  path: string,
  startLine: number,
  endLine: number,
  text: string,
  extra: { heading?: string[] | null; language?: string | null } = {},
): Chunk {
  const id = createHash('sha256')
    .update(`${kind}\0${path}\0${startLine}\0${text}`)
    .digest('hex')
    .slice(0, 16);
  return {
    id,
    kind,
    provenance: { repo: ctx.repo, sha: ctx.sha, path, startLine, endLine },
    heading: extra.heading ?? null,
    language: extra.language ?? null,
    text,
    tokens: estimateTokens(text),
    // Tokens are an estimate, so over-budget chunks are only split when clearly too big.
  };
}

interface Piece {
  text: string;
  startLine: number;
  endLine: number;
}

/**
 * Splits text that is over budget. Blocks are separated by blank lines, but a fenced code block
 * or a table is never cut in the middle unless a single block is itself over budget.
 */
export function splitToBudget(text: string, startLine: number, budget: number): Piece[] {
  if (estimateTokens(text) <= budget) {
    return [{ text, startLine, endLine: startLine + text.split('\n').length - 1 }];
  }

  const lines = text.split('\n');
  const blocks: { lines: string[]; start: number }[] = [];
  let current: { lines: string[]; start: number } = { lines: [], start: 0 };
  let fence: string | null = null;
  lines.forEach((line, index) => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) fence = fence === null ? marker : closesFence(fence, marker) ? null : fence;
    current.lines.push(line);
    const boundary = fence === null && line.trim() === '';
    if (boundary) {
      blocks.push(current);
      current = { lines: [], start: index + 1 };
    }
  });
  if (current.lines.length) blocks.push(current);

  const pieces: Piece[] = [];
  let group: { lines: string[]; start: number } | null = null;
  const emit = (): void => {
    if (!group) return;
    const body = group.lines.join('\n').replace(/\s+$/, '');
    if (body.trim()) {
      pieces.push({
        text: body,
        startLine: startLine + group.start,
        endLine: startLine + group.start + body.split('\n').length - 1,
      });
    }
    group = null;
  };

  for (const block of blocks) {
    const blockText = block.lines.join('\n');
    if (estimateTokens(blockText) > budget) {
      emit();
      // One huge block: fall back to cutting by lines.
      let part: string[] = [];
      let partStart = block.start;
      block.lines.forEach((line, i) => {
        if (part.length && estimateTokens([...part, line].join('\n')) > budget) {
          pieces.push({
            text: part.join('\n'),
            startLine: startLine + partStart,
            endLine: startLine + partStart + part.length - 1,
          });
          part = [];
          partStart = block.start + i;
        }
        part.push(line);
      });
      if (part.join('').trim()) {
        pieces.push({
          text: part.join('\n').replace(/\s+$/, ''),
          startLine: startLine + partStart,
          endLine: startLine + partStart + part.length - 1,
        });
      }
      continue;
    }
    const joined: string = group
      ? [...(group as { lines: string[] }).lines, ...block.lines].join('\n')
      : blockText;
    if (group && estimateTokens(joined) > budget) emit();
    if (!group) group = { lines: [...block.lines], start: block.start };
    else (group as { lines: string[] }).lines.push(...block.lines);
  }
  emit();
  return pieces;
}

export function chunkMarkdown(doc: MdDocument, ctx: ChunkContext): Chunk[] {
  const budget = ctx.budget ?? DEFAULT_CHUNK_BUDGET;
  const chunks: Chunk[] = [];
  for (const section of doc.sections) {
    const body = section.text
      .split('\n')
      .slice(section.heading ? 1 : 0)
      .join('\n')
      .trim();
    // A heading with nothing under it carries no information of its own.
    if (body === '') continue;
    for (const piece of splitToBudget(section.text, section.startLine, budget)) {
      chunks.push(
        make(ctx, 'doc', doc.path, piece.startLine, piece.endLine, piece.text, {
          heading: section.trail,
        }),
      );
    }
  }
  return chunks;
}

export function chunkOpenApi(doc: OpenApiDoc, ctx: ChunkContext): Chunk[] {
  return doc.endpoints.map((e) => {
    const params = e.parameters
      .map((p) => `${p.name} (${p.in}${p.required ? ', required' : ''})`)
      .join(', ');
    const text = [
      `${e.method} ${e.path}`,
      e.summary ? `Summary: ${e.summary}` : null,
      e.operationId ? `Operation: ${e.operationId}` : null,
      e.tags.length ? `Tags: ${e.tags.join(', ')}` : null,
      params ? `Parameters: ${params}` : null,
      e.responses.length ? `Responses: ${e.responses.join(', ')}` : null,
    ]
      .filter(Boolean)
      .join('\n');
    return make(ctx, 'openapi', doc.path, 1, 1, text, { heading: [doc.title ?? doc.path] });
  });
}

export function chunkManifest(manifest: Manifest, ctx: ChunkContext): Chunk {
  const lines = [`${manifest.ecosystem} manifest ${manifest.path}`];
  if (manifest.name)
    lines.push(`Name: ${manifest.name}${manifest.version ? ` ${manifest.version}` : ''}`);
  for (const [k, v] of Object.entries(manifest.engines)) lines.push(`Requires ${k} ${v}`);
  const scripts = Object.entries(manifest.scripts);
  if (scripts.length) lines.push('Scripts:', ...scripts.map(([k, v]) => `  ${k}: ${v}`));
  if (manifest.dependencies.length) {
    lines.push(
      'Dependencies:',
      ...manifest.dependencies.map((d) => `  ${d.name} ${d.spec} (${d.scope})`),
    );
  }
  return make(ctx, 'manifest', manifest.path, 1, 1, lines.join('\n'));
}

export function chunkEnv(vars: EnvVar[], path: string, ctx: ChunkContext): Chunk[] {
  if (vars.length === 0) return [];
  const text = [
    `Environment variables from ${path}`,
    ...vars.map(
      (v) =>
        `${v.name}${v.hasDefault ? '' : ' (no default)'}${v.description ? `: ${v.description}` : ''}`,
    ),
  ].join('\n');
  return [make(ctx, 'config', path, 1, vars[vars.length - 1]?.line ?? 1, text)];
}

function firstFilled(...values: (string | undefined)[]): string | null {
  return values.find((v) => v !== undefined && v !== '') ?? null;
}

/** The public API surface: one chunk per exported symbol, with its signature and documentation. */
export function chunkSymbols(symbols: CodeSymbol[], ctx: ChunkContext): Chunk[] {
  return symbols
    .filter((s) => s.exported)
    .map((s) => {
      const doc = s.doc;
      const text = [
        `${s.kind} ${s.qualifiedName}`,
        s.signature,
        firstFilled(doc?.description, doc?.summary),
        ...(doc?.tags.map((t) => `@${t.tag}${t.name ? ` ${t.name}` : ''} ${t.text}`.trim()) ?? []),
      ]
        .filter(Boolean)
        .join('\n');
      return make(ctx, 'symbol', s.path, s.startLine, s.endLine, text, { language: s.language });
    });
}

/** Moves a symbol's start up to include the comment or decorators directly above it. */
function startWithComment(lines: string[], symbolLine: number): number {
  let start = symbolLine;
  while (start > 1) {
    const above = lines[start - 2] ?? '';
    if (/^\s*(\*|\/\*|\*\/|\/\/|@\w|#)/.test(above) && above.trim() !== '') start -= 1;
    else break;
  }
  return start;
}

/** Source split at top-level symbols, so a chunk is a whole function or class where possible. */
export function chunkSource(
  source: string,
  symbols: CodeSymbol[],
  path: string,
  ctx: ChunkContext,
): Chunk[] {
  const budget = ctx.budget ?? DEFAULT_CHUNK_BUDGET;
  const lines = source.split(/\r?\n/);
  const language = symbols[0]?.language ?? null;

  const starts = [
    ...new Set(
      symbols
        .filter((s) => /^\S/.test(lines[s.startLine - 1] ?? ' '))
        .map((s) => startWithComment(lines, s.startLine)),
    ),
  ].sort((a, b) => a - b);

  const ranges: [number, number][] = [];
  let from = 1;
  for (const start of starts) {
    if (start > from) ranges.push([from, start - 1]);
    from = start;
  }
  ranges.push([from, lines.length]);

  const chunks: Chunk[] = [];
  for (const [a, b] of ranges) {
    const body = lines
      .slice(a - 1, b)
      .join('\n')
      .replace(/\s+$/, '');
    if (body.trim() === '') continue;
    for (const piece of splitToBudget(body, a, budget)) {
      chunks.push(
        make(ctx, 'source', path, piece.startLine, piece.endLine, piece.text, { language }),
      );
    }
  }
  return chunks;
}
