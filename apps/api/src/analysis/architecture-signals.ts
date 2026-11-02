import { architectureGraphSchema } from '@repointelligence/shared';
import type { ArchitectureSignals } from './inputs.js';

/** Reduces a stored graph to the few numbers the architecture area scores. */
export function architectureSignalsOf(stored: unknown): ArchitectureSignals | null {
  const parsed = architectureGraphSchema.safeParse(stored);
  if (!parsed.success) return null;
  const graph = parsed.data;
  const fanIn = new Map<string, number>();
  let internal = 0;
  for (const edge of graph.imports) {
    if (!edge.to) continue;
    internal += 1;
    fanIn.set(edge.to, (fanIn.get(edge.to) ?? 0) + 1);
  }
  const top = Math.max(0, ...fanIn.values());
  const layered = graph.files.filter((f) => f.layer !== 'other').length;
  return {
    files: graph.files.length,
    cycles: graph.cycles.length,
    filesInCycles: new Set(graph.cycles.flat()).size,
    layerViolations: graph.layerViolations.length,
    internalImports: internal,
    topFanInShare: internal > 0 ? Math.round((top / internal) * 1000) / 1000 : null,
    layeredShare:
      graph.files.length > 0 ? Math.round((layered / graph.files.length) * 1000) / 1000 : 0,
  };
}
