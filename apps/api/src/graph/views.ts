import type {
  ArchitectureGraph,
  FolderNode,
  GraphView,
  GraphViewResponse,
  Layer,
  ViewEdge,
  ViewNode,
} from '@repointelligence/shared';

const MAX_NODES = 400;
const MAX_EDGES = 1500;

/** The folder a file belongs to for the module view: its first two path segments. */
export function moduleOf(path: string): string {
  const parts = path.split('/');
  const dir = parts.slice(0, -1);
  if (dir.length === 0) return '(root)';
  // Skip the usual source wrapper so `src/routes/x.ts` and `routes/x.ts` group the same way.
  const start =
    ['src', 'lib', 'app', 'packages', 'apps', 'services'].includes(dir[0] ?? '') && dir.length > 1
      ? 1
      : 0;
  return dir.slice(0, start + 2).join('/') || '(root)';
}

function dominantLayer(layers: Layer[]): Layer | null {
  if (layers.length === 0) return null;
  const counts = new Map<Layer, number>();
  for (const layer of layers) counts.set(layer, (counts.get(layer) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

function cycleSet(graph: ArchitectureGraph): Set<string> {
  return new Set(graph.cycles.flat());
}

function violationSet(graph: ArchitectureGraph): Set<string> {
  return new Set(graph.layerViolations.map((v) => `${v.from}>${v.to}`));
}

export function buildView(
  graph: ArchitectureGraph,
  options: { view: GraphView; folder?: string; file?: string },
  identity: { fullName: string; sha: string },
): GraphViewResponse {
  const base = { fullName: identity.fullName, sha: identity.sha, view: options.view };
  if (options.view === 'modules') return { ...base, ...modulesView(graph) };
  if (options.view === 'files') return { ...base, ...filesView(graph, options.folder) };
  return { ...base, ...symbolsView(graph, options.file, options.folder) };
}

function modulesView(
  graph: ArchitectureGraph,
): Omit<GraphViewResponse, 'fullName' | 'sha' | 'view'> {
  const inCycle = cycleSet(graph);
  const violations = violationSet(graph);
  const byModule = new Map<string, { files: number; layers: Layer[]; cycle: boolean }>();
  const moduleOfFile = new Map<string, string>();
  for (const file of graph.files) {
    const mod = moduleOf(file.path);
    moduleOfFile.set(file.path, mod);
    const entry = byModule.get(mod) ?? { files: 0, layers: [], cycle: false };
    entry.files += 1;
    entry.layers.push(file.layer);
    if (inCycle.has(file.path)) entry.cycle = true;
    byModule.set(mod, entry);
  }
  const nodes: ViewNode[] = [...byModule.entries()].map(([id, m]) => ({
    id,
    label: id,
    kind: 'module',
    layer: dominantLayer(m.layers),
    size: m.files,
    path: id === '(root)' ? null : id,
    line: null,
    inCycle: m.cycle,
    detail: `${m.files} file${m.files === 1 ? '' : 's'}`,
  }));
  const weights = new Map<string, { weight: number; violation: boolean }>();
  for (const edge of graph.imports) {
    if (!edge.to) continue;
    const from = moduleOfFile.get(edge.from);
    const to = moduleOfFile.get(edge.to);
    if (!from || !to || from === to) continue;
    const key = `${from}>${to}`;
    const entry = weights.get(key) ?? { weight: 0, violation: false };
    entry.weight += 1;
    if (violations.has(`${edge.from}>${edge.to}`)) entry.violation = true;
    weights.set(key, entry);
  }
  const edges: ViewEdge[] = [...weights.entries()].map(([key, w]) => {
    const [from = '', to = ''] = key.split('>');
    return { id: key, from, to, kind: 'import', weight: w.weight, violation: w.violation };
  });
  return limit(nodes, edges);
}

function filesView(
  graph: ArchitectureGraph,
  folder?: string,
): Omit<GraphViewResponse, 'fullName' | 'sha' | 'view'> {
  const inCycle = cycleSet(graph);
  const violations = violationSet(graph);
  const prefix = folder ? `${folder.replace(/\/$/, '')}/` : '';
  const files = graph.files.filter((f) => !prefix || f.path.startsWith(prefix));
  const paths = new Set(files.map((f) => f.path));
  const nodes: ViewNode[] = files.map((f) => ({
    id: f.path,
    label: f.path.slice(prefix.length),
    kind: 'file',
    layer: f.layer,
    size: f.lines,
    path: f.path,
    line: 1,
    inCycle: inCycle.has(f.path),
    detail: `${f.lines} lines · ${f.symbols} symbols`,
  }));
  const seen = new Map<string, number>();
  for (const edge of graph.imports) {
    if (!edge.to || !paths.has(edge.from) || !paths.has(edge.to)) continue;
    const key = `${edge.from}>${edge.to}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const edges: ViewEdge[] = [...seen.entries()].map(([key, weight]) => {
    const [from = '', to = ''] = key.split('>');
    return { id: key, from, to, kind: 'import', weight, violation: violations.has(key) };
  });
  return limit(nodes, edges);
}

function symbolsView(
  graph: ArchitectureGraph,
  file?: string,
  folder?: string,
): Omit<GraphViewResponse, 'fullName' | 'sha' | 'view'> {
  const prefix = folder ? `${folder.replace(/\/$/, '')}/` : '';
  const own = graph.symbols.filter((s) =>
    file ? s.path === file : !prefix || s.path.startsWith(prefix),
  );
  const ownIds = new Set(own.map((s) => s.id));
  const related = new Set<string>();
  const edges: ViewEdge[] = [];
  for (const rel of graph.relations) {
    const touches = ownIds.has(rel.from) || ownIds.has(rel.to);
    if (!touches) continue;
    if (!ownIds.has(rel.from)) related.add(rel.from);
    if (!ownIds.has(rel.to)) related.add(rel.to);
    edges.push({
      id: `${rel.kind}:${rel.from}>${rel.to}`,
      from: rel.from,
      to: rel.to,
      kind: rel.kind,
      weight: 1,
      violation: false,
    });
  }
  const layerOf = new Map(graph.files.map((f) => [f.path, f.layer] as const));
  const byId = new Map(graph.symbols.map((s) => [s.id, s] as const));
  const nodes: ViewNode[] = [];
  for (const id of [...ownIds, ...related]) {
    const symbol = byId.get(id);
    if (symbol) {
      nodes.push({
        id,
        label: file
          ? symbol.qualifiedName
          : `${symbol.path.split('/').pop() ?? ''}: ${symbol.qualifiedName}`,
        kind: 'symbol',
        layer: layerOf.get(symbol.path) ?? null,
        size: 1,
        path: symbol.path,
        line: symbol.line,
        inCycle: false,
        detail: `${symbol.kind}${symbol.exported ? ', exported' : ''}`,
      });
    } else {
      nodes.push({
        id,
        label: id.replace(/^external:/, ''),
        kind: 'external',
        layer: null,
        size: 1,
        path: null,
        line: null,
        inCycle: false,
        detail: 'defined outside the repository',
      });
    }
  }
  return limit(nodes, edges);
}

/** Keeps the response bounded; the largest nodes stay, the rest are dropped with a flag. */
function limit(
  nodes: ViewNode[],
  edges: ViewEdge[],
): Omit<GraphViewResponse, 'fullName' | 'sha' | 'view'> {
  let truncated = false;
  let kept = nodes;
  if (nodes.length > MAX_NODES) {
    truncated = true;
    kept = [...nodes].sort((a, b) => b.size - a.size).slice(0, MAX_NODES);
  }
  const ids = new Set(kept.map((n) => n.id));
  let keptEdges = edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  if (keptEdges.length > MAX_EDGES) {
    truncated = true;
    keptEdges = [...keptEdges].sort((a, b) => b.weight - a.weight).slice(0, MAX_EDGES);
  }
  return { nodes: kept, edges: keptEdges, truncated };
}

const PURPOSES: [RegExp, string][] = [
  [
    /^(src\/)?(routes?|controllers?|handlers?|api|endpoints?)$/i,
    'HTTP routes and request handlers',
  ],
  [/^(src\/)?(pages|views|screens)$/i, 'Screens or pages shown to users'],
  [/^(src\/)?components$/i, 'Reusable interface components'],
  [/^(src\/)?(services?|domain|core|use-?cases?)$/i, 'Business logic'],
  [/^(src\/)?(models?|entities|schemas?)$/i, 'Data models and schemas'],
  [/^(src\/)?(repositor(y|ies)|dao|db|database|persistence)$/i, 'Database access'],
  [/^(src\/)?migrations?$|alembic|db\/migration/i, 'Database migrations'],
  [/^(src\/)?(clients?|adapters?|integrations?|gateways?)$/i, 'Integrations with external systems'],
  [/^(src\/)?(middleware|guards?|interceptors?)$/i, 'Request middleware'],
  [/^(src\/)?(auth|security)$/i, 'Authentication and authorisation'],
  [/^(src\/)?(utils?|helpers?|common|shared|lib)$/i, 'Shared helpers'],
  [/^(src\/)?(config|configs?|settings)$/i, 'Configuration'],
  [/^(tests?|__tests__|spec|e2e)$/i, 'Automated tests'],
  [/^(docs?)$/i, 'Documentation'],
  [/^(scripts?|bin|tools?)$/i, 'Scripts and tooling'],
  [/^\.github$/i, 'GitHub workflows and community files'],
  [/^(public|static|assets)$/i, 'Static assets'],
  [/^(src\/)?(hooks)$/i, 'React hooks'],
  [/^(src\/)?(stores?|state)$/i, 'Client state'],
  [/^(src\/)?(types?|interfaces?)$/i, 'Type definitions'],
];

export function purposeOf(path: string, layer: Layer | null): string | null {
  for (const [pattern, purpose] of PURPOSES) {
    if (pattern.test(path) || pattern.test(path.split('/').pop() ?? '')) return purpose;
  }
  if (layer && layer !== 'other') return `Mostly ${layer} code`;
  return null;
}

/** A folder tree of the parsed files with sizes, layers and a guessed purpose per folder. */
export function buildFolders(graph: ArchitectureGraph): FolderNode {
  const root: FolderNode = {
    path: '',
    name: '(root)',
    files: 0,
    lines: 0,
    layer: null,
    purpose: null,
    children: [],
  };
  const layersAt = new Map<string, Layer[]>();
  for (const file of graph.files) {
    const parts = file.path.split('/');
    let node = root;
    node.files += 1;
    node.lines += file.lines;
    let current = '';
    for (const part of parts.slice(0, -1)) {
      current = current ? `${current}/${part}` : part;
      let child = node.children.find((c) => c.name === part);
      if (!child) {
        child = {
          path: current,
          name: part,
          files: 0,
          lines: 0,
          layer: null,
          purpose: null,
          children: [],
        };
        node.children.push(child);
      }
      child.files += 1;
      child.lines += file.lines;
      layersAt.set(current, [...(layersAt.get(current) ?? []), file.layer]);
      node = child;
    }
  }
  const finish = (node: FolderNode): void => {
    node.layer = node.path ? dominantLayer(layersAt.get(node.path) ?? []) : null;
    node.purpose = node.path ? purposeOf(node.path, node.layer) : null;
    node.children.sort((a, b) => b.files - a.files || a.name.localeCompare(b.name));
    for (const child of node.children) finish(child);
  };
  finish(root);
  return root;
}
