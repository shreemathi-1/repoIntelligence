import type { ArchitectureGraph, GraphRoute, TraceResponse } from '@repointelligence/shared';
import { layersDiagram, mermaidId, modulesDiagram } from '../../graph/mermaid.js';
import { traceRoute } from '../../graph/trace.js';
import { around, cite, table, type Excerpt, type Facts } from '../facts.js';
import { section, type DocPlan, type PlannedSection } from '../plan.js';

const NO_GRAPH = 'map the architecture of this commit first';

export async function architectureDoc(facts: Facts): Promise<DocPlan> {
  const graph = facts.graph;
  if (!graph) {
    return { title: 'Architecture', sections: [section('overview', 'Overview', { missing: NO_GRAPH })], notes: [] };
  }
  const entry: Excerpt[] = [];
  for (const e of graph.entryPoints.filter((x) => x.line).slice(0, 3)) {
    const text = await facts.read(e.path);
    if (text && e.line) entry.push(around(e.path, text, e.line, 2, 15));
  }
  const layers = new Map<string, number>();
  for (const f of graph.files) layers.set(f.layer, (layers.get(f.layer) ?? 0) + 1);
  const sections: PlannedSection[] = [
    section('overview', 'Overview', {
      prose: 'Describe the overall structure: what runs where, the main parts and how a request or job flows through them, in one or two paragraphs.',
      evidence: entry,
      facts: `${graph.files.length} source files, ${graph.routes.length} HTTP routes, ${graph.models.length} data models (detected from source, not verified).`,
    }),
    section('stack', 'Technology', {
      facts: graph.stack.length ? table(['Name', 'Kind', 'Version', 'Evidence'], graph.stack.map((s) => [s.name, s.category, s.version ?? '', s.evidence])) : '',
      ...(graph.stack.length === 0 && { missing: 'no frameworks or libraries were recognised' }),
    }),
    section('layers', 'Layers', {
      facts: `${table(['Layer', 'Files'], [...layers.entries()].sort((a, b) => b[1] - a[1]).map(([l, n]) => [l, String(n)]))}\n\n\`\`\`mermaid\n${layersDiagram(graph)}\n\`\`\``,
    }),
    section('modules', 'Modules', { facts: `\`\`\`mermaid\n${modulesDiagram(graph)}\n\`\`\`` }),
    section('entry', 'Entry points', {
      facts: graph.entryPoints.slice(0, 12).map((e) => `- ${e.label} ${e.line ? cite({ path: e.path, startLine: e.line }) : `(\`${e.path}\`)`}`).join('\n'),
      ...(graph.entryPoints.length === 0 && { missing: 'no entry points were detected' }),
    }),
    section('risks', 'Structural issues', {
      facts: [
        ...graph.cycles.slice(0, 8).map((c) => `- Import cycle: ${c.map((p) => `\`${p}\``).join(' → ')}`),
        ...graph.layerViolations.slice(0, 8).map((v) => `- ${v.fromLayer} imports ${v.toLayer}: ${cite({ path: v.from, startLine: Math.max(1, v.line) })} → \`${v.to}\``),
      ].join('\n'),
      ...(graph.cycles.length + graph.layerViolations.length === 0 && { missing: 'no import cycles or layer violations were detected' }),
    }),
  ];
  return { title: 'Architecture', sections, notes: ['The structure is detected from source and is approximate.'] };
} // prettier-ignore

const label = (text: string) =>
  text
    .replace(/[;:#"<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);

/** A Mermaid sequence diagram for one traced route: client, then each file the call passes through. */
export function sequenceDiagram(trace: TraceResponse): string {
  const route = trace.route;
  if (!route) return '';
  const participants = new Map<string, string>([['client', 'Client']]);
  const id = (path: string) => {
    const key = `f_${mermaidId(path)}`;
    if (!participants.has(key)) participants.set(key, path.split('/').slice(-2).join('/'));
    return key;
  };
  const arrows: string[] = [];
  const stack: string[] = ['client'];
  for (const step of trace.steps) {
    const target = step.kind === 'model' ? `m_${mermaidId(step.label)}` : id(step.path);
    if (step.kind === 'model' && !participants.has(target))
      participants.set(target, `${label(step.label)} (data)`);
    const from = stack[Math.min(step.depth, stack.length - 1)] ?? 'client';
    const text = step.kind === 'route' ? `${route.method} ${route.route}` : label(step.label);
    arrows.push(`  ${from}->>${target}: ${text}`);
    stack.length = step.depth + 1;
    stack[step.depth + 1] = target;
  }
  const head = [...participants.entries()].map(([k, v]) => `  participant ${k} as ${label(v)}`);
  return ['sequenceDiagram', ...head, ...arrows, `  ${id(route.path)}-->>client: response`].join(
    '\n',
  );
}

function pickRoutes(graph: ArchitectureGraph, limit: number): GraphRoute[] {
  // Prefer different resources over many methods on one path.
  const byResource = new Map<string, GraphRoute>();
  for (const r of graph.routes) {
    const key = r.route.split('/').find(Boolean) ?? '/';
    if (!byResource.has(key)) byResource.set(key, r);
  }
  return [...byResource.values(), ...graph.routes].filter((r, i, all) => all.indexOf(r) === i).slice(0, limit);
} // prettier-ignore

export async function sequenceDoc(facts: Facts): Promise<DocPlan> {
  const graph = facts.graph;
  if (!graph) {
    return { title: 'Sequence diagrams', sections: [section('none', 'Requests', { missing: NO_GRAPH })], notes: [] };
  }
  const sections: PlannedSection[] = [];
  for (const route of pickRoutes(graph, 6)) {
    const trace = traceRoute(graph, `${route.method} ${route.route}`, 4);
    if (!trace.route) continue;
    const evidence: Excerpt[] = [];
    for (const step of trace.steps.filter((s) => s.line).slice(0, 3)) {
      const text = await facts.read(step.path);
      if (text && step.line) evidence.push(around(step.path, text, step.line, 1, 10));
    }
    const steps = trace.steps
      .filter((s) => s.line)
      .map((s) => `${'  '.repeat(s.depth)}- ${label(s.label)} ${cite({ path: s.path, startLine: s.line ?? 1 })}`);
    sections.push(
      section(`route-${sections.length}`, `\`${route.method} ${route.route}\``, {
        facts: `\`\`\`mermaid\n${sequenceDiagram(trace)}\n\`\`\`\n\n${steps.join('\n')}${trace.truncated ? '\n\n_The trace was cut short._' : ''}`,
        prose: 'In 2-3 sentences, describe what happens when this request arrives, following the steps.',
        evidence,
      }),
    );
  }
  if (sections.length === 0) sections.push(section('none', 'Requests', { missing: 'no HTTP routes were detected' }));
  return { title: 'Sequence diagrams', sections, notes: ['Traces follow name-resolved calls; dynamic dispatch is not visible.'] };
} // prettier-ignore
