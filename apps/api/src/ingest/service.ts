import { z } from 'zod';
import {
  ingestStatsSchema,
  type Freshness,
  type Ingestion,
  type IngestStats,
} from '@repointelligence/shared';
import { AppError } from '../errors.js';
import type { GithubService, Viewer } from '../github/service.js';
import { Artifact, type ARTIFACT_KINDS } from '../models/artifact.js';
import { IngestionRun } from '../models/ingestion-run.js';
import {
  chunkEnv,
  chunkManifest,
  chunkMarkdown,
  chunkOpenApi,
  chunkSource,
  chunkSymbols,
} from './chunker.js';
import { checkConsistency } from './consistency.js';
import { dedupeChunks } from './dedupe.js';
import type { ExportData } from './exporters.js';
import { LIMITS, classifyPath, type FileKind } from './files.js';
import { parseEnvExample, parseManifest } from './manifests.js';
import {
  isReadmePath,
  missingDocuments,
  parseMarkdown,
  resolveDocument,
  type LinkContext,
} from './markdown.js';
import { parseOpenApi } from './openapi.js';
import { extractSymbols } from './symbols.js';
import type {
  Chunk,
  CodeSymbol,
  EnvVar,
  Language,
  Manifest,
  MdDocument,
  OpenApiDoc,
} from './types.js';

const COMMIT_SHA = /^[0-9a-f]{40}$/i;
const STALE_RUN_MS = 5 * 60_000;
const IMMUTABLE_MS = 24 * 60 * 60_000;

const commitSchema = z.object({
  sha: z.string(),
  commit: z.object({ tree: z.object({ sha: z.string() }) }),
});
const treeSchema = z.object({
  truncated: z.boolean(),
  tree: z.array(
    z.object({ path: z.string(), type: z.string(), sha: z.string(), size: z.number().optional() }),
  ),
});
// Blobs are decoded here. Content with a NUL byte is binary and is reported as null.
const blobSchema = z
  .object({ content: z.string(), encoding: z.string() })
  .transform(({ content, encoding }): string | null => {
    const bytes =
      encoding === 'base64' ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf8');
    return bytes.includes(0) ? null : bytes.toString('utf8');
  });
const compareSchema = z.object({ ahead_by: z.number().int().nonnegative() });

export interface IngestionServiceOptions {
  now?: () => number;
  /** Stop fetching new files after this long and return what was gathered. */
  maxMs?: number;
  concurrency?: number;
}

export interface IngestInput {
  owner: string;
  name: string;
  ref?: string;
  force?: boolean;
  userId: string;
  viewer?: Viewer;
}

interface ResolvedCommit {
  sha: string;
  treeSha: string;
  ref: string;
  private: boolean;
  defaultBranch: string;
}

interface Candidate {
  path: string;
  sha: string;
  size: number;
  kind: FileKind;
  language: Language | null;
}

const KIND_ORDER: Record<FileKind, number> = {
  markdown: 0,
  manifest: 1,
  env: 2,
  openapi: 3,
  source: 4,
  other: 5,
};

/** Runs `worker` over `items` with at most `limit` in flight, stopping early when told to. */
async function pool<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
  stop: () => boolean,
): Promise<number> {
  let next = 0;
  let started = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length && !stop()) {
      const item = items[next++] as T;
      started += 1;
      await worker(item);
    }
  });
  await Promise.all(lanes);
  return started;
}

export class IngestionService {
  private readonly now: () => number;
  private readonly maxMs: number;
  private readonly concurrency: number;

  constructor(
    private readonly github: GithubService,
    options: IngestionServiceOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.maxMs = options.maxMs ?? 60_000;
    this.concurrency = options.concurrency ?? 6;
  }

  async resolveCommit(
    owner: string,
    name: string,
    ref: string | undefined,
    viewer?: Viewer,
  ): Promise<ResolvedCommit> {
    const { repo } = await this.github.getRepo(owner, name, viewer);
    const target = ref ?? repo.defaultBranch;
    const { data } = await this.github.getJson(
      {
        route: 'GET /repos/{owner}/{repo}/commits/{ref}',
        params: { owner, repo: name, ref: target },
        schema: commitSchema,
        // A full SHA never changes; a branch name does.
        freshMs: COMMIT_SHA.test(target) ? IMMUTABLE_MS : 60_000,
      },
      viewer,
    );
    return {
      sha: data.sha,
      treeSha: data.commit.tree.sha,
      ref: target,
      private: repo.private,
      defaultBranch: repo.defaultBranch,
    };
  }

