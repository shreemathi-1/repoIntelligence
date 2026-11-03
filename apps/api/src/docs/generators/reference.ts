import { modelsDiagram } from '../../graph/mermaid.js';
import {
  around,
  chunkAt,
  cite,
  excerpt,
  lineOf,
  table,
  type Excerpt,
  type Facts,
} from '../facts.js';
import { section, type DocPlan, type PlannedSection } from '../plan.js';

const NO_GRAPH = 'map the architecture of this commit first; routes and models come from that map';

/** Where the code reads a variable, from the stored source chunks. */
function readsOf(facts: Facts, name: string, limit = 2): { path: string; line: number }[] {
  const re = new RegExp(`\\b${name.replace(/[^\w]/g, '')}\\b`);
  const out: { path: string; line: number }[] = [];
  for (const c of facts.data.chunks) {
    if (c.kind !== 'source' || out.length >= limit) continue;
    const at = lineOf(c.text, re);
    if (at !== null) out.push({ path: c.provenance.path, line: c.provenance.startLine + at - 1 });
  }
  return out;
}

export async function envDoc(facts: Facts): Promise<DocPlan> {
  const sections: PlannedSection[] = [];
  const evidence: Excerpt[] = [];
  for (const file of facts.data.envExamples) {
    const text = await facts.read(file.path);
    if (text) evidence.push(excerpt(file.path, text, 1, 60));
    const rows = file.vars.map((v) => {
      const reads = readsOf(facts, v.name);
      return [
        `\`${v.name}\``,
        v.description ?? '',
        v.hasDefault ? 'no' : 'yes',
        cite({ path: file.path, startLine: v.line }),
        reads.map((r) => cite({ path: r.path, startLine: r.line })).join(' ') || 'not found',
      ];
    });
    sections.push(
      section(`file-${sections.length}`, `Variables in ${file.path}`, {
        facts:
          rows.length > 0
            ? `${table(['Name', 'Purpose', 'Needs a value', 'Declared', 'Read in'], rows)}\n\n` +
              'Values are never shown here; copy the file and fill it in.'
            : '',
        ...(rows.length === 0 && { missing: 'the file lists no variables' }),
      }),
    );
  }
  const undocumented = facts.data.findings.filter((f) => f.rule === 'env-undocumented');
  if (undocumented.length > 0) {
    sections.push(
      section('undocumented', 'Read by the code but not documented', {
        facts: undocumented
          .map((f) => `- \`${f.evidence}\` ${cite({ path: f.path, startLine: f.line ?? 1 })}`)
          .join('\n'),
      }),
    );
    for (const f of undocumented.slice(0, 3)) {
      const chunk = chunkAt(facts.data.chunks, f.path, f.line ?? 1);
      if (chunk) evidence.push(chunk);
    }
  }
  const overview = section('overview', 'How configuration is loaded', {
    prose:
      'Explain how the application reads its configuration (which file or library loads it, ' +
      'validation, required vs optional) in 2-4 sentences.',
    evidence,
    ...(evidence.length === 0 && { missing: 'no .env example or configuration reads were found' }),
  });
  return { title: 'Configuration', sections: [overview, ...sections], notes: [] };
}

const normalise = (path: string) =>
  path.replace(/\{[^}]+\}|:[\w]+/g, '{}').replace(/\/+$/, '') || '/';

export async function apiDoc(facts: Facts): Promise<DocPlan> {
  const graph = facts.graph;
  const spec = facts.data.openApi[0] ?? null;
  const specText = spec ? await facts.read(spec.path) : null;
  const routes = graph?.routes ?? [];
  const rows: string[][] = [];
  const seen = new Set<string>();
  for (const r of routes) {
    const key = `${r.method} ${normalise(r.route)}`;
    seen.add(key);
    const op = spec?.endpoints.find(
      (e) => `${e.method.toUpperCase()} ${normalise(e.path)}` === key,
    );
    const specLine = op && specText ? lineOf(specText, `${op.path}:`) : null;
    rows.push([
      r.method,
      `\`${r.route}\``,
      op?.summary ?? r.handler ?? '',
      cite({ path: r.path, startLine: Math.max(1, r.line) }),
      spec && specLine
        ? cite({ path: spec.path, startLine: specLine })
        : op
          ? 'yes'
          : 'not in spec',
    ]);
  }
  for (const e of spec?.endpoints ?? []) {
    const key = `${e.method.toUpperCase()} ${normalise(e.path)}`;
    if (seen.has(key)) continue;
    const specLine = specText ? lineOf(specText, `${e.path}:`) : null;
    rows.push([
      e.method.toUpperCase(),
      `\`${e.path}\``,
      e.summary ?? e.operationId ?? '',
      'not found in code',
      spec && specLine ? cite({ path: spec.path, startLine: specLine }) : 'yes',
    ]);
  }

  const evidence: Excerpt[] = [];
  for (const r of routes.slice(0, 4)) {
    const text = await facts.read(r.path);
    if (text) evidence.push(around(r.path, text, Math.max(1, r.line), 1, 10));
  }
  const authEvidence: Excerpt[] = [];
  for (const a of (graph?.auth ?? []).slice(0, 3)) {
    const text = await facts.read(a.path);
    if (text && a.line) authEvidence.push(around(a.path, text, a.line, 2, 8));
  }

  const sections = [
    section('overview', 'Overview', {
      prose: 'Summarise what the API offers, its base path and response style, in 2-4 sentences.',
      evidence,
      ...(rows.length === 0 && {
        missing: graph ? 'no HTTP routes or OpenAPI spec were found' : NO_GRAPH,
      }),
    }),
    section('endpoints', 'Endpoints', {
      facts:
        rows.length > 0
          ? table(['Method', 'Path', 'Summary or handler', 'Defined in', 'Spec'], rows)
          : '',
    }),
    section('auth', 'Authentication', {
      facts: (graph?.auth ?? [])
        .slice(0, 10)
        .map(
          (a) =>
            `- ${a.label}: ${a.evidence} ${a.line ? cite({ path: a.path, startLine: a.line }) : ''}`,
        )
        .join('\n'),
      prose: 'Explain how requests are authenticated, based only on the material.',
      evidence: authEvidence,
      ...(graph?.auth.length === 0 && { missing: 'no authentication code was detected' }),
    }),
  ];
  return {
    title: 'API reference',
    sections,
    notes: graph ? [] : [`Routes need the architecture map: ${NO_GRAPH}.`],
  };
}

