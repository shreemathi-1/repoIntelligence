import { z } from 'zod';

export const GRAPH_LANGUAGES = ['javascript', 'typescript', 'python', 'java'] as const;
export const LAYERS = [
  'presentation',
  'service',
  'data',
  'integration',
  'config',
  'test',
  'other',
] as const;
export type Layer = (typeof LAYERS)[number];

export const graphFileSchema = z.object({
  path: z.string(),
  language: z.enum(GRAPH_LANGUAGES),
  lines: z.number().int().nonnegative(),
  layer: z.enum(LAYERS),
  symbols: z.number().int().nonnegative(),
  imports: z.number().int().nonnegative(),
  importedBy: z.number().int().nonnegative(),
});
export type GraphFile = z.infer<typeof graphFileSchema>;

export const importEdgeSchema = z.object({
  from: z.string(),
  // A repository file, or null when the import is external or could not be resolved.
  to: z.string().nullable(),
  external: z.string().nullable(),
  line: z.number().int().nonnegative(),
  names: z.array(z.string()),
  via: z.string().nullable(),
});
export type ImportEdge = z.infer<typeof importEdgeSchema>;

export const SYMBOL_KINDS = ['function', 'class', 'method', 'interface', 'type', 'enum'] as const;
export const graphSymbolSchema = z.object({
  id: z.string(),
  path: z.string(),
  name: z.string(),
  qualifiedName: z.string(),
  kind: z.enum(SYMBOL_KINDS),
  line: z.number().int().nonnegative(),
  endLine: z.number().int().nonnegative(),
  exported: z.boolean(),
});
export type GraphSymbol = z.infer<typeof graphSymbolSchema>;

export const relationSchema = z.object({
  from: z.string(),
  // A symbol id, or `external:Name` for a parent defined outside the repository.
  to: z.string(),
  kind: z.enum(['call', 'extends']),
  line: z.number().int().nonnegative(),
  // Edges are matched by name, not by type information.
  resolution: z.enum(['same-file', 'import', 'name']),
});
export type Relation = z.infer<typeof relationSchema>;

export const detectionSchema = z.object({
  kind: z.string(),
  path: z.string(),
  line: z.number().int().nonnegative().nullable(),
  label: z.string(),
  evidence: z.string(),
});
export type Detection = z.infer<typeof detectionSchema>;

export const routeSchema = z.object({
  method: z.string(),
  route: z.string(),
  path: z.string(),
  line: z.number().int().nonnegative(),
  framework: z.string(),
  handler: z.string().nullable(),
  middleware: z.array(z.string()),
});
export type GraphRoute = z.infer<typeof routeSchema>;

export const modelSchema = z.object({
  name: z.string(),
  path: z.string(),
  line: z.number().int().nonnegative().nullable(),
  orm: z.string(),
  kind: z.enum(['model', 'migration', 'schema']),
});
export type GraphModel = z.infer<typeof modelSchema>;

export const stackItemSchema = z.object({
  name: z.string(),
  category: z.enum(['language', 'framework', 'library', 'database', 'tooling', 'testing']),
  version: z.string().nullable(),
  evidence: z.string(),
});
export type StackItem = z.infer<typeof stackItemSchema>;

export const layerViolationSchema = z.object({
  from: z.string(),
  to: z.string(),
  fromLayer: z.enum(LAYERS),
  toLayer: z.enum(LAYERS),
  line: z.number().int().nonnegative(),
});

export const graphStatsSchema = z.object({
  filesParsed: z.number().int().nonnegative(),
  filesSkipped: z.number().int().nonnegative(),
  parseErrors: z.number().int().nonnegative(),
  truncated: z.boolean(),
  callEdgesTruncated: z.boolean(),
  durationMs: z.number().int().nonnegative(),
});

/** What the worker returns and what is stored, per repository and commit. */
export const architectureGraphSchema = z.object({
  archiveFiles: z.number().int().nonnegative().optional(),
  files: z.array(graphFileSchema),
  externals: z.array(z.string()),
  imports: z.array(importEdgeSchema),
  symbols: z.array(graphSymbolSchema),
  relations: z.array(relationSchema),
  entryPoints: z.array(detectionSchema),
  routes: z.array(routeSchema),
  models: z.array(modelSchema),
  auth: z.array(detectionSchema),
  stack: z.array(stackItemSchema),
  layerViolations: z.array(layerViolationSchema),
  cycles: z.array(z.array(z.string())),
  stats: graphStatsSchema,
});
export type ArchitectureGraph = z.infer<typeof architectureGraphSchema>;

// ---- read models -----------------------------------------------------------------------------------

export const GRAPH_VIEWS = ['modules', 'files', 'symbols'] as const;
export type GraphView = (typeof GRAPH_VIEWS)[number];

export const graphQuerySchema = z.object({
  view: z.enum(GRAPH_VIEWS).default('modules'),
  // Only nodes under this folder (files and symbols views).
  folder: z.string().max(500).optional(),
  // Only this file's symbols and their direct relations (symbols view).
  file: z.string().max(500).optional(),
});

export const viewNodeSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum(['module', 'file', 'symbol', 'external']),
  layer: z.enum(LAYERS).nullable(),
  // Module: file count. File: lines. Symbol: 1.
  size: z.number().int().nonnegative(),
  path: z.string().nullable(),
  line: z.number().int().nonnegative().nullable(),
  inCycle: z.boolean(),
  detail: z.string().nullable(),
});
export type ViewNode = z.infer<typeof viewNodeSchema>;

