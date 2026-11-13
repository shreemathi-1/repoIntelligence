import type {
  FileRef,
  Layer,
  LearningMode,
  Onboarding,
  StarterIssues,
} from '@repointelligence/shared';
import type { Detected } from '../adaptability/types.js';
import { lineOf, type Facts } from '../docs/facts.js';
import { installSteps } from '../docs/generators/guides.js';
import { moduleOf } from '../graph/views.js';
import { isReadmePath } from '../ingest/markdown.js';
import { isTestPath } from './pipeline.js';

type Built = Omit<Onboarding, 'checklist' | 'progress'>;

const ROLE: Record<Layer, string> = {
  presentation: 'request handlers and user interface',
  service: 'business logic',
  data: 'data models and persistence',
  integration: 'clients for external services',
  config: 'configuration',
  test: 'tests',
  other: 'supporting code',
};
const RUNTIME_NAMES = { node: 'Node.js', python: 'Python', java: 'Java', go: 'Go' } as const;
const READING = { beginner: 6, advanced: 10 } as const;
const slug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60); // prettier-ignore
/** Line numbers of 0 mean "unknown" in the graph. */
const lineOrNull = (line: number | null | undefined): number | null =>
  line !== null && line !== undefined && line > 0 ? line : null;
const ref = (path: string | null | undefined, line: number | null | undefined): FileRef | null =>
  path ? { path, line: line && line > 0 ? line : null } : null;

