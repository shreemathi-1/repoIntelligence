import mongoose from 'mongoose';
import type { Chunk } from '../ingest/types.js';
import { Artifact } from '../models/artifact.js';
import { ChunkEmbedding, VECTOR_INDEX_NAME } from '../models/chunk-embedding.js';
import { stem, termsOf } from './intent.js';

/** The most chunks ever embedded or searched for one commit; keeps M0 storage in check. */
export const MAX_INDEXED_CHUNKS = 2000;
const CACHE_SIZE = 4;
const VECTOR_CANDIDATES = 20;
const KEYWORD_CANDIDATES = 20;
const RRF_K = 60;
const MIN_SIMILARITY = 0.3;

export type Evidence = 'strong' | 'weak' | 'none';

export interface Retrieved {
  chunk: Chunk;
  score: number;
  sources: ('vector' | 'keyword')[];
}

export interface RetrieveOptions {
  fullName: string;
  sha: string;
  limit?: number;
  /** Extra terms that count double in the keyword pass. */
  boost?: string[];
  /** Skip the vector pass, for commits that have not been embedded. */
  useVectors?: boolean;
}

export interface RetrieveResult {
  chunks: Retrieved[];
  evidence: Evidence;
  /** Whether the vector pass ran; false when nothing is embedded or no embedder is available. */
  usedVectors: boolean;
}

export interface RetrieverOptions {
  /** Embeds the question. Returning null means "keyword search only". */
  embedQuery?: (text: string) => Promise<number[] | null>;
  /** Use Atlas $vectorSearch instead of scoring vectors in memory. */
  vectorSearch?: boolean;
}

/** A tiny most-recently-used cache; chat asks about the same commit many times in a row. */
class Recent<T> {
  private readonly map = new Map<string, T>();
  get(key: string): T | undefined {
    const value = this.map.get(key);
    if (value !== undefined) {
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }
  set(key: string, value: T): void {
    this.map.set(key, value);
    if (this.map.size > CACHE_SIZE) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }
  clear(): void {
    this.map.clear();
  }
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length && i < b.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

export interface Indexed {
  chunk: Chunk;
  terms: Map<string, number>;
  pathTerms: Set<string>;
  length: number;
}

/** Loads the chunks of one commit, with the keyword index built once. */
export async function loadChunks(fullName: string, sha: string): Promise<Chunk[]> {
  const rows = await Artifact.find({ fullName: fullName.toLowerCase(), sha, kind: 'chunk' })
    .sort({ order: 1 })
    .limit(MAX_INDEXED_CHUNKS)
    .lean();
  return rows.map((r) => r.data as Chunk);
}

export function indexChunks(chunks: Chunk[]): Indexed[] {
  return chunks.map((chunk) => {
    const terms = new Map<string, number>();
    const words = termsOf(`${chunk.heading?.join(' ') ?? ''} ${chunk.text}`);
    for (const w of chunk.text
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/[_\-./\\:]+/g, ' ')
      .toLowerCase()
      .match(/[a-z0-9]{2,}/g) ?? []) {
      const key = stem(w);
      terms.set(key, (terms.get(key) ?? 0) + 1);
    }
    return {
      chunk,
      terms,
      pathTerms: new Set(termsOf(chunk.provenance.path).map(stem)),
      length: Math.max(1, words.length),
    };
  });
}

/** TF-IDF style scoring; path matches count extra, boost terms count double. */
export function keywordScores(
  question: string,
  indexed: Indexed[],
  boost: string[] = [],
): { index: number; score: number }[] {
  const terms = termsOf(question).map(stem);
  const weights = new Map<string, number>(terms.map((t) => [t, 1]));
  for (const b of boost.map(stem)) weights.set(b, (weights.get(b) ?? 0) + 2);
  if (weights.size === 0) return [];
  const n = indexed.length;
  const df = new Map<string, number>();
  for (const term of weights.keys()) {
    df.set(term, indexed.filter((d) => d.terms.has(term) || d.pathTerms.has(term)).length);
  }
  const out: { index: number; score: number }[] = [];
  indexed.forEach((doc, i) => {
    let score = 0;
    for (const [term, weight] of weights) {
      const tf = doc.terms.get(term) ?? 0;
      const inPath = doc.pathTerms.has(term) ? 1 : 0;
      if (tf === 0 && inPath === 0) continue;
      const idf = Math.log(1 + n / (df.get(term) ?? 1));
      score += weight * idf * (Math.log(1 + tf) + inPath);
    }
    if (score > 0) out.push({ index: i, score: score / Math.sqrt(doc.length) });
  });
  return out.sort((a, b) => b.score - a.score);
}

export class HybridRetriever {
  private readonly chunkCache = new Recent<Indexed[]>();
  private readonly vectorCache = new Recent<Map<string, Float32Array>>();

  constructor(private readonly options: RetrieverOptions = {}) {}

  /** Forgets cached chunks and vectors for a commit, after re-ingesting or re-embedding. */
  invalidate(): void {
    this.chunkCache.clear();
    this.vectorCache.clear();
  }

