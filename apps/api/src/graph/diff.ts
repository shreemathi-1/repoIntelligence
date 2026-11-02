import type { ArchitectureGraph, GraphDiff } from '@repointelligence/shared';
import { moduleOf } from './views.js';

function changes<T>(before: Iterable<T>, after: Iterable<T>): { added: T[]; removed: T[] } {
  const a = new Set(before);
  const b = new Set(after);
  return {
    added: [...b].filter((x) => !a.has(x)).sort(),
    removed: [...a].filter((x) => !b.has(x)).sort(),
  };
}

/** Structural differences between two stored graphs of the same repository. */
export function diffGraphs(
  before: ArchitectureGraph,
  after: ArchitectureGraph,
  shas: { from: string; to: string },
): GraphDiff {
  const files = changes(
    before.files.map((f) => f.path),
    after.files.map((f) => f.path),
  );
  const modules = changes(
    before.files.map((f) => moduleOf(f.path)),
    after.files.map((f) => moduleOf(f.path)),
  );
  const importKey = (e: { from: string; to: string | null }) => `${e.from}>${e.to ?? ''}`;
  const imports = changes(
    before.imports.filter((e) => e.to).map(importKey),
    after.imports.filter((e) => e.to).map(importKey),
  );
  const split = (key: string) => {
    const [from = '', to = ''] = key.split('>');
    return { from, to };
  };
  const cycleKey = (c: string[]) => c.join('|');
  const beforeCycles = new Map(before.cycles.map((c) => [cycleKey(c), c] as const));
  const afterCycles = new Map(after.cycles.map((c) => [cycleKey(c), c] as const));
  const layersBefore = new Map(before.files.map((f) => [f.path, f.layer] as const));
  const layerChanges: GraphDiff['layerChanges'] = [];
  for (const file of after.files) {
    const previous = layersBefore.get(file.path);
    if (previous && previous !== file.layer)
      layerChanges.push({ path: file.path, from: previous, to: file.layer });
  }
  return {
    from: shas.from,
    to: shas.to,
    files,
    modules,
    imports: { added: imports.added.map(split), removed: imports.removed.map(split) },
    externals: changes(before.externals, after.externals),
    routes: changes(
      before.routes.map((r) => `${r.method} ${r.route}`),
      after.routes.map((r) => `${r.method} ${r.route}`),
    ),
    models: changes(
      before.models.map((m) => `${m.orm}:${m.name}`),
      after.models.map((m) => `${m.orm}:${m.name}`),
    ),
    cycles: {
      introduced: [...afterCycles.entries()]
        .filter(([k]) => !beforeCycles.has(k))
        .map(([, c]) => c),
      resolved: [...beforeCycles.entries()].filter(([k]) => !afterCycles.has(k)).map(([, c]) => c),
    },
    layerChanges,
    violations: { before: before.layerViolations.length, after: after.layerViolations.length },
    stats: { filesBefore: before.files.length, filesAfter: after.files.length },
  };
}
