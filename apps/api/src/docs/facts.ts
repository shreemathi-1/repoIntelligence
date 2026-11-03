import type { ArchitectureGraph, Citation, RepoSummary } from '@repointelligence/shared';
import { AppError } from '../errors.js';
import type { GithubService, Viewer } from '../github/service.js';
import type { GraphService } from '../graph/service.js';
import { listTree } from '../graph/tree.js';
import type { ExportData } from '../ingest/exporters.js';
import type { IngestionService } from '../ingest/service.js';
import type { Chunk } from '../ingest/types.js';
import type { IngestionRun } from '../models/ingestion-run.js';

/** At most this many files are read in full for one document. */
export const MAX_FILE_READS = 20;
const MAX_FILE_CHARS = 64 * 1024;

/** Files that describe how a project is built, run, deployed and contributed to. */
export const DEPLOY_FILES =
  /^(Dockerfile(\..+)?|docker-compose(\.[\w-]+)?\.ya?ml|compose\.ya?ml|Procfile|render\.ya?ml|fly\.toml|vercel\.json|netlify\.toml|app\.ya?ml|railway\.(json|toml)|k8s\/.+\.ya?ml|kubernetes\/.+\.ya?ml|helm\/.+\/Chart\.yaml|\.github\/workflows\/[^/]+\.ya?ml|\.gitlab-ci\.yml|Makefile)$/; // prettier-ignore
export const CONTRIB_FILES =
  /^(\.github\/(PULL_REQUEST_TEMPLATE\.md|ISSUE_TEMPLATE\/.+)|commitlint\.config\.[cm]?js|\.commitlintrc(\..+)?|\.husky\/.+|\.pre-commit-config\.yaml|\.editorconfig|\.prettierrc(\..+)?|eslint\.config\.[cm]?js|\.eslintrc(\..+)?|ruff\.toml|pyproject\.toml|CODE_OF_CONDUCT\.md|SECURITY\.md|LICEN[CS]E(\..+)?)$/; // prettier-ignore

/** A slice of a real file at the pinned commit, used as model material and as a citation. */
export interface Excerpt {
  path: string;
  startLine: number;
  endLine: number;
  text: string;
}

export interface Facts {
  fullName: string;
  owner: string;
  name: string;
  sha: string;
  private: boolean;
  repo: RepoSummary;
  data: ExportData;
  graph: ArchitectureGraph | null;
  paths: string[];
  /** Reads a whole file at the commit; null when it is missing, binary or over the read budget. */
  read(path: string): Promise<string | null>;
}

export interface FactsDeps {
  github: GithubService;
  graphs: GraphService;
  ingestion: IngestionService;
}

export async function loadFacts(
  deps: FactsDeps,
  run: InstanceType<typeof IngestionRun>,
  viewer?: Viewer,
): Promise<Facts> {
  const [owner = '', name = ''] = run.fullName.split('/');
  const [{ repo }, data, graph, tree] = await Promise.all([
    deps.github.getRepo(owner, name, viewer),
    deps.ingestion.loadExportData(run),
    deps.graphs
      .load(run.fullName, run.sha)
      .then((g) => g.graph)
      .catch(() => null),
    listTree(deps.github, owner, name, run.sha, viewer).catch(() => ({
      paths: [],
      truncated: false,
    })),
  ]);
  const cache = new Map<string, Promise<string | null>>();
  const read = (path: string): Promise<string | null> => {
    const known = cache.get(path);
    if (known) return known;
    if (cache.size >= MAX_FILE_READS) return Promise.resolve(null);
    const pending = deps.graphs
      .source(owner, name, run.sha, path, viewer)
      .then((file) => file.content.slice(0, MAX_FILE_CHARS))
      .catch((err: unknown) => {
        if (err instanceof AppError && err.code === 'RATE_LIMITED') throw err;
        return null;
      });
    cache.set(path, pending);
    return pending;
  };
  return {
    fullName: run.fullName,
    owner,
    name,
    sha: run.sha,
    private: run.private,
    repo,
    data,
    graph,
    paths: tree.paths,
    read,
  };
}

// ---- helpers shared by the generators ---------------------------------------------------------------

/** The first line (1-based) of `text` that matches, or null. */
export function lineOf(text: string, match: string | RegExp, from = 1): number | null {
  const lines = text.split('\n');
  for (let i = Math.max(0, from - 1); i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (typeof match === 'string' ? line.includes(match) : match.test(line)) return i + 1;
  }
  return null;
}

/** Lines `start..end` of a file, clamped to its length. */
export function excerpt(path: string, text: string, start: number, end: number): Excerpt {
  const lines = text.split('\n');
  const startLine = Math.max(1, Math.min(start, lines.length));
  const endLine = Math.max(startLine, Math.min(end, lines.length));
  return { path, startLine, endLine, text: lines.slice(startLine - 1, endLine).join('\n') };
}

/** A few lines of context around one line. */
export function around(path: string, text: string, line: number, before = 2, after = 12): Excerpt {
  return excerpt(path, text, line - before, line + after);
}

export function cite(c: Pick<Citation, 'path' | 'startLine'> & { endLine?: number }): string {
  return `[[${c.path}:${c.startLine}-${c.endLine ?? c.startLine}]]`;
}

/** Excerpts become chunk-shaped evidence so the chat citation checker can validate them. */
export function asChunk(e: Excerpt, fullName: string, sha: string): Chunk {
  return {
    id: `${e.path}:${e.startLine}`,
    kind: 'source',
    provenance: { repo: fullName, sha, path: e.path, startLine: e.startLine, endLine: e.endLine },
    heading: null,
    language: null,
    text: e.text,
    tokens: Math.ceil(e.text.length / 4),
  };
}

/** The stored chunk that holds a given line of a file, as an excerpt. */
export function chunkAt(chunks: Chunk[], path: string, line: number): Excerpt | null {
  const hit = chunks.find(
    (c) =>
      c.provenance.path === path && c.provenance.startLine <= line && c.provenance.endLine >= line,
  );
  return hit
    ? {
        path,
        startLine: hit.provenance.startLine,
        endLine: hit.provenance.endLine,
        text: hit.text,
      }
    : null;
}

/** Escapes a value for a Markdown table cell. */
export function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim() || ' ';
}

export function table(header: string[], rows: string[][]): string {
  return [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`),
  ].join('\n');
}
