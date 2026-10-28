import type { Chunk } from './types.js';

/**
 * Rough token count: about four characters per token, plus a 10% margin so budgets err on the
 * safe side. It is an estimate, not any particular model's tokenizer.
 */
export function estimateTokens(text: string): number {
  // Integer arithmetic: length / 4 * 1.1 rounds up wrongly through floating point.
  return Math.ceil((text.length * 11) / 40);
}

const KIND_PRIORITY: Record<Chunk['kind'], number> = {
  doc: 0,
  config: 1,
  manifest: 2,
  openapi: 3,
  symbol: 4,
  source: 5,
};

/** READMEs lead, then other docs, setup, manifests, API, symbols and finally raw source. */
function priority(chunk: Chunk): number {
  const readme = /(^|\/)readme(\.|$)/i.test(chunk.provenance.path) ? -1 : 0;
  return KIND_PRIORITY[chunk.kind] + readme;
}

export interface PackResult {
  chunks: Chunk[];
  tokens: number;
  omitted: number;
}

/** Picks chunks in priority order until the budget is used, keeping the original order within a kind. */
export function packChunks(chunks: Chunk[], budget: number): PackResult {
  const ordered = chunks
    .map((chunk, index) => ({ chunk, index }))
    .sort((a, b) => priority(a.chunk) - priority(b.chunk) || a.index - b.index);

  const picked: Chunk[] = [];
  let used = 0;
  for (const { chunk } of ordered) {
    // Keep scanning after a miss: a smaller chunk later on may still fit.
    if (used + chunk.tokens > budget) continue;
    picked.push(chunk);
    used += chunk.tokens;
  }
  return { chunks: picked, tokens: used, omitted: chunks.length - picked.length };
}