  async ingest(
    input: IngestInput,
  ): Promise<{ run: InstanceType<typeof IngestionRun>; reused: boolean }> {
    const { owner, name, viewer } = input;
    const commit = await this.resolveCommit(owner, name, input.ref, viewer);
    const fullName = `${owner}/${name}`.toLowerCase();

    const existing = await IngestionRun.findOne({ fullName, sha: commit.sha });
    if (existing && !input.force) {
      const fresh = existing.status === 'completed' || existing.status === 'partial';
      const busy =
        existing.status === 'running' && this.now() - existing.updatedAt.getTime() < STALE_RUN_MS;
      if (fresh || busy) return { run: existing, reused: true };
    }

    if (existing) await Artifact.deleteMany({ run: existing._id });
    const startedAt = new Date(this.now());
    const run = await IngestionRun.findOneAndUpdate(
      { fullName, sha: commit.sha },
      {
        $set: {
          ref: commit.ref,
          requestedBy: input.userId,
          private: commit.private,
          status: 'running',
          startedAt,
        },
        $unset: { stats: '', error: '', completedAt: '' },
      },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
    );

    try {
      const stats = await this.process(
        run._id,
        fullName,
        commit,
        owner,
        name,
        viewer,
        startedAt.getTime(),
      );
      run.status = stats.truncated.length > 0 ? 'partial' : 'completed';
      run.stats = stats;
      run.completedAt = new Date(this.now());
    } catch (err) {
      run.status = 'failed';
      run.error = err instanceof AppError ? `${err.code}: ${err.message}` : 'Ingestion failed';
      run.completedAt = new Date(this.now());
      await run.save();
      throw err;
    }
    await run.save();
    return { run, reused: false };
  }

  private async blob(
    owner: string,
    name: string,
    sha: string,
    viewer?: Viewer,
  ): Promise<string | null> {
    const { data } = await this.github.getJson(
      {
        route: 'GET /repos/{owner}/{repo}/git/blobs/{file_sha}',
        params: { owner, repo: name, file_sha: sha },
        schema: blobSchema,
        cache: false,
      },
      viewer,
    );
    return data;
  }

