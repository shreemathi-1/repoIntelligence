/** Shapes shared by the ingestion modules. Everything here is plain, serialisable data. */

export interface Provenance {
  repo: string;
  sha: string;
  path: string;
  startLine: number;
  endLine: number;
}

export type ChunkKind = 'doc' | 'openapi' | 'manifest' | 'config' | 'symbol' | 'source';

export interface Chunk {
  id: string;
  kind: ChunkKind;
  provenance: Provenance;
  /** Heading trail for documentation chunks. */
  heading: string[] | null;
  language: string | null;
  text: string;
  tokens: number;
  /** Set on chunks removed as duplicates, pointing at the one that was kept. */
  duplicateOf?: string;
}

export type Language = 'typescript' | 'javascript' | 'python' | 'java';

export interface MdTable {
  startLine: number;
  rows: string[][];
}

export interface MdCodeBlock {
  lang: string | null;
  code: string;
  startLine: number;
}

export interface MdSection {
  heading: string | null;
  level: number;
  trail: string[];
  slug: string | null;
  startLine: number;
  endLine: number;
  /** The section exactly as written, so tables and code blocks survive. */
  text: string;
  codeBlocks: MdCodeBlock[];
  tables: MdTable[];
}

export interface MdLink {
  text: string;
  href: string;
  line: number;
  kind: 'internal' | 'external' | 'anchor' | 'mailto';
  /** Resolved repository path for internal links. */
  target: string | null;
  status: 'ok' | 'broken' | 'unchecked';
  reason: string | null;
}

export interface MdAsset {
  alt: string;
  src: string;
  line: number;
  kind: 'internal' | 'external';
  target: string | null;
  /** null for external assets, which are not fetched. */
  exists: boolean | null;
  rawUrl: string | null;
}

export interface MdDocument {
  path: string;
  title: string | null;
  isReadme: boolean;
  sections: MdSection[];
  links: MdLink[];
  assets: MdAsset[];
}

export interface DocTag {
  tag: string;
  name: string | null;
  text: string;
}

export interface DocComment {
  summary: string;
  description: string;
  tags: DocTag[];
}

export interface CodeSymbol {
  name: string;
  qualifiedName: string;
  kind: 'function' | 'class' | 'interface' | 'type' | 'enum' | 'method' | 'const';
  signature: string;
  exported: boolean;
  doc: DocComment | null;
  language: Language;
  path: string;
  startLine: number;
  endLine: number;
  /** Extraction is pattern based, not a full parse. */
  approximate: true;
}

export interface OpenApiEndpoint {
  method: string;
  path: string;
  summary: string | null;
  operationId: string | null;
  tags: string[];
  parameters: { name: string; in: string; required: boolean }[];
  responses: string[];
}

export interface OpenApiDoc {
  path: string;
  specVersion: string;
  title: string | null;
  version: string | null;
  servers: string[];
  endpoints: OpenApiEndpoint[];
  schemaCount: number;
}

export interface ManifestDependency {
  name: string;
  spec: string;
  scope: 'runtime' | 'dev' | 'peer' | 'optional';
}

export interface Manifest {
  path: string;
  ecosystem: 'npm' | 'pypi' | 'maven' | 'go';
  name: string | null;
  version: string | null;
  dependencies: ManifestDependency[];
  scripts: Record<string, string>;
  engines: Record<string, string>;
}

export interface EnvVar {
  name: string;
  description: string | null;
  hasDefault: boolean;
  line: number;
}

export interface Finding {
  rule: string;
  severity: 'warning' | 'info';
  message: string;
  path: string;
  line: number | null;
  evidence: string;
}