export async function databaseDoc(facts: Facts): Promise<DocPlan> {
  const graph = facts.graph;
  if (!graph) {
    return {
      title: 'Database schema',
      sections: [section('models', 'Models', { missing: NO_GRAPH })],
      notes: [],
    };
  }
  const models = graph.models;
  const sections: PlannedSection[] = [
    section('summary', 'Models and migrations', {
      facts:
        models.length > 0
          ? table(
              ['Name', 'Kind', 'Library', 'Defined in'],
              models.map((m) => [
                m.name,
                m.kind,
                m.orm,
                m.line ? cite({ path: m.path, startLine: m.line }) : `\`${m.path}\``,
              ]),
            )
          : '',
      ...(models.length === 0 && { missing: 'no data models or migrations were detected' }),
    }),
  ];
  if (models.some((m) => m.kind !== 'migration')) {
    sections.push(
      section('diagram', 'Diagram', { facts: `\`\`\`mermaid\n${modelsDiagram(graph)}\n\`\`\`` }),
    );
  }
  for (const m of models.filter((x) => x.kind !== 'migration' && x.line).slice(0, 8)) {
    const text = await facts.read(m.path);
    if (!text || !m.line) continue;
    sections.push(
      section(`model-${m.name}`, m.name, {
        facts: `Defined in ${cite({ path: m.path, startLine: m.line })}.`,
        prose:
          'List the fields with their types, required/optional, defaults, indexes and relations ' +
          'to other models, as a short Markdown list. Only what the code shows.',
        evidence: [around(m.path, text, m.line, 1, 30)],
      }),
    );
  }
  return { title: 'Database schema', sections, notes: [] };
}

const COMMENT_STYLE: Record<string, string> = {
  python: 'a Python docstring (triple quotes, Google style)',
  java: 'a Javadoc comment',
  typescript: 'a TSDoc comment',
  javascript: 'a JSDoc comment',
};

export async function docstringsDoc(facts: Facts): Promise<DocPlan> {
  const candidates = facts.data.symbols
    .filter((s) => s.exported && !s.doc && ['function', 'class', 'method'].includes(s.kind))
    .slice(0, 12);
  const sections: PlannedSection[] = [];
  for (const s of candidates) {
    const text = await facts.read(s.path);
    if (!text) continue;
    const end = Math.min(s.endLine, s.startLine + 40);
    sections.push(
      section(`symbol-${sections.length}`, `\`${s.qualifiedName}\``, {
        facts: `${s.kind} in ${cite({ path: s.path, startLine: s.startLine, endLine: end })}\n\n\`\`\`${s.language}\n${s.signature}\n\`\`\``,
        prose:
          `Suggest ${COMMENT_STYLE[s.language] ?? 'a doc comment'} for this ${s.kind}: purpose, ` +
          'parameters, return value and errors, based only on its code. Put the comment in a code block.',
        evidence: [excerpt(s.path, text, s.startLine, end)],
      }),
    );
  }
  const documented = facts.data.symbols.filter((s) => s.exported && s.doc).length;
  const exported = facts.data.symbols.filter((s) => s.exported).length;
  const notes =
    exported > 0
      ? [`${documented} of ${exported} exported symbols already have a doc comment.`]
      : [];
  if (sections.length === 0) {
    sections.push(
      section('none', 'Suggestions', {
        missing:
          exported === 0
            ? 'no exported functions or classes were found'
            : 'every exported function and class already has a doc comment',
      }),
    );
  }
  return { title: 'Docstring suggestions', sections, notes };
}