  private async process(
    runId: unknown,
    fullName: string,
    commit: ResolvedCommit,
    owner: string,
    name: string,
    viewer: Viewer | undefined,
    startedMs: number,
  ): Promise<IngestStats> {
    const truncated = new Set<string>();
    const skipped: Record<string, number> = {};
    const skip = (reason: string, count = 1): void => {
      skipped[reason] = (skipped[reason] ?? 0) + count;
    };

    const { data: tree } = await this.github.getJson(
      {
        route: 'GET /repos/{owner}/{repo}/git/trees/{tree_sha}',
        params: { owner, repo: name, tree_sha: commit.treeSha, recursive: '1' },
        schema: treeSchema,
        freshMs: IMMUTABLE_MS,
      },
      viewer,
    );
    if (tree.truncated) truncated.add('tree-truncated');

    const blobs = tree.tree.filter((e) => e.type === 'blob');
    const paths = new Set(blobs.map((b) => b.path));
    const dirs = new Set<string>();
    for (const p of paths) {
      const parts = p.split('/').slice(0, -1);
      parts.forEach((_, i) => dirs.add(parts.slice(0, i + 1).join('/')));
    }

    // Decide what to fetch: documents first, raw source last, within the limits.
    const candidates: Candidate[] = [];
    for (const blob of blobs) {
      const cls = classifyPath(blob.path);
      if (!cls.include) {
        if (cls.reason) skip(cls.reason);
        continue;
      }
      if ((blob.size ?? 0) > LIMITS.maxFileBytes) {
        skip('too-large');
        continue;
      }
      candidates.push({
        path: blob.path,
        sha: blob.sha,
        size: blob.size ?? 0,
        kind: cls.kind,
        language: cls.language,
      });
    }
    // The README goes before every other document, so a short time budget still keeps it.
    candidates.sort(
      (a, b) =>
        KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
        Number(isReadmePath(b.path)) - Number(isReadmePath(a.path)) ||
        a.path.localeCompare(b.path),
    );

    const selected: Candidate[] = [];
    let bytes = 0;
    let sources = 0;
    for (const c of candidates) {
      if (selected.length >= LIMITS.maxFiles) {
        skip('limit');
        truncated.add('file-limit');
        continue;
      }
      if (c.kind === 'source' && sources >= LIMITS.maxSourceFiles) {
        skip('limit');
        truncated.add('file-limit');
        continue;
      }
      if (bytes + c.size > LIMITS.maxTotalBytes) {
        skip('too-large');
        truncated.add('size-limit');
        continue;
      }
      selected.push(c);
      bytes += c.size;
      if (c.kind === 'source') sources += 1;
    }

    const contents = new Map<string, string>();
    const deadline = startedMs + this.maxMs;
    const started = await pool(
      selected,
      this.concurrency,
      async (file) => {
        try {
          const text = await this.blob(owner, name, file.sha, viewer);
          if (text === null) skip('binary');
          else contents.set(file.path, text);
        } catch (err) {
          // A rate limit would hit every later call too, so it ends the run.
          if (err instanceof AppError && err.code === 'RATE_LIMITED') throw err;
          skip('fetch-failed');
        }
      },
      () => this.now() > deadline,
    );
    if (started < selected.length) {
      skip('time-limit', selected.length - started);
      truncated.add('time-limit');
    }

    // Parse everything that was read.
    const kindOf = new Map(selected.map((c) => [c.path, c] as const));
    const parsed = [...contents.entries()]
      .filter(([path]) => kindOf.get(path)?.kind === 'markdown')
      .map(([path, text]) => ({ text, parsed: parseMarkdown(text, path) }));
    const anchors = new Map(
      parsed.map(
        (p) =>
          [
            p.parsed.path,
            new Set(p.parsed.sections.flatMap((s) => (s.slug ? [s.slug] : []))),
          ] as const,
      ),
    );
    const ctx: LinkContext = { repo: fullName, sha: commit.sha, paths, dirs, anchors };
    // Fetches finish in any order; sort so results are the same on every run, README first.
    const docs = parsed
      .map((p) => ({ doc: resolveDocument(p.parsed, ctx), text: p.text }))
      .sort(
        (a, b) =>
          Number(b.doc.isReadme) - Number(a.doc.isReadme) || a.doc.path.localeCompare(b.doc.path),
      );

    const manifests: Manifest[] = [];
    const envExamples: { path: string; vars: EnvVar[] }[] = [];
    const openApi: OpenApiDoc[] = [];
    const symbols: CodeSymbol[] = [];
    const sources_ = new Map<string, string>();
    const sourceChunks: Chunk[] = [];
    const chunkCtx = { repo: fullName, sha: commit.sha };

    for (const [path, text] of contents) {
      const file = kindOf.get(path);
      if (!file) continue;
      if (file.kind === 'manifest') {
        const m = parseManifest(text, path);
        if (m) manifests.push(m);
        else skip('unparseable');
      } else if (file.kind === 'env') {
        envExamples.push({ path, vars: parseEnvExample(text) });
      } else if (file.kind === 'openapi') {
        const spec = parseOpenApi(text, path);
        if (spec) openApi.push(spec);
        else skip('unparseable');
      } else if (file.kind === 'source' && file.language) {
        const found = extractSymbols(text, path, file.language);
        symbols.push(...found);
        sources_.set(path, text);
        sourceChunks.push(...chunkSource(text, found, path, chunkCtx));
      }
    }

    const findings = checkConsistency({
      docs,
      sources: sources_,
      manifests,
      envExamples,
      openApi,
      paths,
      dirs,
    });
    const missing = missingDocuments([...paths].filter((p) => !p.includes('/')));

    // Chunks in priority order: README first, then other docs, setup, manifests, API, symbols, source.
    const allChunks: Chunk[] = [
      ...docs.flatMap((d) => chunkMarkdown(d.doc, chunkCtx)),
      ...envExamples.flatMap((e) => chunkEnv(e.vars, e.path, chunkCtx)),
      ...manifests.map((m) => chunkManifest(m, chunkCtx)),
      ...openApi.flatMap((o) => chunkOpenApi(o, chunkCtx)),
      ...chunkSymbols(symbols, chunkCtx),
      ...sourceChunks,
    ];
    const { kept, removed } = dedupeChunks(allChunks);

    let order = 0;
    const rows: { kind: (typeof ARTIFACT_KINDS)[number]; path: string; data: unknown }[] = [
      ...docs.map((d) => ({ kind: 'document' as const, path: d.doc.path, data: d.doc })),
      ...openApi.map((o) => ({ kind: 'openapi' as const, path: o.path, data: o })),
      ...manifests.map((m) => ({ kind: 'manifest' as const, path: m.path, data: m })),
      ...envExamples.map((e) => ({ kind: 'env' as const, path: e.path, data: e })),
      { kind: 'symbols' as const, path: '', data: symbols },
      { kind: 'findings' as const, path: '', data: findings },
      { kind: 'meta' as const, path: '', data: { missingDocuments: missing } },
      ...kept.map((c) => ({ kind: 'chunk' as const, path: c.provenance.path, data: c })),
    ];
    for (let i = 0; i < rows.length; i += 500) {
      await Artifact.insertMany(
        rows.slice(i, i + 500).map((r) => ({
          run: runId,
          fullName,
          sha: commit.sha,
          kind: r.kind,
          path: r.path,
          order: order++,
          data: r.data,
        })),
      );
    }

    return {
      filesInTree: blobs.length,
      filesIngested: contents.size,
      bytesIngested: [...contents.values()].reduce((sum, t) => sum + Buffer.byteLength(t), 0),
      skipped,
      chunks: kept.length,
      duplicatesRemoved: removed.length,
      symbols: symbols.length,
      brokenLinks: findings.filter((f) => f.rule === 'broken-link').length,
      findings: findings.length,
      durationMs: Math.max(0, this.now() - startedMs),
      truncated: [...truncated],
    };
  }

