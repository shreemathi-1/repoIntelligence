import type {
  ArchitectureGraph,
  GraphModel,
  GraphRoute,
  TraceResponse,
} from '@repointelligence/shared';

const MAX_STEPS = 60;

/**
 * Follows call edges from a route's handler, breadth first, and notes which data models the
 * reached files define. The result is only as good as the name-resolved call graph.
 */
export function traceRoute(graph: ArchitectureGraph, query: string, depth: number): TraceResponse {
  const route = findRoute(graph, query);
  const symbols = new Map(graph.symbols.map((s) => [s.id, s] as const));
  const layerOf = new Map(graph.files.map((f) => [f.path, f.layer] as const));
  const steps: TraceResponse['steps'] = [];
  const modelsByFile = new Map<string, GraphModel[]>();
  for (const model of graph.models)
    modelsByFile.set(model.path, [...(modelsByFile.get(model.path) ?? []), model]);

  const start: string | null = route?.handler ?? (symbols.has(query) ? query : null);
  if (route) {
    steps.push({
      id: `route:${route.method} ${route.route}`,
      label: `${route.method} ${route.route}`,
      path: route.path,
      line: route.line,
      layer: layerOf.get(route.path) ?? null,
      kind: 'route',
      depth: 0,
    });
    for (const mw of route.middleware) {
      const symbol = graph.symbols.find((s) => s.name === mw);
      steps.push({
        id: `mw:${mw}`,
        label: mw,
        path: symbol?.path ?? route.path,
        line: symbol?.line ?? route.line,
        layer: symbol ? (layerOf.get(symbol.path) ?? null) : null,
        kind: 'middleware',
        depth: 0,
      });
    }
  }

  const reached: GraphModel[] = [];
  const seenModels = new Set<string>();
  const noteModels = (path: string): void => {
    for (const model of modelsByFile.get(path) ?? []) {
      const key = `${model.path}#${model.name}`;
      if (!seenModels.has(key)) {
        seenModels.add(key);
        reached.push(model);
      }
    }
  };

  let truncated = false;
  if (start) {
    const callsFrom = new Map<string, string[]>();
    for (const rel of graph.relations) {
      if (rel.kind === 'call')
        callsFrom.set(rel.from, [...(callsFrom.get(rel.from) ?? []), rel.to]);
    }
    const visited = new Set<string>([start]);
    let frontier = [start];
    for (let level = 1; level <= depth && frontier.length; level++) {
      const next: string[] = [];
      for (const id of frontier) {
        const symbol = symbols.get(id);
        if (!symbol) continue;
        if (steps.length >= MAX_STEPS) {
          truncated = true;
          break;
        }
        noteModels(symbol.path);
        steps.push({
          id,
          label: symbol.qualifiedName,
          path: symbol.path,
          line: symbol.line,
          layer: layerOf.get(symbol.path) ?? null,
          kind: modelsByFile.has(symbol.path) ? 'model' : 'call',
          depth: level,
        });
        for (const to of callsFrom.get(id) ?? []) {
          if (!visited.has(to)) {
            visited.add(to);
            next.push(to);
          }
        }
      }
      if (truncated) break;
      frontier = next;
    }
    if (frontier.length) truncated = true;
  } else if (route) {
    noteModels(route.path);
    for (const edge of graph.imports) {
      if (edge.from === route.path && edge.to) noteModels(edge.to);
    }
  }

  return { route, steps, models: reached, truncated, approximate: true };
}

export function findRoute(graph: ArchitectureGraph, query: string): GraphRoute | null {
  const match = /^([A-Z]+)\s+(\S+)$/.exec(query.trim());
  if (match) {
    const [, method = '', path = ''] = match;
    return graph.routes.find((r) => r.method === method && r.route === path) ?? null;
  }
  return graph.routes.find((r) => r.handler === query) ?? null;
}