  private async indexed(fullName: string, sha: string): Promise<Indexed[]> {
    const key = `${fullName.toLowerCase()}@${sha}`;
    const cached = this.chunkCache.get(key);
    if (cached) return cached;
    const built = indexChunks(await loadChunks(fullName, sha));
    this.chunkCache.set(key, built);
    return built;
  }

  private async vectors(fullName: string, sha: string): Promise<Map<string, Float32Array>> {
    const key = `${fullName.toLowerCase()}@${sha}`;
    const cached = this.vectorCache.get(key);
    if (cached) return cached;
    const rows = await ChunkEmbedding.find({ fullName: fullName.toLowerCase(), sha })
      .select('chunkId vector')
      .lean();
    const map = new Map(rows.map((r) => [r.chunkId, Float32Array.from(r.vector)]));
    this.vectorCache.set(key, map);
    return map;
  }

  /** Nearest chunk ids by cosine similarity, from Atlas or from memory. */
  private async nearest(
    fullName: string,
    sha: string,
    query: number[],
  ): Promise<{ chunkId: string; similarity: number }[]> {
    if (this.options.vectorSearch) {
      const rows = await mongoose.connection.db
        ?.collection('chunkembeddings')
        .aggregate<{ chunkId: string; similarity: number }>([
          {
            $vectorSearch: {
              index: VECTOR_INDEX_NAME,
              path: 'vector',
              queryVector: query,
              numCandidates: VECTOR_CANDIDATES * 10,
              limit: VECTOR_CANDIDATES,
              filter: { fullName: fullName.toLowerCase(), sha },
            },
          },
          { $project: { _id: 0, chunkId: 1, similarity: { $meta: 'vectorSearchScore' } } },
        ])
        .toArray();
      return rows ?? [];
    }
    const vectors = await this.vectors(fullName, sha);
    const scored: { chunkId: string; similarity: number }[] = [];
    for (const [chunkId, vector] of vectors)
      scored.push({ chunkId, similarity: cosine(query, vector) });
    return scored.sort((a, b) => b.similarity - a.similarity).slice(0, VECTOR_CANDIDATES);
  }

  async retrieve(question: string, options: RetrieveOptions): Promise<RetrieveResult> {
    const limit = options.limit ?? 8;
    const docs = await this.indexed(options.fullName, options.sha);
    if (docs.length === 0) return { chunks: [], evidence: 'none', usedVectors: false };
    const byId = new Map(docs.map((d, i) => [d.chunk.id, i]));

    const keyword = keywordScores(question, docs, options.boost).slice(0, KEYWORD_CANDIDATES);

    let vector: { index: number; similarity: number }[] = [];
    let usedVectors = false;
    const query =
      options.useVectors !== false && this.options.embedQuery
        ? await this.options.embedQuery(question).catch(() => null)
        : null;
    if (query) {
      const nearest = await this.nearest(options.fullName, options.sha, query);
      usedVectors = nearest.length > 0;
      vector = nearest.flatMap((n) => {
        const i = byId.get(n.chunkId);
        return i === undefined ? [] : [{ index: i, similarity: n.similarity }];
      });
    }

    return { ...rankChunks(docs, keyword, vector, limit), usedVectors };
  }
}

/**
 * Reciprocal rank fusion of the keyword and vector lists: a chunk high on either ranks high.
 * Evidence is "strong" when either pass found a convincing match.
 */
export function rankChunks(
  docs: Indexed[],
  keyword: { index: number; score: number }[],
  vector: { index: number; similarity: number }[],
  limit: number,
): { chunks: Retrieved[]; evidence: Evidence } {
  const fused = new Map<number, Retrieved>();
  const add = (index: number, rank: number, source: 'vector' | 'keyword') => {
    const doc = docs[index];
    if (!doc) return;
    const entry = fused.get(index) ?? { chunk: doc.chunk, score: 0, sources: [] };
    entry.score += 1 / (RRF_K + rank);
    entry.sources.push(source);
    fused.set(index, entry);
  };
  keyword.forEach((k, rank) => {
    add(k.index, rank, 'keyword');
  });
  vector.forEach((v, rank) => {
    if (v.similarity >= MIN_SIMILARITY) add(v.index, rank, 'vector');
  });
  const chunks = [...fused.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  const bestKeyword = keyword[0]?.score ?? 0;
  const bestVector = vector[0]?.similarity ?? 0;
  const evidence: Evidence =
    chunks.length === 0 ? 'none' : bestKeyword >= 1 || bestVector >= 0.6 ? 'strong' : 'weak';
  return { chunks, evidence };
}

/** Keyword-only retrieval over chunks already in memory. */
export function retrieveInMemory(
  question: string,
  chunks: Chunk[],
  options: { limit?: number; boost?: string[] } = {},
): { chunks: Retrieved[]; evidence: Evidence } {
  const docs = indexChunks(chunks);
  const keyword = keywordScores(question, docs, options.boost).slice(0, KEYWORD_CANDIDATES);
  return rankChunks(docs, keyword, [], options.limit ?? 8);
}