  /** Rebuilds everything an export needs from the stored artifacts of one run. */
  async loadExportData(run: InstanceType<typeof IngestionRun>): Promise<ExportData> {
    const rows = await Artifact.find({ run: run._id }).sort({ order: 1 }).lean();
    const of = <T>(kind: string): T[] =>
      rows.filter((r) => r.kind === kind).map((r) => r.data as T);
    const meta = of<{ missingDocuments: ExportData['missingDocuments'] }>('meta')[0];
    return {
      repo: run.fullName,
      sha: run.sha,
      ref: run.ref ?? null,
      generatedAt: (run.completedAt ?? run.updatedAt).toISOString(),
      docs: of<MdDocument>('document'),
      openApi: of<OpenApiDoc>('openapi'),
      manifests: of<Manifest>('manifest'),
      envExamples: of<{ path: string; vars: EnvVar[] }>('env'),
      symbols: of<CodeSymbol[]>('symbols').flat(),
      findings: of<ExportData['findings']>('findings').flat(),
      missingDocuments: meta?.missingDocuments ?? [],
      chunks: of<Chunk>('chunk'),
    };
  }

  async freshness(owner: string, name: string, viewer?: Viewer): Promise<Freshness> {
    const fullName = `${owner}/${name}`.toLowerCase();
    const latest = await IngestionRun.findOne({
      fullName,
      status: { $in: ['completed', 'partial'] },
    }).sort({ completedAt: -1 });
    let headSha: string | null = null;
    try {
      headSha = (await this.resolveCommit(owner, name, undefined, viewer)).sha;
    } catch (err) {
      if (err instanceof AppError && err.code === 'RATE_LIMITED') throw err;
    }
    if (!latest) {
      return { ingestedSha: null, ingestedAt: null, headSha, fresh: null, commitsBehind: null };
    }
    let commitsBehind: number | null = null;
    if (headSha && headSha !== latest.sha) {
      try {
        const { data } = await this.github.getJson(
          {
            route: 'GET /repos/{owner}/{repo}/compare/{basehead}',
            params: { owner, repo: name, basehead: `${latest.sha}...${headSha}` },
            schema: compareSchema,
            freshMs: 60_000,
          },
          viewer,
        );
        commitsBehind = data.ahead_by;
      } catch (err) {
        if (err instanceof AppError && err.code === 'RATE_LIMITED') throw err;
      }
    }
    return {
      ingestedSha: latest.sha,
      ingestedAt: (latest.completedAt ?? latest.updatedAt).toISOString(),
      headSha,
      fresh: headSha === null ? null : headSha === latest.sha,
      commitsBehind: headSha === latest.sha ? 0 : commitsBehind,
    };
  }
}

/** The stored statistics, typed. The database field is untyped. */
export function statsOf(run: InstanceType<typeof IngestionRun>): IngestStats | null {
  const parsed = ingestStatsSchema.safeParse(run.stats);
  return parsed.success ? parsed.data : null;
}

export function toIngestion(run: InstanceType<typeof IngestionRun>, reused: boolean): Ingestion {
  return {
    fullName: run.fullName,
    sha: run.sha,
    ref: run.ref ?? null,
    status: run.status,
    private: run.private,
    startedAt: run.startedAt.toISOString(),
    completedAt: run.completedAt?.toISOString() ?? null,
    stats: statsOf(run),
    error: run.error ?? null,
    reused,
  };
}
