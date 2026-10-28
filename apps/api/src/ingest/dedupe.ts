import { createHash } from 'node:crypto';
import type { Chunk } from './types.js';

const NEAR_DUPLICATE = 0.9;
const MIN_WORDS_FOR_NEAR = 30;

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function shingles(list: string[]): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + 3 <= list.length; i++) out.add(list.slice(i, i + 3).join(' '));
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const item of a) if (b.has(item)) shared += 1;
  return shared / (a.size + b.size - shared);
}

export interface DedupeResult {
  kept: Chunk[];
  removed: Chunk[];
}

/**
 * Removes exact and near-duplicate chunks. The first occurrence wins, so callers pass chunks
 * in priority order (README before other docs, docs before source). Each removed chunk points
 * at the one that was kept.
 */
export function dedupeChunks(chunks: Chunk[]): DedupeResult {
  const kept: Chunk[] = [];
  const removed: Chunk[] = [];
  const exact = new Map<string, Chunk>();
  // Near-duplicate candidates share a kind and a similar length, which keeps comparisons few.
  const buckets = new Map<string, { chunk: Chunk; grams: Set<string> }[]>();

  for (const chunk of chunks) {
    const tokens = words(chunk.text);
    const key = createHash('sha256')
      .update(`${chunk.kind}\0${tokens.join(' ')}`)
      .digest('hex');
    const same = exact.get(key);
    if (same) {
      removed.push({ ...chunk, duplicateOf: same.id });
      continue;
    }

    let original: Chunk | null = null;
    let grams: Set<string> | null = null;
    let bucket = 0;
    if (tokens.length >= MIN_WORDS_FOR_NEAR) {
      grams = shingles(tokens);
      bucket = Math.floor(Math.log(tokens.length) / Math.log(1.25));
      for (const near of [bucket - 1, bucket, bucket + 1]) {
        for (const candidate of buckets.get(`${chunk.kind}:${near}`) ?? []) {
          if (jaccard(grams, candidate.grams) >= NEAR_DUPLICATE) {
            original = candidate.chunk;
            break;
          }
        }
        if (original) break;
      }
    }

    if (original) {
      removed.push({ ...chunk, duplicateOf: original.id });
      continue;
    }
    exact.set(key, chunk);
    kept.push(chunk);
    if (grams) {
      const slot = `${chunk.kind}:${bucket}`;
      buckets.set(slot, [...(buckets.get(slot) ?? []), { chunk, grams }]);
    }
  }
  return { kept, removed };
}