/** `[[path:12-12]]` as produced by the documentation helpers. */
function fromCitation(citation: string): FileRef | null {
  const m = /\[\[([^\]]+?):(\d+)/.exec(citation);
  return m?.[1] ? { path: m[1], line: Number(m[2]) } : null;
}

async function install(facts: Facts): Promise<Built['install']> {
  const steps: Built['install'] = installSteps(facts).map((s) => ({ id: `install-${slug(s.command)}`, command: s.command, why: s.why, source: fromCitation(s.source) })); // prettier-ignore
  const manifest = facts.data.manifests.find((m) => m.ecosystem === 'npm' && Object.keys(m.scripts).length > 0);
  if (manifest) {
    const text = await facts.read(manifest.path);
    const add = (names: string[], why: string) => {
      const name = names.find((n) => manifest.scripts[n] !== undefined);
      if (!name) return;
      steps.push({ id: `run-${name}`, command: `npm run ${name}`, why, source: ref(manifest.path, text ? lineOf(text, `"${name}"`) : null) });
    };
    add(['dev', 'start', 'serve'], 'start the project locally');
    add(['test'], 'run the tests to confirm the setup works');
  }
  return steps;
} // prettier-ignore

function prerequisites(detected: Detected, facts: Facts): Built['prerequisites'] {
  const { requirements, signals } = detected;
  const out: Built['prerequisites'] = [];
  for (const r of requirements.runtimes) {
    const e = r.evidence[0];
    out.push({ id: `runtime-${r.runtime}`, kind: 'runtime', label: `${RUNTIME_NAMES[r.runtime]}${r.range === '*' ? '' : ` ${r.range}`}`, detail: r.pinned ? 'The version the project is pinned to.' : r.range === '*' ? 'No version is declared; use a current release.' : 'The version range the project declares.', source: ref(e?.path, e?.line) });
  }
  if (signals.compose) out.push({ id: 'tool-compose', kind: 'tool', label: 'Docker with Compose', detail: 'The project defines its local services in a Compose file.', source: ref(signals.compose.path, signals.compose.line) });
  else if (signals.dockerfile) out.push({ id: 'tool-docker', kind: 'tool', label: 'Docker (optional)', detail: 'A Dockerfile is provided for building an image.', source: ref(signals.dockerfile.path, signals.dockerfile.line) });
  if (signals.nativePackages[0]) out.push({ id: 'tool-compiler', kind: 'tool', label: 'A C/C++ build toolchain', detail: 'Some dependencies compile native code when installed.', source: ref(signals.nativePackages[0].path, signals.nativePackages[0].line) });
  for (const s of requirements.services.filter((x) => x.kind !== 'saas')) {
    const e = s.evidence[0];
    out.push({ id: `service-${s.id}`, kind: 'service', label: `A running ${s.label}`, detail: 'The code connects to it; start one locally or point the settings at an existing one.', source: ref(e?.path, e?.line) });
  }
  for (const s of requirements.services.filter((x) => x.kind === 'saas')) {
    const e = s.evidence[0];
    out.push({ id: `service-${s.id}`, kind: 'service', label: `${s.label} credentials`, detail: 'Needed for the features that call it.', source: ref(e?.path, e?.line) });
  }
  const languages = facts.graph?.stack.filter((s) => s.category === 'language').map((s) => s.name) ?? [];
  for (const name of [...languages, ...requirements.frameworks.map((f) => f.name), ...requirements.database.orms]) {
    if (out.some((p) => p.id === `know-${slug(name)}`)) continue;
    const e = requirements.frameworks.find((f) => f.name === name)?.evidence[0];
    out.push({ id: `know-${slug(name)}`, kind: 'knowledge', label: `Working knowledge of ${name}`, detail: 'Used throughout the code base.', source: ref(e?.path, e?.line) });
  }
  return out;
} // prettier-ignore

function troubleshooting(detected: Detected, facts: Facts): Built['troubleshooting'] {
  const out: Built['troubleshooting'] = [];
  for (const r of detected.requirements.runtimes.filter((x) => x.range !== '*')) {
    const e = r.evidence[0];
    out.push({ id: `trouble-runtime-${r.runtime}`, symptom: `Installing or starting fails with syntax or engine errors.`, fix: `Check your ${RUNTIME_NAMES[r.runtime]} version; the project needs ${r.range}.`, source: ref(e?.path, e?.line) });
  }
  for (const v of detected.requirements.envVars.filter((x) => x.required).slice(0, 8)) {
    out.push({ id: `trouble-env-${slug(v.name)}`, symptom: `Startup fails or a feature does nothing because ${v.name} is empty.`, fix: `Set ${v.name}; the example file gives it no default.${v.description ? ` ${v.description}` : ''}`, source: ref(v.evidence.path, v.evidence.line) });
  }
  for (const f of facts.data.findings) {
    if (f.rule === 'doc-script-missing') out.push({ id: `trouble-script-${slug(f.evidence)}`, symptom: `\`${f.evidence}\` from the documentation fails with "missing script".`, fix: f.message, source: ref(f.path, f.line) });
    else if (f.rule === 'env-undocumented') out.push({ id: `trouble-undocumented-${slug(f.evidence)}`, symptom: `A feature fails because a setting is missing.`, fix: `${f.evidence} is read by the code but is not in the example settings; set it yourself.`, source: ref(f.path, f.line) });
  }
  for (const s of detected.requirements.services.filter((x) => x.kind !== 'saas')) {
    const e = s.evidence[0];
    out.push({ id: `trouble-service-${s.id}`, symptom: `Connection refused or timeout errors on startup.`, fix: `Make sure ${s.label} is running and its connection settings point at it.`, source: ref(e?.path, e?.line) });
  }
  if (detected.signals.nativePackages[0]) {
    const e = detected.signals.nativePackages[0];
    out.push({ id: 'trouble-native', symptom: 'Installing dependencies fails while compiling.', fix: 'Install a C/C++ build toolchain; some dependencies build native code.', source: ref(e.path, e.line) });
  }
  return out.filter((t, i) => out.findIndex((x) => x.id === t.id) === i).slice(0, 20);
} // prettier-ignore

function readingList(facts: Facts, mode: LearningMode): Built['readingList'] {
  const out: Built['readingList'] = [];
  const add = (path: string | undefined, line: number | null, reason: string) => {
    if (path && facts.paths.includes(path) && !out.some((r) => r.path === path)) out.push({ path, line, reason });
  };
  const graph = facts.graph;
  add(facts.paths.find((p) => isReadmePath(p) && !p.includes('/')), null, 'What the project is and how its authors describe using it.');
  if (mode === 'beginner') add(facts.paths.find((p) => /^CONTRIBUTING(\.md)?$/i.test(p)), null, 'How the maintainers expect changes to be made.');
  add(facts.data.manifests[0]?.path, null, 'The dependencies and the commands the project defines.');
  for (const e of graph?.entryPoints.slice(0, 2) ?? []) add(e.path, lineOrNull(e.line), 'Where execution starts.');
  const route = graph?.routes[0];
  if (route) add(route.path, lineOrNull(route.line), `Defines ${route.method} ${route.route}; a concrete request to follow end to end.`);
  const model = graph?.models.find((m) => m.kind !== 'migration');
  if (model) add(model.path, model.line, `Defines the ${model.name} data model.`);
  const central = [...(graph?.files ?? [])].filter((f) => !isTestPath(f.path) && f.importedBy > 0).sort((a, b) => b.importedBy - a.importedBy);
  for (const f of central) {
    if (out.length >= READING[mode]) break;
    add(f.path, null, `${f.importedBy} files import it, so much of the code depends on it.`);
  }
  return out.slice(0, READING[mode]);
} // prettier-ignore

function roadmap(facts: Facts, reading: Built['readingList'], mode: LearningMode): Built['roadmap'] {
  const graph = facts.graph;
  const sources = graph ? graph.files.filter((f) => !isTestPath(f.path)) : [];
  const count = graph ? sources.length : facts.paths.length;
  const modules = [...new Set(sources.map((f) => moduleOf(f.path)))];
  const complexity = count < 40 ? 'small' : count < 250 ? 'medium' : 'large';
  const basis = graph ? `${count} source files in ${modules.length} modules` : `${count} files (no architecture graph, so modules are unknown)`;
  const top = (n: number) => [...sources].sort((a, b) => b.importedBy - a.importedBy).slice(0, n).map((f) => f.path);
  const tests = facts.paths.filter(isTestPath).slice(0, 3);
  const docs = reading.filter((r) => /\.md$/i.test(r.path)).map((r) => r.path);
  const entry = graph?.entryPoints[0]?.path;
  const routeFiles = [...new Set(graph?.routes.map((r) => r.path))].slice(0, 3);
  const modelFiles = [...new Set(graph?.models.map((m) => m.path))].slice(0, 3);
  const authFiles = [...new Set(graph?.auth.map((a) => a.path))].slice(0, 3);
  const stage = (id: string, title: string, goal: string, files: (string | undefined)[]) => ({ id: `stage-${id}`, title, goal, files: [...new Set(files.filter((f): f is string => Boolean(f)))] });

  const stages =
    mode === 'beginner'
      ? [
          stage('run', 'Get it running', 'Install the dependencies and start the project once, before reading any code.', [facts.data.manifests[0]?.path, facts.data.envExamples[0]?.path]),
          stage('docs', 'Read what the authors wrote', 'Learn what the project is for and the words it uses.', docs),
          stage('request', 'Follow one request', 'Start at the entry point and trace a single route to the code that answers it.', [entry, ...routeFiles.slice(0, 1)]),
          stage('data', 'Understand the data', 'See what is stored and how the models relate.', modelFiles),
          ...(complexity === 'small' ? [] : modules.slice(0, complexity === 'large' ? 4 : 2).map((m) => stage(`module-${slug(m)}`, `Explore ${m}`, `Read the main files of the ${m} module.`, sources.filter((f) => moduleOf(f.path) === m).sort((a, b) => b.importedBy - a.importedBy).slice(0, 3).map((f) => f.path)))),
          stage('tests', 'Read and run a test', 'Tests show how the code is meant to be used.', tests),
          stage('change', 'Make a small change', 'Pick a starter issue and change one thing, with a test.', []),
        ]
      : [
          stage('architecture', 'Map the architecture', 'Identify the layers, their boundaries and where they are broken.', [entry, ...(graph?.cycles[0]?.slice(0, 2) ?? [])]),
          stage('hot-paths', 'Read the most depended-on code', 'Changes here ripple furthest.', top(5)),
          stage('interfaces', 'Review the public surface', 'The routes and their handlers define what callers rely on.', routeFiles),
          stage('data', 'Review data and integrations', 'Models, migrations and external clients constrain most changes.', modelFiles),
          stage('cross-cutting', 'Check cross-cutting concerns', 'Authentication, configuration and error handling apply everywhere.', [...authFiles, facts.data.envExamples[0]?.path]),
          stage('contribute', 'Check how changes ship', 'Tests, linting and CI decide what gets merged.', [...tests.slice(0, 2), ...facts.paths.filter((p) => p.startsWith('.github/workflows/')).slice(0, 1)]),
        ];
  return { complexity, basis, stages: stages.filter((s) => s.files.length > 0 || s.id === 'stage-change') };
} // prettier-ignore

/** The walkthrough, setup and learning path for one commit. Built from detected facts only. */
export async function buildOnboarding(facts: Facts, detected: Detected, mode: LearningMode): Promise<Built> {
  const graph = facts.graph;
  const groups = new Map<string, { files: number; layers: Map<Layer, number> }>();
  for (const f of graph?.files ?? []) {
    const g = groups.get(moduleOf(f.path)) ?? { files: 0, layers: new Map<Layer, number>() };
    g.files += 1;
    g.layers.set(f.layer, (g.layers.get(f.layer) ?? 0) + 1);
    groups.set(moduleOf(f.path), g);
  }
  const layout = [...groups.entries()].sort((a, b) => b[1].files - a[1].files).slice(0, 12).map(([path, g]) => {
    const dominant = [...g.layers.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'other';
    return { path, files: g.files, role: ROLE[dominant] };
  });
  const { requirements } = detected;
  const stack = [...requirements.runtimes.map((r) => RUNTIME_NAMES[r.runtime]), ...requirements.frameworks.map((f) => f.name), ...requirements.database.orms];
  const summary = [
    facts.repo.description ? `${facts.repo.fullName}: ${facts.repo.description}` : `${facts.repo.fullName} has no description on GitHub.`,
    ...(stack.length ? [`It is built with ${[...new Set(stack)].join(', ')}.`] : []),
    ...(graph ? [`The code has ${graph.files.length} parsed source files, ${graph.routes.length} routes and ${graph.models.filter((m) => m.kind !== 'migration').length} data models.`] : []),
    ...(requirements.auth.length ? [`Requests are authenticated with ${[...new Set(requirements.auth.map((a) => a.label))].join(', ')}.`] : []),
  ];
  const reading = readingList(facts, mode);
  return {
    fullName: facts.fullName,
    sha: facts.sha,
    mode,
    notes: graph ? [] : ['No architecture graph exists for this commit, so the layout, flows and reading order are limited. Build the architecture map for a fuller walkthrough.'],
    walkthrough: {
      summary,
      layout,
      entryPoints: (graph?.entryPoints ?? []).slice(0, 5).map((e) => ({ path: e.path, line: lineOrNull(e.line), label: e.label })),
      flows: (graph?.routes ?? []).filter((r) => r.method !== 'USE').slice(0, mode === 'beginner' ? 3 : 8).map((r) => ({ path: r.path, line: lineOrNull(r.line), title: `${r.method} ${r.route}`, handler: r.handler })),
    },
    prerequisites: prerequisites(detected, facts),
    install: await install(facts),
    troubleshooting: troubleshooting(detected, facts),
    readingList: reading,
    roadmap: roadmap(facts, reading, mode),
  };
} // prettier-ignore

/** One tickable list across setup, reading and the roadmap. Ids stay stable between visits. */
export function onboardingChecklist(built: Built, done: string[]): Pick<Onboarding, 'checklist' | 'progress'> {
  const items = [
    ...built.install.map((s) => ({ id: s.id, text: `Run \`${s.command}\`` })),
    ...built.readingList.map((r) => ({ id: `read-${r.path}`, text: `Read ${r.path}` })),
    ...built.roadmap.stages.map((s) => ({ id: s.id, text: s.title })),
  ];
  const checklist = items.map((i) => ({ ...i, done: done.includes(i.id) }));
  return { checklist, progress: { done: checklist.filter((c) => c.done).length, total: checklist.length } };
} // prettier-ignore

const TODO = /\b(TODO|FIXME)\b[:\s-]*(.{0,120})/;
const MAX_PER_KIND = 5;

/** Small, self-contained gaps a newcomer could close, found in the ingested files. */
export function starterCandidates(facts: Facts): StarterIssues['candidates'] {
  const out: StarterIssues['candidates'] = [];
  const of = (kind: StarterIssues['candidates'][number]['kind']) => out.filter((c) => c.kind === kind).length;

  const tested = new Set(facts.paths.filter(isTestPath).map((p) => (p.split('/').pop() ?? '').replace(/(\.test|\.spec|_test|Test)?\.[^.]+$/, '').replace(/^test_/, '')));
  for (const f of [...(facts.graph?.files ?? [])].sort((a, b) => a.lines - b.lines)) {
    if (of('missing-tests') >= MAX_PER_KIND) break;
    const stem = (f.path.split('/').pop() ?? '').replace(/\.[^.]+$/, '');
    if (isTestPath(f.path) || f.layer === 'config' || f.symbols === 0 || tested.has(stem) || stem === 'index') continue;
    out.push({ id: `tests-${f.path}`, kind: 'missing-tests', title: `Add tests for ${f.path}`, detail: `${f.lines} lines and ${f.symbols} symbols, with no test file named after it.`, path: f.path, line: null });
  }
  for (const s of facts.data.symbols) {
    if (of('undocumented') >= MAX_PER_KIND) break;
    if (!s.exported || s.doc || isTestPath(s.path) || !['function', 'class'].includes(s.kind)) continue;
    if (out.some((c) => c.kind === 'undocumented' && c.path === s.path)) continue;
    out.push({ id: `docs-${s.path}-${s.name}`, kind: 'undocumented', title: `Document ${s.name}`, detail: `The exported ${s.kind} \`${s.name}\` has no doc comment.`, path: s.path, line: s.startLine });
  }
  for (const c of facts.data.chunks) {
    if (of('todo') >= MAX_PER_KIND) break;
    if (c.kind !== 'source' && c.kind !== 'symbol') continue;
    const lines = c.text.split('\n');
    const at = lines.findIndex((l) => TODO.test(l));
    if (at === -1) continue;
    const line = c.provenance.startLine + at;
    if (out.some((x) => x.kind === 'todo' && x.path === c.provenance.path && x.line === line)) continue;
    const note = TODO.exec(lines[at] ?? '')?.[2]?.trim() ?? '';
    out.push({ id: `todo-${c.provenance.path}-${line}`, kind: 'todo', title: `Resolve a ${(lines[at] ?? '').includes('FIXME') ? 'FIXME' : 'TODO'} in ${c.provenance.path}`, detail: note === '' ? 'The comment has no description.' : note, path: c.provenance.path, line });
  }
  for (const f of facts.data.findings) {
    if (of('docs') >= MAX_PER_KIND) break;
    if (!['doc-script-missing', 'broken-link', 'env-undocumented'].includes(f.rule)) continue;
    out.push({ id: `finding-${f.rule}-${f.path}-${f.line ?? 0}`, kind: 'docs', title: `Fix the documentation in ${f.path}`, detail: f.message, path: f.path, line: f.line && f.line > 0 ? f.line : null });
  }
  return out;
} // prettier-ignore