export const viewEdgeSchema = z.object({
  id: z.string(),
  from: z.string(),
  to: z.string(),
  kind: z.enum(['import', 'call', 'extends']),
  weight: z.number().int().positive(),
  violation: z.boolean(),
});
export type ViewEdge = z.infer<typeof viewEdgeSchema>;

export const graphViewResponseSchema = z.object({
  fullName: z.string(),
  sha: z.string(),
  view: z.enum(GRAPH_VIEWS),
  nodes: z.array(viewNodeSchema),
  edges: z.array(viewEdgeSchema),
  // Nodes beyond the response limit are folded into their parent folder.
  truncated: z.boolean(),
});
export type GraphViewResponse = z.infer<typeof graphViewResponseSchema>;

export const folderNodeSchema: z.ZodType<FolderNode> = z.lazy(() =>
  z.object({
    path: z.string(),
    name: z.string(),
    files: z.number().int().nonnegative(),
    lines: z.number().int().nonnegative(),
    layer: z.enum(LAYERS).nullable(),
    // What the folder is for, from its name and contents. Null when nothing stands out.
    purpose: z.string().nullable(),
    children: z.array(folderNodeSchema),
  }),
);
export interface FolderNode {
  path: string;
  name: string;
  files: number;
  lines: number;
  layer: Layer | null;
  purpose: string | null;
  children: FolderNode[];
}

export const graphSummarySchema = z.object({
  fullName: z.string(),
  sha: z.string(),
  computedAt: z.string(),
  stats: graphStatsSchema,
  stack: z.array(stackItemSchema),
  entryPoints: z.array(detectionSchema),
  routes: z.array(routeSchema),
  models: z.array(modelSchema),
  auth: z.array(detectionSchema),
  cycles: z.array(z.array(z.string())),
  layerViolations: z.array(layerViolationSchema),
  layers: z.record(z.enum(LAYERS), z.number().int().nonnegative()),
  folders: folderNodeSchema,
  // Every detection is pattern based.
  detected: z.literal(true),
});
export type GraphSummary = z.infer<typeof graphSummarySchema>;

export const MERMAID_DIAGRAMS = ['modules', 'layers', 'routes', 'auth', 'models'] as const;
export const mermaidQuerySchema = z.object({
  diagram: z.enum(MERMAID_DIAGRAMS).default('modules'),
});

export const traceQuerySchema = z.object({
  // "GET /orders" or a handler symbol id.
  route: z.string().min(1).max(300),
  depth: z.coerce.number().int().min(1).max(8).default(5),
});

export const traceStepSchema = z.object({
  id: z.string(),
  label: z.string(),
  path: z.string(),
  line: z.number().int().nonnegative().nullable(),
  layer: z.enum(LAYERS).nullable(),
  // 'route' for the entry, 'call' for a step through code, 'model' when it reaches persistence.
  kind: z.enum(['route', 'middleware', 'call', 'model']),
  depth: z.number().int().nonnegative(),
});

export const traceResponseSchema = z.object({
  route: routeSchema.nullable(),
  steps: z.array(traceStepSchema),
  // Models the trace reached, directly or through calls.
  models: z.array(modelSchema),
  truncated: z.boolean(),
  // The trace follows name-resolved call edges; dynamic dispatch and framework glue are invisible.
  approximate: z.literal(true),
});
export type TraceResponse = z.infer<typeof traceResponseSchema>;

export const graphDiffQuerySchema = z.object({
  from: z.string().regex(/^[0-9a-f]{40}$/i),
  to: z.string().regex(/^[0-9a-f]{40}$/i),
});

const changedListSchema = z.object({ added: z.array(z.string()), removed: z.array(z.string()) });

export const graphDiffSchema = z.object({
  from: z.string(),
  to: z.string(),
  files: changedListSchema,
  modules: changedListSchema,
  imports: z.object({
    added: z.array(z.object({ from: z.string(), to: z.string() })),
    removed: z.array(z.object({ from: z.string(), to: z.string() })),
  }),
  externals: changedListSchema,
  routes: changedListSchema,
  models: changedListSchema,
  cycles: z.object({
    introduced: z.array(z.array(z.string())),
    resolved: z.array(z.array(z.string())),
  }),
  layerChanges: z.array(z.object({ path: z.string(), from: z.enum(LAYERS), to: z.enum(LAYERS) })),
  violations: z.object({ before: z.number().int(), after: z.number().int() }),
  stats: z.object({ filesBefore: z.number().int(), filesAfter: z.number().int() }),
});
export type GraphDiff = z.infer<typeof graphDiffSchema>;

export const sourceFileSchema = z.object({
  path: z.string(),
  sha: z.string(),
  content: z.string(),
  language: z.string().nullable(),
  truncated: z.boolean(),
  bytes: z.number().int().nonnegative(),
});
export type SourceFile = z.infer<typeof sourceFileSchema>;

export const graphRunSchema = z.object({
  id: z.string(),
  fullName: z.string(),
  sha: z.string().nullable(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']),
  progress: z.object({ step: z.string(), percent: z.number(), message: z.string() }),
  error: z.string().nullable(),
  reused: z.boolean(),
  summary: graphSummarySchema.nullable(),
});
export type GraphRun = z.infer<typeof graphRunSchema>;
