import type { ArchitectureGraph } from '@repointelligence/shared';
import { moduleOf } from './views.js';

/** Mermaid ids must be plain identifiers; labels are quoted and quotes escaped. */
export function mermaidId(text: string): string {
  return `n_${text.replace(/[^A-Za-z0-9_]/g, '_')}`.slice(0, 60);
}

function label(text: string): string {
  return `"${text.replace(/"/g, '#quot;')}"`;
}

const MAX_NODES = 60;
const MAX_EDGES = 120;

export function modulesDiagram(graph: ArchitectureGraph): string {
  const modules = new Map<string, number>();
  const moduleOfFile = new Map<string, string>();
  for (const file of graph.files) {
    const mod = moduleOf(file.path);
    moduleOfFile.set(file.path, mod);
    modules.set(mod, (modules.get(mod) ?? 0) + 1);
  }
  const top = [...modules.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_NODES);
  const keep = new Set(top.map(([m]) => m));
  const weights = new Map<string, number>();
  for (const edge of graph.imports) {
    if (!edge.to) continue;
    const a = moduleOfFile.get(edge.from);
    const b = moduleOfFile.get(edge.to);
    if (!a || !b || a === b || !keep.has(a) || !keep.has(b)) continue;
    weights.set(`${a}>${b}`, (weights.get(`${a}>${b}`) ?? 0) + 1);
  }
  const lines = ['flowchart LR'];
  for (const [mod, count] of top) lines.push(`  ${mermaidId(mod)}[${label(`${mod} (${count})`)}]`);
  for (const [key, weight] of [...weights.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_EDGES)) {
    const [a = '', b = ''] = key.split('>');
    lines.push(`  ${mermaidId(a)} -->|${weight}| ${mermaidId(b)}`);
  }
  return lines.join('\n');
}

export function layersDiagram(graph: ArchitectureGraph): string {
  const counts = new Map<string, number>();
  for (const file of graph.files) counts.set(file.layer, (counts.get(file.layer) ?? 0) + 1);
  const edges = new Map<string, { weight: number; violation: boolean }>();
  const layerOf = new Map(graph.files.map((f) => [f.path, f.layer] as const));
  const violations = new Set(graph.layerViolations.map((v) => `${v.fromLayer}>${v.toLayer}`));
  for (const edge of graph.imports) {
    if (!edge.to) continue;
    const a = layerOf.get(edge.from);
    const b = layerOf.get(edge.to);
    if (!a || !b || a === b) continue;
    const entry = edges.get(`${a}>${b}`) ?? { weight: 0, violation: violations.has(`${a}>${b}`) };
    entry.weight += 1;
    edges.set(`${a}>${b}`, entry);
  }
  const lines = ['flowchart TB'];
  for (const [layer, count] of counts)
    lines.push(`  ${mermaidId(layer)}[${label(`${layer} (${count} files)`)}]`);
  for (const [key, e] of edges) {
    const [a = '', b = ''] = key.split('>');
    lines.push(`  ${mermaidId(a)} ${e.violation ? '-.->' : '-->'}|${e.weight}| ${mermaidId(b)}`);
  }
  if (graph.layerViolations.length)
    lines.push(
      `  %% dotted edges import against the layer direction (${graph.layerViolations.length} file-level cases)`,
    );
  return lines.join('\n');
}

export function routesDiagram(graph: ArchitectureGraph): string {
  const lines = ['flowchart LR', `  client([${label('Client')}])`];
  const symbols = new Map(graph.symbols.map((s) => [s.id, s] as const));
  const handlerFiles = new Set<string>();
  for (const route of graph.routes.slice(0, MAX_NODES)) {
    const id = mermaidId(`${route.method}_${route.route}`);
    lines.push(`  ${id}[${label(`${route.method} ${route.route}`)}]`);
    lines.push(`  client --> ${id}`);
    for (const mw of route.middleware.slice(0, 3)) {
      lines.push(`  ${id} -.->|${mw}| ${id}`);
    }
    if (route.handler) {
      const symbol = symbols.get(route.handler);
      const target = symbol ? `${symbol.path}#${symbol.name}` : route.handler;
      const tid = mermaidId(target);
      if (!handlerFiles.has(tid)) {
        handlerFiles.add(tid);
        lines.push(
          `  ${tid}[[${label(symbol ? `${symbol.qualifiedName} (${symbol.path})` : route.handler)}]]`,
        );
      }
      lines.push(`  ${id} --> ${tid}`);
    }
  }
  if (graph.routes.length === 0) lines.push(`  none[${label('No routes detected')}]`);
  return lines.join('\n');
}

export function authDiagram(graph: ArchitectureGraph): string {
  const lines = ['flowchart LR', `  request([${label('Request')}])`];
  const byPath = new Map<string, string[]>();
  for (const item of graph.auth)
    byPath.set(item.path, [...(byPath.get(item.path) ?? []), `${item.kind}: ${item.label}`]);
  for (const [path, items] of [...byPath.entries()].slice(0, MAX_NODES)) {
    const id = mermaidId(path);
    lines.push(`  ${id}[${label(`${path}\n${[...new Set(items)].slice(0, 4).join('\n')}`)}]`);
    lines.push(`  request --> ${id}`);
  }
  const guarded = graph.routes.filter((r) =>
    r.middleware.some((m) => /auth|guard|protect|session|token|user/i.test(m)),
  );
  for (const route of guarded.slice(0, 20)) {
    const id = mermaidId(`${route.method}_${route.route}`);
    lines.push(`  ${id}[${label(`${route.method} ${route.route}`)}]`);
    lines.push(`  ${mermaidId(route.path)} -->|${route.middleware.join(', ')}| ${id}`);
  }
  if (byPath.size === 0) lines.push(`  none[${label('No authentication code detected')}]`);
  return lines.join('\n');
}

export function modelsDiagram(graph: ArchitectureGraph): string {
  const lines = ['flowchart LR'];
  const models = graph.models.filter((m) => m.kind === 'model').slice(0, MAX_NODES);
  const byId = new Map(graph.symbols.map((s) => [s.id, s] as const));
  for (const model of models)
    lines.push(
      `  ${mermaidId(`${model.path}_${model.name}`)}[(${label(`${model.name} · ${model.orm}`)})]`,
    );
  // Inheritance between model classes, when both ends are models.
  const modelKeys = new Set(models.map((m) => `${m.path}#${m.name}`));
  for (const rel of graph.relations) {
    if (rel.kind !== 'extends') continue;
    const from = byId.get(rel.from);
    const to = byId.get(rel.to);
    if (!from || !to) continue;
    if (modelKeys.has(`${from.path}#${from.name}`) && modelKeys.has(`${to.path}#${to.name}`)) {
      lines.push(
        `  ${mermaidId(`${from.path}_${from.name}`)} --> ${mermaidId(`${to.path}_${to.name}`)}`,
      );
    }
  }
  const migrations = graph.models.filter((m) => m.kind !== 'model');
  if (migrations.length)
    lines.push(`  migrations[${label(`${migrations.length} migration/schema file(s)`)}]`);
  if (models.length === 0) lines.push(`  none[${label('No data models detected')}]`);
  return lines.join('\n');
}

export const DIAGRAMS = {
  modules: modulesDiagram,
  layers: layersDiagram,
  routes: routesDiagram,
  auth: authDiagram,
  models: modelsDiagram,
} as const;
